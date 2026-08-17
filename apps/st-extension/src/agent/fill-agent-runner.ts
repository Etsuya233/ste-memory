/**
 * FillAgentRunner：ST 层提案 Agent 组装模块（ADR 0024 落地，spec:
 * `.scratch/agent-app-assembly/spec.md`）。
 *
 * 填表任务与问答面板填写模式共用的 Agent 运行入口：接收调用方已展开的编排
 * 消息（ComposedAgentMessage[]）+ 本轮消息 + digest + 证据 + 消息范围，
 * 装配 5 个提案工具并跑通完整 Agent 循环。core 只提供零件（工具工厂、
 * ProposalState、校验闭包、run 基础设施、prompt 文本），编排权完全在 ST：
 *
 * - 编排：system 角色按顺序合并进系统提示词（空行分隔），user/assistant
 *   进入初始 transcript（run 的本轮消息之前）——与 core `ProposalAgent`
 *   的编排语义对齐，由本模块自实现（core 不导出装配方法）；
 * - 守卫：仅「组合后至少一条消息」抛错，不复制 core ProposalAgent 的
 *   「第一条/最后一条必须 user」守卫（assistant 结尾的预设直接进入 run）；
 * - 装配：每 run 新建一个 ProposalState + 校验闭包 + 5 个工具工厂
 *   （query_records / mutate / proposal_preview / drop_mutate / submit_proposal）；
 * - digest 由调用方传入（ST 块循环构建一次，同时喂消息展开与工具装配），
 *   本模块不内置 digest 构建；
 * - run：runAgentWithTimeout（超时/取消语义沿用 core）；结果形状对齐
 *   `ProposalAgentRunResult`，proposal 取 `state.frozenProposal`。
 */
import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { StopReason } from "@earendil-works/pi-ai";
import {
  previewProposal,
  validateProposalOperation,
  validateProposalOperations,
  type MemoryEvidence,
  type MemoryMessageRange,
  type MemoryProposalPorts,
  type MemoryProposalSubmission,
  type MemorySpaceId,
} from "@ste-memory/core/memory";
import {
  abortedAgentRunSummary,
  convertAgentMessagesToLlm,
  createDropMutateTool,
  createMutateTool,
  createProposalPreviewTool,
  createQueryRecordsTool,
  createSubmitProposalTool,
  ProposalState,
  runAgentWithTimeout,
  type ComposedAgentMessage,
  type LlmPort,
  type MemorySpaceReader,
  type MemorySpaceTableDigest,
} from "@ste-memory/core/memory/agent";

export interface FillAgentRunInput {
  readonly llm: LlmPort;
  /** 记忆空间只读端口（query_records 工具用），由宿主装配。 */
  readonly reader: MemorySpaceReader;
  /** 提案校验/预览所需的领域访问端口（与提交共用同一组 repository）。 */
  readonly ports: MemoryProposalPorts;
  readonly memorySpaceId: MemorySpaceId;
  /** run 启动时构建一次的启用表/字段摘要（ST 块循环构建，消息展开与工具装配共用）。 */
  readonly digest: MemorySpaceTableDigest;
  /** 编排消息（ST 已展开）：system 合并进系统提示词，user/assistant 进前缀。 */
  readonly composedMessages: readonly ComposedAgentMessage[];
  /** 本轮消息（块提示词 / 用户对话），可为空（{{msg}} 接管场景）。 */
  readonly messages: readonly AgentMessage[];
  /** 外部传入的处理块消息范围（闭区间），随提案返回。 */
  readonly messageRange: MemoryMessageRange;
  /** 外部传入的处理块整批证据，随提案返回。 */
  readonly evidence: readonly MemoryEvidence[];
  /** 单次 run 总超时（毫秒）；超时以 stopReason "aborted" 收尾，不抛异常。 */
  readonly timeoutMs: number;
  /** 调用方取消信号（如 SSE 客户端断开）；中止以 stopReason "aborted" 收尾。 */
  readonly signal?: AbortSignal;
  /** 转发 Agent 生命周期事件，供宿主翻译为聊天事件/SSE。 */
  readonly onEvent?: (event: AgentEvent) => void;
}

