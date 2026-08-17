/**
 * QueryChatService：问答面板（ticket 20 / ADR 0009）的 run 编排（浏览器侧）。
 *
 * 分层对齐 apps/api DefaultChatManager（11.5）：本模块只做编排（Agent 装配 →
 * 事件翻译 → 终态 → 填写提交与空间校验），不感知 HTTP/SSE 与厂商协议（LLM
 * 经注入的 LlmPort，宿主以 includeReasoning: true 构造，ticket 19）。
 *
 * - 查询模式：QueryAgent 只读问答（core 固定提示词 composeQueryAgentSystemPrompt）；
 *   多轮历史由客户端回传（user/assistant 文本），工具结果与思考不跨轮；
 * - 填写模式：共享组装模块 runFillAgent（src/agent，ADR 0024）+
 *   composeInteractiveProposalAgentSystemPrompt（prompt 软闸门：Agent 陈述变更
 *   并征得用户明确同意后提交）；run 结束后冻结提案直通 repository
 *   （revisionSource "agent"，core 修订校验兜底并发），不经活动任务守卫（web 决策 8/10）；
 * - 空间切换守卫（决策 7）：提交前校验当前绑定空间 == run 起始空间，不一致
 *   放弃提案（abandoned，提示「对话已切换，变更未提交」）；查询模式继续跑完；
 * - 取消：AbortController；适配器以 stopReason "aborted" 收尾，本模块翻译为
 *   「已取消」；总超时 5 分钟（core 默认），超时按同一路径翻译；
 * - 契约：一切失败（LLM 网络/鉴权/超时/取消、digest 失败、提交失败）都以
 *   QueryChatEvent 的 error/done 终态编码，绝不抛异常（对齐 StreamFn 契约精神）。
 */
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { StopReason } from "@earendil-works/pi-ai";
import type {
  MemoryProposalPorts,
  MemoryProposalSubmission,
  MemoryRecordMutationContext,
  MemorySpaceId,
} from "@ste-memory/core/memory";
import { commitMemoryProposalBatch } from "@ste-memory/core/memory";
import {
  QueryAgent,
  buildMemorySpaceTableDigest,
  composeInteractiveProposalAgentSystemPrompt,
  type ComposedAgentMessage,
  type LlmPort,
  type MemorySpaceReader,
} from "@ste-memory/core/memory/agent";
import { runFillAgent } from "../agent/fill-agent-runner.ts";
import {
  errorMessage,
  type QueryChatCommitResult,
  type QueryChatEvent,
  type QueryChatHistoryMessage,
  type QueryChatMode,
} from "./query-chat-state.ts";

/** 单次 run 总超时（对齐 QueryAgent/ProposalAgent core 默认 5 分钟）。 */
export const QUERY_CHAT_TIMEOUT_MS = 5 * 60 * 1000;

/** 空间切换放弃提案的提示（决策 7，对齐填表任务 chatId 安全点精神）。 */
export const QUERY_CHAT_SPACE_SWITCHED_NOTICE = "对话已切换，变更未提交";

export interface QueryChatServiceOptions {
  /** 记忆空间只读端口（digest 构建 + query_records 工具共用）。 */
  readonly reader: MemorySpaceReader;
  /** 提案校验/预览/提交所需的领域访问端口（与填表任务共用同一组 repository）。 */
  readonly ports: MemoryProposalPorts;
  /** 批次原子提交上下文（id 生成器 + displayText 等，与填表任务共用）。 */
  readonly commitContext: MemoryRecordMutationContext;
  /** 原子事务运行器（提交批次在单事务内；由组合根注入 Dexie 事务）。 */
  readonly runInTransaction: (work: () => Promise<void>) => Promise<void>;
  /** LLM 端口工厂：每次 run 构造一次（宿主以 includeReasoning: true 构造，ticket 19）。 */
  readonly createLlm: () => LlmPort;
  /** 当前绑定空间（填写提交前校验用）：读取活动空间 id；非 active 返回 undefined。 */
  readonly getCurrentSpaceId: () => MemorySpaceId | undefined;
  /** 单次 run 总超时（毫秒），默认 5 分钟。 */
  readonly timeoutMs?: number;
}

export interface QueryChatRunInput {
  readonly mode: QueryChatMode;
  readonly memorySpaceId: MemorySpaceId;
  /** 多轮历史 + 本轮用户消息（末尾一条必须是 user）。 */
  readonly messages: readonly QueryChatHistoryMessage[];
  readonly signal: AbortSignal;
  /** 事件回调：增量（thinking/text/toolcall）后终态（done/error）必发一次。 */
  readonly onEvent: (event: QueryChatEvent) => void;
}

