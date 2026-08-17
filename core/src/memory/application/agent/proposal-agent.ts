import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { MemoryEvidence, MemorySpaceId } from "../../domain/index.ts";
import type { MemoryProposalPorts } from "../memory-proposal-validation.ts";
import {
  previewProposal,
  type MemoryMessageRange,
  type MemoryProposalSubmission,
} from "../memory-proposal-preview.ts";
import {
  validateProposalOperation,
  validateProposalOperations,
} from "../memory-proposal-validation.ts";
import {
  abortedAgentRunSummary,
  convertAgentMessagesToLlm,
  runAgentWithTimeout,
  type AgentRunSummary,
  type RunHooks,
} from "./agent-run.ts";
import { buildMemorySpaceTableDigest } from "./digest.ts";
import type { LlmPort } from "./llm-port.ts";
import type { MemorySpaceReader } from "./memory-space-reader.ts";
import {
  composeProposalAgentSystemPrompt,
  type ComposedAgentMessage,
  type ProposalMessagesComposer,
  type ProposalSystemPromptComposer,
} from "./prompt-composer.ts";
import { createProposalPreviewTool } from "./tools/proposal/proposal-preview-tool.ts";
import { ProposalState } from "./tools/proposal/proposal-state.ts";
import { createDropMutateTool } from "./tools/proposal/drop-mutate-tool.ts";
import { createMutateTool } from "./tools/proposal/mutate-tool.ts";
import { createSubmitProposalTool } from "./tools/proposal/submit-proposal-tool.ts";
import { createQueryRecordsTool } from "./tools/query/query-records-tool.ts";

/** 单次 run 的总超时：5 分钟（对齐 QueryAgent）。 */
export const DEFAULT_PROPOSAL_AGENT_TIMEOUT_MS = 5 * 60 * 1000;

export interface ProposalAgentOptions {
  readonly llm: LlmPort;
  /** 记忆空间只读端口（表/字段列表 + 记录查询），由宿主装配。 */
  readonly reader: MemorySpaceReader;
  /** 提案校验/预览所需的领域访问端口（与提交 13 共用同一组 repository）。 */
  readonly ports: MemoryProposalPorts;
  /** 系统提示词组合器：默认后台填表指令；交互式宿主可注入自定义组合器（如交互式填写）。 */
  readonly composeSystemPrompt?: ProposalSystemPromptComposer;
  /**
   * 消息组合器（消息编排）：digest → 编排消息列表，system 合并进系统提示词、
   * user/assistant 进入对话前缀（本轮消息之前）。提供时取代 composeSystemPrompt
   * （两者互斥，消息组合器优先）。
   */
  readonly composeMessages?: ProposalMessagesComposer;
  /** 单次 run 总超时（毫秒），默认 5 分钟。 */
  readonly timeoutMs?: number;
}

export interface ProposalAgentRunInput {
  readonly memorySpaceId: MemorySpaceId;
  /** 本轮消息（含外部注入的处理块消息内容），至少一条用户消息。 */
  readonly messages: readonly AgentMessage[];
  /** 外部传入的处理块消息范围（闭区间），随提案返回。 */
  readonly messageRange: MemoryMessageRange;
  /** 外部传入的处理块整批证据，随提案返回。 */
  readonly evidence: readonly MemoryEvidence[];
}

export interface ProposalAgentRunResult extends AgentRunSummary {
  /** submit_proposal 成功冻结的提案；模型自然停止（无提交）时为 undefined，State 丢弃。 */
  readonly proposal: MemoryProposalSubmission | undefined;
}

/** 编排消息里 system 角色的文本按顺序合并为系统提示词（空行分隔）。 */
function systemTextOf(composed: readonly ComposedAgentMessage[]): string {
  return composed
    .filter((message) => message.role === "system")
    .map((message) => message.text)
    .join("\n\n");
}

/** 零用量占位：编排 assistant 消息的元数据不被 LLM 循环使用（convertToLlm 只按角色过滤）。 */
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

/** 编排消息 → pi AgentMessage（初始 transcript）：user / assistant 两种角色。 */
function toAgentPrefixMessages(
  composed: readonly ComposedAgentMessage[],
  model: string,
): AgentMessage[] {
  const timestamp = Date.now();
  return composed.map((message) =>
    message.role === "user"
      ? { role: "user", content: [{ type: "text", text: message.text }], timestamp }
      : {
          role: "assistant",
          content: [{ type: "text", text: message.text }],
          // 元数据占位：预设 assistant 消息是编排文本，不来自真实生成（同 query-chat 先例）
          api: "agent-preset",
          provider: "ste-memory",
          model,
          usage: ZERO_USAGE,
          stopReason: "stop",
          timestamp,
        },
  );
}

