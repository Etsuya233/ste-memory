import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  MemoryEvidence,
  MemoryMessageRange,
  MemoryProposalPorts,
  MemoryProposalSubmission,
  MemorySpaceId,
} from "../memory/index.ts";
import {
  previewProposal,
  validateProposalOperation,
  validateProposalOperations,
} from "../memory/index.ts";
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
import { composeProposalAgentSystemPrompt } from "./prompt-composer.ts";
import { createProposalPreviewTool } from "./proposal-preview-tool.ts";
import { ProposalState } from "./proposal-state.ts";
import { createDropMutateTool } from "./drop-mutate-tool.ts";
import { createMutateTool } from "./mutate-tool.ts";
import { createSubmitProposalTool } from "./submit-proposal-tool.ts";
import { createQueryRecordsTool } from "./query-records-tool.ts";

/** 单次 run 的总超时：5 分钟（对齐 QueryAgent）。 */
export const DEFAULT_PROPOSAL_AGENT_TIMEOUT_MS = 5 * 60 * 1000;

export interface ProposalAgentOptions {
  readonly llm: LlmPort;
  /** 记忆空间只读端口（表/字段列表 + 记录查询），由宿主装配。 */
  readonly reader: MemorySpaceReader;
  /** 提案校验/预览所需的领域访问端口（与提交 13 共用同一组 repository）。 */
  readonly ports: MemoryProposalPorts;
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
  readonly #timeoutMs: number;

  constructor(options: ProposalAgentOptions) {
    this.#llm = options.llm;
    this.#reader = options.reader;
    this.#ports = options.ports;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_PROPOSAL_AGENT_TIMEOUT_MS;
  }

  async run(input: ProposalAgentRunInput, hooks: RunHooks = {}): Promise<ProposalAgentRunResult> {
    if (input.messages.length === 0) {
      throw new Error("ProposalAgent.run 需要至少一条消息");
    }
    if (input.messages[0]!.role !== "user") {
      throw new Error("ProposalAgent.run 的第一条消息必须是用户消息");
    }
    if (hooks.signal?.aborted) {
      return { ...abortedAgentRunSummary("run 启动前调用方已取消"), proposal: undefined };
    }

    const { memorySpaceId } = input;
    const digest = await buildMemorySpaceTableDigest(this.#reader, memorySpaceId);
    const state = new ProposalState();
    const validateOperation = (operation: Parameters<typeof validateProposalOperation>[2]) =>
      validateProposalOperation(this.#ports, memorySpaceId, operation);
    const validateOperations = (operations: Parameters<typeof validateProposalOperations>[2]) =>
      validateProposalOperations(this.#ports, memorySpaceId, operations);
    const preview = (operations: Parameters<typeof previewProposal>[2]) =>
      previewProposal(this.#ports, memorySpaceId, operations);

    const agent = new Agent({
      initialState: {
        systemPrompt: composeProposalAgentSystemPrompt(digest),
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