export interface QueryChatRunResult {
  readonly stopReason: StopReason | undefined;
  readonly errorMessage: string | undefined;
  /** 最后一次助手消息的纯文本回答（供测试断言；UI 以流式增量为准）。 */
  readonly answer: string;
  /** 填写模式自动提交的结果；查询模式或未产生提案时为 undefined。 */
  readonly commit: QueryChatCommitResult | undefined;
}

/** 零用量占位：历史 assistant 消息元数据不被 LLM 循环使用（convertToLlm 只按角色过滤）。 */
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

export class QueryChatService {
  readonly #reader: MemorySpaceReader;
  readonly #ports: MemoryProposalPorts;
  readonly #commitContext: MemoryRecordMutationContext;
  readonly #runInTransaction: (work: () => Promise<void>) => Promise<void>;
  readonly #createLlm: () => LlmPort;
  readonly #getCurrentSpaceId: () => MemorySpaceId | undefined;
  readonly #timeoutMs: number;

  constructor(options: QueryChatServiceOptions) {
    this.#reader = options.reader;
    this.#ports = options.ports;
    this.#commitContext = options.commitContext;
    this.#runInTransaction = options.runInTransaction;
    this.#createLlm = options.createLlm;
    this.#getCurrentSpaceId = options.getCurrentSpaceId;
    this.#timeoutMs = options.timeoutMs ?? QUERY_CHAT_TIMEOUT_MS;
  }

  /**
   * 跑一次问答 run。返回结构化结果；所有失败都以 onEvent 的终态事件编码
   * （绝不抛异常——UI 无需 try/catch，但仍容忍防御性 catch）。
   */
  async run(input: QueryChatRunInput): Promise<QueryChatRunResult> {
    if (input.messages.length === 0) {
      return this.#fail(input, "问答消息为空");
    }
    if (input.messages[input.messages.length - 1]!.role !== "user") {
      return this.#fail(input, "本轮消息必须是用户消息");
    }
    if (input.signal.aborted) {
      return this.#fail(input, "已取消");
    }
    try {
      // LLM 配置缺失在 run 开始时立即失败（createLlm 读 ST 当前配置，缺失抛中文错误）。
      const llm = this.#createLlm();
      const messages = toAgentMessages(input.messages, llm.model.id);
      if (input.mode === "fill") {
        return await this.#runFill(input, llm, messages);
      }
      return await this.#runQuery(input, llm, messages);
    } catch (error) {
      return this.#fail(input, errorMessage(error));
    }
  }

  /** 查询模式：QueryAgent（只读，core 固定提示词）。 */
  async #runQuery(
    input: QueryChatRunInput,
    llm: LlmPort,
    messages: readonly AgentMessage[],
  ): Promise<QueryChatRunResult> {
    const agent = new QueryAgent({
      llm,
      reader: this.#reader,
      timeoutMs: this.#timeoutMs,
    });
    const result = await agent.run(
      { memorySpaceId: input.memorySpaceId, messages },
      { signal: input.signal, onEvent: this.#translate(input) },
    );
    const terminal = terminalQueryChatEvent(result, input.signal, undefined);
    input.onEvent(terminal);
    return {
      stopReason: result.stopReason,
      errorMessage: result.errorMessage,
      answer: result.answer,
      commit: undefined,
    };
  }

  /**
   * 填写模式：共享组装模块 + 交互式填写提示词（软闸门，ADR 0024）；run 结束后
   * 冻结提案经空间一致性校验直通 repository。
   */
  async #runFill(
    input: QueryChatRunInput,
    llm: LlmPort,
    messages: readonly AgentMessage[],
  ): Promise<QueryChatRunResult> {
    // digest 在 run 前构建一次，同时喂消息展开（软闸门提示词）与工具装配。
    const digest = await buildMemorySpaceTableDigest(this.#reader, input.memorySpaceId);
    const composed: readonly ComposedAgentMessage[] = [
      { role: "system", text: composeInteractiveProposalAgentSystemPrompt(digest) },
    ];
    const result = await runFillAgent({
      llm,
      reader: this.#reader,
      ports: this.#ports,
      memorySpaceId: input.memorySpaceId,
      digest,
      composedMessages: composed,
      messages,
      // 聊天无消息范围概念：合成占位（commit 不使用它，仅预览元数据，对齐 api）。
      messageRange: { from: 0, to: 0 },
      // v1 交互式填写不注入证据（零剧情注入，决策 2）。
      evidence: [],
      timeoutMs: this.#timeoutMs,
      signal: input.signal,
      onEvent: this.#translate(input),
    });

    // 自动落库（ADR 0019）：只有正常结束（非取消/超时）才提交冻结提案。
    let commit: QueryChatCommitResult | undefined;
    if (result.proposal && !input.signal.aborted && result.stopReason !== "aborted") {
      commit = await this.#commitProposal(input.memorySpaceId, result.proposal);
    }
    const terminal = terminalQueryChatEvent(result, input.signal, commit);
    input.onEvent(terminal);
    return {
      stopReason: result.stopReason,
      errorMessage: result.errorMessage,
      answer: result.answer,
      commit,
    };
  }

  /** 提交冻结提案：空间校验（决策 7）→ 单事务直通 repository（revisionSource "agent"）。 */
  async #commitProposal(
    startSpaceId: MemorySpaceId,
    proposal: MemoryProposalSubmission,
  ): Promise<QueryChatCommitResult> {
    // 运行中切换对话：提交前校验当前绑定空间 == run 起始空间，不一致放弃提案。
    if (this.#getCurrentSpaceId() !== startSpaceId) {
      return { status: "abandoned", notice: QUERY_CHAT_SPACE_SWITCHED_NOTICE };
    }
    try {
      await this.#runInTransaction(async () => {
        await commitMemoryProposalBatch(this.#commitContext, startSpaceId, proposal, "agent");
      });
      return {
        status: "committed",
        created: proposal.batch.create.length,
        updated: proposal.batch.update.length,
        deleted: proposal.batch.delete.length,
      };
    } catch (error) {
      return { status: "failed", error: errorMessage(error) };
    }
  }

  /** Agent 事件翻译（对齐 api translateAgentEvent：只透传思考/回答增量与工具调用）。 */
  #translate(input: QueryChatRunInput): (event: AgentEvent) => void {
    return (event) => {
      for (const chatEvent of translateAgentEvent(event)) input.onEvent(chatEvent);
    };
  }

  /** 收口：终态 error 事件 + 结构化结果（校验失败/异常共用，绝不抛出）。 */
  #fail(input: QueryChatRunInput, message: string): QueryChatRunResult {
    input.onEvent({ type: "error", message });
    return { stopReason: "error", errorMessage: message, answer: "", commit: undefined };
  }
}