export interface FillAgentRunResult {
  /** run 结束后的完整对话记录（agent_end 事件内容）。 */
  readonly messages: readonly AgentMessage[];
  /** 最后一次助手消息的 stopReason；未产生助手消息时为 undefined。 */
  readonly stopReason: StopReason | undefined;
  /** 失败/中止时最后一次助手消息的 errorMessage。 */
  readonly errorMessage: string | undefined;
  /** 最后一次助手消息的纯文本回答。 */
  readonly answer: string;
  /** submit_proposal 成功冻结的提案；模型自然停止（无提交）时为 undefined。 */
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
  composed: readonly (ComposedAgentMessage & { role: "user" | "assistant" })[],
  model: string,
): AgentMessage[] {
  const timestamp = Date.now();
  return composed.map((message) =>
    message.role === "user"
      ? { role: "user", content: [{ type: "text", text: message.text }], timestamp }
      : {
          role: "assistant",
          content: [{ type: "text", text: message.text }],
          // 元数据占位：预设 assistant 消息是编排文本，不来自真实生成（同 core 先例）
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
 * 跑一次提案 Agent run：装配 5 个工具 + 完整 Agent 循环，返回对齐
 * `ProposalAgentRunResult` 的结果（含冻结提案）。
 *
 * 守卫只有「组合后至少一条消息」（编排前缀 + 本轮消息）；编排消息为空且
 * 本轮消息为空时抛错，其余角色顺序自由。
 */
export async function runFillAgent(input: FillAgentRunInput): Promise<FillAgentRunResult> {
  if (input.signal?.aborted) {
    return { ...abortedAgentRunSummary("run 启动前调用方已取消"), proposal: undefined };
  }

  const { llm, reader, ports, memorySpaceId, digest, composedMessages, messages, messageRange, evidence } =
    input;
  // 编排：system 已合并进系统提示词；user/assistant 作为对话前缀（run 消息之前）。
  const prefix = composedMessages.filter(
    (message): message is ComposedAgentMessage & { role: "user" | "assistant" } =>
      message.role !== "system",
  );
  const combined = [...prefix, ...messages];
  if (combined.length === 0) {
    throw new Error("runFillAgent 需要至少一条消息（本轮消息或编排消息）");
  }

  // 装配：每 run 新建一个提案 State 与校验闭包（与 core ProposalAgent 同一套零件）。
  const state = new ProposalState();
  const validateOperation = (operation: Parameters<typeof validateProposalOperation>[2]) =>
    validateProposalOperation(ports, memorySpaceId, operation);
  const validateOperations = (operations: Parameters<typeof validateProposalOperations>[2]) =>
    validateProposalOperations(ports, memorySpaceId, operations);
  const preview = (operations: Parameters<typeof previewProposal>[2]) =>
    previewProposal(ports, memorySpaceId, operations);

  const agent = new Agent({
    initialState: {
      systemPrompt: systemTextOf(composedMessages),
      // 编排消息作为初始 transcript：run 的本轮消息（prompt）追加在其后。
      messages: toAgentPrefixMessages(prefix, llm.model.id),
      model: llm.model,
      tools: [
        createQueryRecordsTool({ reader, digest }),
        createMutateTool({ digest, state, validateOperation }),
        createProposalPreviewTool({ digest, state, validateOperations, preview }),
        createDropMutateTool({ state }),
        createSubmitProposalTool({
          digest,
          state,
          validateOperations,
          preview,
          messageRange,
          evidence,
        }),
      ],
    },
    streamFn: llm.streamFn,
    getApiKey: llm.getApiKey,
    convertToLlm: convertAgentMessagesToLlm,
  });

  const summary = await runAgentWithTimeout(
    agent,
    messages,
    { signal: input.signal, onEvent: input.onEvent },
    input.timeoutMs,
  );
  return { ...summary, proposal: state.frozenProposal };
}