/**
 * ProposalAgent：增量构建跨表提案的 Agent。
 *
 * - 工具集：query_records（只读）+ mutate / proposal_preview / drop_mutate / submit_proposal；
 * - 每请求一个 Agent 实例与一个提案 State（submit 成功即冻结，模型自然停止 = 无提案）；
 * - 校验/预览复用 memory 层实现（与提交 13 共用领域规则），本模块只做编排；
 * - MemorySpaceTableDigest 每次 run 构建一次，提示词与工具校验共用。
 */
export class ProposalAgent {
  readonly #llm: LlmPort;
  readonly #reader: MemorySpaceReader;
  readonly #ports: MemoryProposalPorts;
  readonly #composeSystemPrompt: ProposalSystemPromptComposer;
  readonly #composeMessages: ProposalMessagesComposer | undefined;
  readonly #timeoutMs: number;

  constructor(options: ProposalAgentOptions) {
    this.#llm = options.llm;
    this.#reader = options.reader;
    this.#ports = options.ports;
    this.#composeSystemPrompt = options.composeSystemPrompt ?? composeProposalAgentSystemPrompt;
    this.#composeMessages = options.composeMessages;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_PROPOSAL_AGENT_TIMEOUT_MS;
  }

  async run(input: ProposalAgentRunInput, hooks: RunHooks = {}): Promise<ProposalAgentRunResult> {
    if (input.messages.length > 0 && input.messages[0]!.role !== "user") {
      throw new Error("ProposalAgent.run 的第一条消息必须是用户消息");
    }
    if (hooks.signal?.aborted) {
      return { ...abortedAgentRunSummary("run 启动前调用方已取消"), proposal: undefined };
    }

    const { memorySpaceId } = input;
    const digest = await buildMemorySpaceTableDigest(this.#reader, memorySpaceId);
    // 消息编排：提供 composeMessages 时——system 角色合并进系统提示词（每次请求
    // 置于最前），user/assistant 进入对话前缀（初始 transcript，run 的本轮消息之前）；
    // 未提供时退回到 composeSystemPrompt（字符串组合器，旧行为）。
    const composed = this.#composeMessages ? this.#composeMessages(digest) : undefined;
    const prefix = composed
      ? composed.filter(
          (message): message is ComposedAgentMessage & { role: "user" | "assistant" } =>
            message.role !== "system",
        )
      : [];
    const combined = [...prefix, ...input.messages];
    if (combined.length === 0) {
      throw new Error("ProposalAgent.run 需要至少一条消息（本轮消息或编排消息）");
    }
    if (combined[combined.length - 1]!.role !== "user") {
      throw new Error(
        "ProposalAgent.run 的对话最后一条消息必须是用户消息（检查编排消息的角色顺序）",
      );
    }
    const state = new ProposalState();
    const validateOperation = (operation: Parameters<typeof validateProposalOperation>[2]) =>
      validateProposalOperation(this.#ports, memorySpaceId, operation);
    const validateOperations = (operations: Parameters<typeof validateProposalOperations>[2]) =>
      validateProposalOperations(this.#ports, memorySpaceId, operations);
    const preview = (operations: Parameters<typeof previewProposal>[2]) =>
      previewProposal(this.#ports, memorySpaceId, operations);

    const agent = new Agent({
      initialState: {
        systemPrompt: composed ? systemTextOf(composed) : this.#composeSystemPrompt(digest),
        // 编排消息作为初始 transcript：run 的本轮消息（prompt）追加在其后。
        messages: toAgentPrefixMessages(prefix, this.#llm.model.id),
        model: this.#llm.model,
        tools: [
          createQueryRecordsTool({ reader: this.#reader, digest }),
          createMutateTool({ digest, state, validateOperation }),
          createProposalPreviewTool({ digest, state, validateOperations, preview }),
          createDropMutateTool({ state }),
          createSubmitProposalTool({
            digest,
            state,
            validateOperations,
            preview,
            messageRange: input.messageRange,
            evidence: input.evidence,
          }),
        ],
      },
      streamFn: this.#llm.streamFn,
      getApiKey: this.#llm.getApiKey,
      convertToLlm: convertAgentMessagesToLlm,
    });

    const summary = await runAgentWithTimeout(agent, input.messages, hooks, this.#timeoutMs);
    return { ...summary, proposal: state.frozenProposal };
  }
}
