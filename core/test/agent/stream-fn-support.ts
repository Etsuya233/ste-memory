import {
  AssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

// ---------------------------------------------------------------------------
// 消息/模型构造
// ---------------------------------------------------------------------------

export function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "faux",
    model: "fake-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

export function toolCallMessage(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

export function textMessage(text: string): AssistantMessage["content"][number] {
  return { type: "text", text };
}

/** 假模型：满足 Model 形状，仅供 agent 循环内部传递。 */
export function fakeModel(): Model<Api> {
  return {
    id: "fake-model",
    name: "假模型",
    api: "openai-completions",
    provider: "faux",
    baseUrl: "http://fake.local",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
  };
}

// ---------------------------------------------------------------------------
// 脚本化假 streamFn：按当前上下文消息决定本轮助手消息，
// 跑通整循环（工具调用 → 查询结果 → 回答）不依赖真实模型与 HTTP
// ---------------------------------------------------------------------------

export interface StreamFnScript {
  /** 本轮回复：读当前 LLM 上下文（含 toolResult 历史）决定回复内容。 */
  respond: (context: Context) => AssistantMessage;
  /** 流式调用次数（供断言：整循环 = 工具轮数 + 回答轮数）。 */
  readonly calls: { count: number };
}

/** 脚本化 streamFn：响应一次性给出（start + done/error），符合 pi streamFn 契约。 */
export function scriptedStreamFn(
  respond: (context: Context) => AssistantMessage,
): StreamFn & StreamFnScript {
  const calls = { count: 0 };
  const streamFn: StreamFn = (_model, context) => {
    calls.count += 1;
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => {
      const message = respond(context);
      stream.push({ type: "start", partial: message });
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } else {
        stream.push({
          type: "done",
          reason: message.stopReason as "stop" | "length" | "toolUse",
          message,
        });
      }
      stream.end(message);
    });
    return stream;
  };
  return Object.assign(streamFn, { respond, calls });
}

/** 悬挂 streamFn：不回复，直到 signal 中止后以 aborted 消息收尾（用于超时/取消测试）。 */
export function hangingStreamFn(): StreamFn {
  return (_model, _context, options) => {
    const stream = new AssistantMessageEventStream();
    options?.signal?.addEventListener(
      "abort",
      () => {
        const message = assistantMessage([], "aborted", "测试取消");
        stream.push({ type: "start", partial: message });
        stream.push({ type: "error", reason: "aborted", error: message });
        stream.end(message);
      },
      { once: true },
    );
    return stream;
  };
}

/** 最近一条 toolResult 消息（供脚本判断工具执行结果与是否已执行）。 */
export function lastToolResult(context: Context) {
  return [...context.messages].reverse().find((message) => message.role === "toolResult");
}
