import type { AgentEvent, StreamFn } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { LogLevel } from "../logging/log.ts";

/**
 * 填表运行记录（ADR 0008）：一个消息块对应的一次 ProposalAgent 运行的完整追踪。
 *
 * 捕获双源：
 * - 包装 streamFn——每次 LLM 调用收到完整请求快照（context.systemPrompt +
 *   context.messages），并从流的 done/error 事件收集该轮模型输出（含用量）；
 * - agent 事件（tool_execution_start/end）——按 toolCallId 把工具调用的参数、
 *   结果与错误配对到当前轮。
 *
 * 系统提示词块内每轮相同，存块级一份；轮内消息列表含工具结果历史（自包含）。
 */

/** 填表运行记录的通用日志类型。 */
export const FILL_RUN_LOG_TYPE = "fill";

export type FillRunStatus = "succeeded" | "failed" | "interrupted";

/** 一次工具调用：参数（执行开始）与结果/错误（执行结束）配对。 */
export interface FillRunToolResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly result: unknown;
  readonly isError: boolean;
}

/** 一轮 LLM 调用：请求消息快照 + 模型输出 + 该轮之后的工具执行。 */
export interface FillRunRound {
  /** 该轮模型实际收到的完整消息列表（含工具结果历史；系统提示词见块级 systemPrompt）。 */
  readonly request: { readonly messages: unknown };
  readonly output: {
    readonly content: unknown;
    readonly stopReason: string | undefined;
    readonly usage: unknown;
    readonly errorMessage: string | undefined;
  };
  readonly toolResults: readonly FillRunToolResult[];
}

/** 一条块运行记录（通用日志 type "fill" 的 data 载荷）。 */
export interface FillRunRecord {
  readonly taskRunId: string;
  readonly block: { readonly from: number; readonly to: number };
  readonly status: FillRunStatus;
  readonly errorMessage: string | null;
  /** 块级系统提示词快照（预设片段 + 世界书展开后的最终文本，块内每轮相同）。 */
  readonly systemPrompt: string;
  readonly rounds: readonly FillRunRound[];
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
}

/** 运行记录状态 → 日志级别：成功 info / 失败 error / 中断 warn。 */
export function fillRunRecordLevel(status: FillRunStatus): LogLevel {
  switch (status) {
    case "succeeded":
      return "info";
    case "failed":
      return "error";
    case "interrupted":
      return "warn";
  }
}

interface MutableToolResult {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: unknown;
  isError: boolean;
}

interface MutableRound {
  request: { readonly messages: unknown };
  output: {
    content: unknown;
    stopReason: string | undefined;
    usage: unknown;
    errorMessage: string | undefined;
  };
  /** 按 toolCallId 配对；Map 保持工具执行顺序。 */
  readonly toolResults: Map<string, MutableToolResult>;
}

export interface FillRunRecorder {
  /** 包装 streamFn：逐轮快照请求并从流事件收集输出。 */
  wrapStreamFn(streamFn: StreamFn): StreamFn;
  /** Agent 事件钩子：tool_execution_start/end 把工具调用配对到当前轮。 */
  onAgentEvent(event: AgentEvent): void;
  /** 块开始：清空轮记录、重置起始时间。 */
  beginBlock(): void;
  /** 块结束：组装运行记录（成功/失败/中断共用）。 */
  finish(
    block: { readonly from: number; readonly to: number },
    status: FillRunStatus,
    errorMessage: string | null,
  ): FillRunRecord;
}

export function createFillRunRecorder(options: {
  readonly taskRunId: string;
  readonly now: () => string;
}): FillRunRecorder {
  const { taskRunId, now } = options;
  let systemPrompt = "";
  let startedAt = now();
  let rounds: MutableRound[] = [];
  let currentRound: MutableRound | undefined;

  const wrapStreamFn: FillRunRecorder["wrapStreamFn"] =
    (streamFn) => async (model, context, streamOptions) => {
      systemPrompt = context.systemPrompt ?? "";
      const round: MutableRound = {
        request: { messages: context.messages },
        output: {
          content: undefined,
          stopReason: undefined,
          usage: undefined,
          errorMessage: undefined,
        },
        toolResults: new Map(),
      };
      rounds.push(round);
      currentRound = round;
      // StreamFn 契约允许异步返回流：await 后惰性包装（异常原样传播给 Agent 循环）
      return forwardStream(await streamFn(model, context, streamOptions), (event) => {
        // done/error 携带该轮最终 AssistantMessage（含内容/停止原因/用量/错误）
        if (event.type === "done") round.output = outputOf(event.message);
        if (event.type === "error") round.output = outputOf(event.error);
      });
    };

  const onAgentEvent: FillRunRecorder["onAgentEvent"] = (event) => {
    if (currentRound === undefined) return;
    if (event.type === "tool_execution_start") {
      currentRound.toolResults.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        result: undefined,
        isError: false,
      });
    } else if (event.type === "tool_execution_end") {
      const existing = currentRound.toolResults.get(event.toolCallId);
      currentRound.toolResults.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: existing?.toolName ?? event.toolName,
        args: existing?.args,
        result: event.result,
        isError: event.isError,
      });
    }
  };

  const beginBlock: FillRunRecorder["beginBlock"] = () => {
    systemPrompt = "";
    startedAt = now();
    rounds = [];
    currentRound = undefined;
  };

  const finish: FillRunRecorder["finish"] = (block, status, errorMessage) => {
    const endedAt = now();
    return {
      taskRunId,
      block,
      status,
      errorMessage,
      systemPrompt,
      rounds: rounds.map((round) => ({
        request: round.request,
        output: round.output,
        toolResults: [...round.toolResults.values()],
      })),
      startedAt,
      endedAt,
      durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
    };
  };

  return { wrapStreamFn, onAgentEvent, beginBlock, finish };
}

function outputOf(message: AssistantMessage): MutableRound["output"] {
  return {
    content: message.content,
    stopReason: message.stopReason,
    usage: message.usage,
    errorMessage: message.errorMessage,
  };
}

/**
 * 惰性包装流：观察器挂在原流迭代器上，逐事件透传给 Agent 循环。与原流直接
 * 消费语义完全一致——迭代异常原样传播（不改变任务失败语义），result() 委托
 * 原流。运行时只需迭代器 + result()，类本身不可直接构造（pi-ai 以 type-only
 * 导出），与测试 harness 的 toStream 同模式。
 */
function forwardStream(
  stream: AssistantMessageEventStream,
  observe: (event: AssistantMessageEvent) => void,
): AssistantMessageEventStream {
  const iterator = stream[Symbol.asyncIterator]();
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          const next = await iterator.next();
          if (!next.done) observe(next.value);
          return next;
        },
      };
    },
    result: () => stream.result(),
  } as unknown as AssistantMessageEventStream;
}
