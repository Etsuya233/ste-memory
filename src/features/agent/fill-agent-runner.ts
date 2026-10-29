/**
 * FillAgentRunner：提案 Agent 组装模块（ADR 0024 落地，spec:
 * `.scratch/agent-app-assembly/spec.md`）。
 *
 * 填表任务与问答面板填写模式共用的 Agent 运行入口：接收调用方已展开的编排
 * 消息（ComposedAgentMessage[]）+ 本轮消息 + digest + 证据 + 消息范围，
 * 装配 5 个提案工具并跑通完整 Agent 循环。Agent 功能只提供零件（工具工厂、
 * ProposalState、校验闭包、run 基础设施、prompt 文本），编排权在调用方：
 *
 * - 编排：system 角色按顺序合并进系统提示词（空行分隔），user/assistant
 *   进入初始 transcript（run 的本轮消息之前）；
 * - 守卫：仅「组合后至少一条消息」抛错，不设「第一条/最后一条必须 user」
 *   守卫（assistant 结尾的预设直接进入 run）；
 * - 装配：后台每 run 新建 State，交互助手接收会话 State；装配校验闭包 + 5 个工具工厂
 *   （query_records / mutate / proposal_preview / drop_mutate / submit_proposal）；
 * - digest 由调用方传入（ST 块循环构建一次，同时喂消息展开与工具装配），
 *   本模块不内置 digest 构建；
 * - run：runAgentWithTimeout（超时/取消语义沿用 Memory）；结果形状对齐
 *   （含冻结提案），proposal 取 `state.frozenProposal`。
 */
import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { StopReason, RetryPolicy, RetryCallbacks } from "@earendil-works/pi-ai";
import { runFillAgentWithRetry } from "./fill-agent-retry.ts";
import {
  previewProposal,
  validateProposalOperation,
  validateProposalOperations,
  type MemoryEvidence,
  type MemoryMessageRange,
  type MemoryProposalPorts,
  type MemoryProposalSubmission,
  type MemorySpaceId,
  type MemorySpaceReader,
  type MemoryRecordService,
} from "../memory/index.ts";
import {
  abortedAgentRunSummary,
  convertAgentMessagesToLlm,
  createDropMutateTool,
  createMutateTool,
  createProposalPreviewTool,
  createQueryRecordsTool,
  createSubmitProposalTool,
  ProposalState,
  compileProposalOperations,
  runAgentWithTimeout,
  type ComposedAgentMessage,
  type LlmPort,
  type MemorySpaceTableDigest,
} from "./index.ts";
import { createTaskMutationTools } from "./task-mutation-tools.ts";
import { createSemanticQuerySqlTool, optionalQuerySqlTools } from "./tools/query/query-sql-tool.ts";
import type { SemanticQueryExecutor } from "../semantic-query/semantic-query-session.ts";

