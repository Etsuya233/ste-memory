/**
 * 假 LLM 测试支持（ticket 13）：脚本化 streamFn（预排事件序列跑通整循环），
 * 与 apps/api `test/chat-stream-support.ts` 同模式——填表任务测试不依赖真实模型。
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  ToolCall,
} from "@earendil-works/pi-ai";

/**
 * 极简队列式事件流：agent 循环只消费「异步可迭代 + result()」契约；next() 在
 * 队列为空时挂起等待 push/end（用于超时/门控场景：事件在放行时才到达）。
 */
export class ScriptedEventStream implements AsyncIterable<AssistantMessageEvent> {
  readonly #queue: AssistantMessageEvent[] = [];
  readonly #waiters: Array<() => void> = [];
  #result: AssistantMessage | undefined;
  #ended = false;

  push(event: AssistantMessageEvent): void {
    this.#queue.push(event);
    this.#waiters.shift()?.();
  }

  end(result: AssistantMessage): void {
    this.#result = result;
    this.#ended = true;
    while (this.#waiters.length > 0) this.#waiters.shift()!();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    while (true) {
      while (this.#queue.length > 0) yield this.#queue.shift()!;
      if (this.#ended) return;
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }

  async result(): Promise<AssistantMessage | undefined> {
    return this.#result;
  }
}

/** 断言转换：StreamFn 的返回类型是 pi 的完整 EventStream 类，运行时只需迭代器 + result()。 */
export function toStream(stream: ScriptedEventStream): AssistantMessageEventStream {
  return stream as unknown as AssistantMessageEventStream;
}

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

/** 最近一条工具执行结果（agent 上下文回看：有 toolResult 说明上一轮已执行工具）。 */
export function lastToolResult(context: Context) {
  return [...context.messages].reverse().find((message) => message.role === "toolResult");
}

export function fakeModel(): Model<Api> {
  return {
    id: "fake-model",
    name: "假模型",
    api: "openai-completions",
    provider: "faux",
    baseUrl: "http://fake.local",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
  };
}

export interface StreamFnScript {
  /** 本轮回复：读当前 LLM 上下文（含 toolResult 历史）决定回复内容。 */
  respond: (context: Context) => AssistantMessage;
  /** 流式调用次数（整循环 = 工具轮数 + 回答轮数）。 */
  readonly calls: { count: number };
  /** 每次流式调用收到的 LLM 上下文（供多轮历史断言）。 */
  readonly contexts: Context[];
}

/** 脚本化 streamFn：响应一次性给出（start + done/error），符合 pi streamFn 契约。 */
export function scriptedStreamFn(
  respond: (context: Context) => AssistantMessage,
): StreamFn & StreamFnScript {
  const calls = { count: 0 };
  const contexts: Context[] = [];
  const streamFn: StreamFn = (_model, context) => {
    calls.count += 1;
    contexts.push(context);
    const stream = new ScriptedEventStream();
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
    return toStream(stream);
  };
  return Object.assign(streamFn, { respond, calls, contexts });
}

/**
 * 门控 streamFn：前 gateAtCall-1 次调用正常响应；第 gateAtCall 次调用挂起，
 * 直到 gate.open() 才响应；放行后后续调用正常。用于模拟「块运行时任务仍在跑」。
 */ export function gatedStreamFn(
  respond: (context: Context) => AssistantMessage,
  gateAtCall: number,
): ReturnType<typeof scriptedStreamFn> & {
  readonly gate: { readonly fired: boolean; open: () => void };
} {
  const calls = { count: 0 };
  const contexts: Context[] = [];
  const gate: { fired: boolean; open: () => void } = {
    fired: false,
    open: () => undefined,
  };
  const waiters: Array<() => void> = [];
  const streamFn: StreamFn = (_model, context) => {
    calls.count += 1;
    contexts.push(context);
    const stream = new ScriptedEventStream();
    const respondNow = () => {
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
    };
    if (calls.count === gateAtCall && !gate.fired) {
      waiters.push(respondNow);
    } else {
      queueMicrotask(respondNow);
    }
    return toStream(stream);
  };
  gate.open = () => {
    if (gate.fired) return;
    gate.fired = true;
    waiters.splice(0).forEach((respondNow) => respondNow());
  };
  return Object.assign(streamFn, { respond, calls, contexts, gate });
}

/** 永不结束的流：任务停在 agent.run，用于冲突/中断语义测试。 */
export function hangingStreamFn(): StreamFn {
  const streamFn: StreamFn = (_model, _context, options) => {
    const stream = new ScriptedEventStream();
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
    return toStream(stream);
  };
  return streamFn;
}