/** pi AgentEvent → 问答事件（未映射的事件类型返回空数组，不产生噪音）。 */
export function translateAgentEvent(event: AgentEvent): readonly QueryChatEvent[] {
  switch (event.type) {
    case "message_update": {
      const delta = event.assistantMessageEvent;
      if (delta.type === "text_delta") return [{ type: "message_delta", text: delta.delta }];
      if (delta.type === "thinking_delta") return [{ type: "thinking_delta", text: delta.delta }];
      return [];
    }
    case "tool_execution_start":
      return [
        { type: "tool_start", callId: event.toolCallId, name: event.toolName, args: event.args },
      ];
    case "tool_execution_end":
      return [
        {
          type: "tool_result",
          callId: event.toolCallId,
          name: event.toolName,
          result: toolResultDetails(event.result),
          isError: event.isError,
        },
      ];
    default:
      return [];
  }
}

/** 工具执行结果取结构化 details（query_records 的 QueryRecordsToolResult），没有则回退原值。 */
function toolResultDetails(result: unknown): unknown {
  if (typeof result === "object" && result !== null && "details" in result) {
    return (result as { readonly details: unknown }).details;
  }
  return result;
}

/**
 * run 终态 → 终态事件（对齐 api terminalAgentRunEvent，补取消/超时区分）：
 * - stop/length：正常结束（done，可携带自动提交结果）；
 * - error：模型调用失败（网络/鉴权等，pi 以 stopReason "error" + errorMessage 编码）；
 * - aborted：调用方取消（「已取消」）或内部超时（5 分钟提示）。
 */
export function terminalQueryChatEvent(
  result: {
    readonly stopReason: StopReason | undefined;
    readonly errorMessage: string | undefined;
    readonly answer: string;
  },
  signal: AbortSignal,
  commit: QueryChatCommitResult | undefined,
): QueryChatEvent {
  switch (result.stopReason) {
    case "stop":
    case "length":
      return {
        type: "done",
        stopReason: result.stopReason,
        errorMessage: result.errorMessage ?? null,
        commit,
      };
    case "error":
      return { type: "error", message: result.errorMessage ?? "模型调用失败" };
    case "aborted":
      return {
        type: "error",
        message: signal.aborted ? "已取消" : "Agent 运行超时（默认 5 分钟），请重试或缩小问题范围",
      };
    default:
      return { type: "error", message: "未产生回答" };
  }
}

/** 客户端文本历史 → pi AgentMessage（无状态多轮：只回传 user/assistant 文本）。 */
export function toAgentMessages(
  messages: readonly QueryChatHistoryMessage[],
  model: string,
): readonly AgentMessage[] {
  const timestamp = Date.now();
  return messages.map((message) =>
    message.role === "user"
      ? { role: "user", content: [{ type: "text", text: message.text }], timestamp }
      : {
          role: "assistant",
          content: [{ type: "text", text: message.text }],
          api: "openai-completions",
          provider: "sillytavern",
          model,
          usage: ZERO_USAGE,
          stopReason: "stop",
          timestamp,
        },
  );
}