export interface FillAgentRunInput {
  readonly state?: ProposalState;
  readonly history?: readonly AgentMessage[];
  readonly semanticQuery?: SemanticQueryExecutor;
  /** 交互助手只准备提案，由界面确认后提交。 */
  readonly confirmationRequired?: boolean;
  readonly retryPolicy?: RetryPolicy;
  readonly retryCallbacks?: RetryCallbacks;
  /** 填表任务即时写入；交互问答省略此端口，保持确认后提交。 */
  readonly taskWriter?: Pick<MemoryRecordService, "commitProposal">;
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
export function systemTextOf(composed: readonly ComposedAgentMessage[]): string {
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
          // 元数据占位：预设 assistant 消息是编排文本，不来自真实生成
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
 * 提案 run 的结果（含冻结提案）。
 *
 * 守卫只有「组合后至少一条消息」（编排前缀 + 本轮消息）；编排消息为空且
 * 本轮消息为空时抛错，其余角色顺序自由。
 */
export async function runFillAgent(input: FillAgentRunInput): Promise<FillAgentRunResult> {
  if (input.signal?.aborted) {
    return { ...abortedAgentRunSummary("run 启动前调用方已取消"), proposal: undefined };
  }

  const {
    llm,
    reader,
    ports,
    memorySpaceId,
    digest,
    composedMessages,
    messages,
    messageRange,
    evidence,
  } = input;
  // 编排：system 已合并进系统提示词；user/assistant 作为对话前缀（run 消息之前）。
  const prefix = composedMessages.filter(
    (message): message is ComposedAgentMessage & { role: "user" | "assistant" } =>
      message.role !== "system",
  );
  const combined = [...prefix, ...messages];
  if (combined.length === 0) {
    throw new Error("runFillAgent 需要至少一条消息（本轮消息或编排消息）");
  }

  // 后台填表使用运行级 State，交互助手由会话持有 State。
  const state = input.state ?? new ProposalState();
  const validateOperation = (operation: Parameters<typeof validateProposalOperation>[2]) =>
    validateProposalOperation(ports, memorySpaceId, operation);
  const validateOperations = (operations: Parameters<typeof validateProposalOperations>[2]) =>
    validateProposalOperations(ports, memorySpaceId, operations);
  const preview = (operations: Parameters<typeof previewProposal>[2]) =>
    previewProposal(ports, memorySpaceId, operations);

  const taskTools =
    input.taskWriter === undefined
      ? undefined
      : createTaskMutationTools({
          digest,
          ports,
          memorySpaceId,
          messageRange,
          evidence,
          writer: input.taskWriter,
          signal: input.signal,
        });
  const sqlTools = input.semanticQuery
    ? [await createSemanticQuerySqlTool({ reader, digest, query: input.semanticQuery })]
    : optionalQuerySqlTools(reader, digest);
  const submitTool = createSubmitProposalTool({
    digest,
    state,
    validateOperations,
    preview,
    messageRange,
    evidence,
  });
  const agent = new Agent({
    initialState: {
      systemPrompt:
        systemTextOf(composedMessages) +
        (input.taskWriter === undefined
          ? ""
          : "\n\n当前为事务填表模式：mutate 成功后已写入本任务事务，query_records 可立即读取。create 返回真实 recordId，引用必须使用真实 ID；update/delete 前查询最新 revisionId。没有 proposal_preview 和 drop_mutate；修正已写入数据请再次 mutate。全部操作完成后调用 submit_proposal 并结束。正式提交由宿主在整个任务结束后完成。"),
      // 编排消息作为初始 transcript：run 的本轮消息（prompt）追加在其后。
      messages: [...toAgentPrefixMessages(prefix, llm.model.id), ...(input.history ?? [])],
      model: llm.model,
      tools:
        input.taskWriter === undefined
          ? [
              createQueryRecordsTool({ reader, digest }),
              ...sqlTools,
              createMutateTool({ digest, state, validateOperation }),
              createProposalPreviewTool({ digest, state, validateOperations, preview }),
              createDropMutateTool({ state }),
              input.confirmationRequired
                ? {
                    ...submitTool,
                    description:
                      "准备当前提案供用户确认，不写入数据库。调用后说明变更并结束回答，用户通过界面的确认提交按钮完成写入。",
                    async execute() {
                      const errors = await validateOperations(
                        compileProposalOperations(digest, state),
                      );
                      if (errors.length)
                        throw new Error(errors.map((error) => error.message).join("；"));
                      if (!state.operations.length) throw new Error("提案为空，无需提交");
                      const details = {
                        status: "awaiting_confirmation",
                        version: state.snapshot().version,
                      };
                      return {
                        content: [{ type: "text" as const, text: JSON.stringify(details) }],
                        details,
                      };
                    },
                  }
                : submitTool,
            ]
          : [
              createQueryRecordsTool({ reader, digest }),
              ...optionalQuerySqlTools(reader, digest),
              ...taskTools!.tools,
            ],
    },
    streamFn: llm.streamFn,
    getApiKey: llm.getApiKey,
    convertToLlm: convertAgentMessagesToLlm,
  });

  const summary = input.retryPolicy
    ? await runFillAgentWithRetry(
        agent,
        messages,
        { signal: input.signal, onEvent: input.onEvent },
        input.timeoutMs,
        input.retryPolicy,
        input.retryCallbacks,
      )
    : await runAgentWithTimeout(
        agent,
        messages,
        { signal: input.signal, onEvent: input.onEvent },
        input.timeoutMs,
      );
  if (summary.errorMessage === undefined && summary.stopReason !== "aborted")
    taskTools?.assertCompleted();
  return { ...summary, proposal: state.frozenProposal };
}
