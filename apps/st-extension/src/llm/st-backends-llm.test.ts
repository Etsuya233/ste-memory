import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import type { StBackendsModel } from "./st-completion-settings.ts";
import {
  createAgentConnectionLlmPort,
  createStLlmPort,
  ST_CSRF_ENDPOINT,
  ST_GENERATE_ENDPOINT,
  StBackendsLlmAdapter,
  type StBackendsLlmAdapterOptions,
} from "./st-backends-llm.ts";
import type { StContext } from "../st/st-chat-adapter.ts";

/**
 * 适配器集成测试：mock fetch（可流式 SSE、可注入 AbortSignal），断言
 * pi 事件序列 + 请求形状 + 错误映射。测试覆盖验收标准：
 * 请求形状（ST 特有字段）/ SSE→pi 事件 / tools 透传 / 401/429/断流/超时。
 */

const TEST_CONFIG = {
  source: "openai",
  modelName: "gpt-4o",
  temperature: 1.1,
  topP: 0.9,
  frequencyPenalty: 0.2,
  presencePenalty: 0.3,
  maxTokens: 2048,
  contextWindow: 8192,
};

function testModel(): StBackendsModel {
  return {
    id: "gpt-4o",
    name: "gpt-4o",
    api: "openai-completions",
    provider: "sillytavern",
    baseUrl: "/api/backends/chat-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 300,
    stSource: "openai",
  };
}

/** 构造 SSE 响应：全部块入队后不关闭（等 abort 或显式 [DONE]）；传 signal 则挂到 abort
 * （模拟真实 fetch：请求 signal 中止 → 响应体流 error → reader.read() 拒绝） */
function sseResponse(chunks: string[], init: ResponseInit = {}, signal?: AbortSignal | null): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (signal) {
        signal.addEventListener("abort", () =>
          controller.error(new DOMException("Aborted", "AbortError")),
        );
      }
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!signal) controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" }, ...init });
}

/** 请求 abort 时让响应体流中断的 fetch（signal 取请求自身的 init.signal） */
function abortableFetch(chunks: string[]) {
  return (async (_url: string, init?: RequestInit) =>
    sseResponse(chunks, {}, init?.signal)) as typeof fetch;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

interface MockFetchResult {
  fn: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
}

/** 记录请求的 mock fetch；handler 返回响应或抛错（模拟网络失败） */
function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): MockFetchResult {
  const calls: MockFetchResult["calls"] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

function makeAdapter(options: Partial<StBackendsLlmAdapterOptions> = {}, fetchFn?: typeof fetch) {
  const adapter = new StBackendsLlmAdapter({
    config: TEST_CONFIG,
    fetchImpl: fetchFn,
    getCsrfToken: async () => "csrf-abc",
    now: () => 1234567890,
    log: { warn: vi.fn(), error: vi.fn() },
    ...options,
  });
  return adapter;
}

/** 跑一次 streamFn，返回 { events, message } */
async function runStream(
  adapter: StBackendsLlmAdapter,
  context: Context,
  options?: Parameters<StBackendsLlmAdapter["streamFn"]>[2],
): Promise<{ events: AssistantMessageEvent[]; message: AssistantMessage }> {
  const stream = await adapter.streamFn(testModel(), context, options);
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, message: await stream.result() };
}

function sseEvent(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function textChunk(text: string, finish: string | null = null): unknown {
  return { id: "chatcmpl-1", choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] };
}

describe("StBackendsLlmAdapter.streamFn（SSE → pi 事件流）", () => {
  it("文本流：start → text_start/delta… → text_end → done(stop)，终态消息完整", async () => {
    const fetchMock = mockFetch(() => sseResponse([
      sseEvent(textChunk("你")),
      sseEvent(textChunk("好")),
      sseEvent(textChunk("", "stop")),
      "data: [DONE]\n\n",
    ]));
    const adapter = makeAdapter({}, fetchMock.fn);
    const { events, message } = await runStream(adapter, { messages: [{ role: "user", content: "hi", timestamp: 1 }] });

    expect(events.map((e) => e.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([{ type: "text", text: "你好" }]);
    expect(message.usage.totalTokens).toBe(0);

    // 请求形状：ST 特有字段 + CSRF 头
    expect(fetchMock.calls).toHaveLength(1);
    const call = fetchMock.calls[0]!;
    expect(call.url).toBe(ST_GENERATE_ENDPOINT);
    const headers = call.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-CSRF-Token"]).toBe("csrf-abc");
    const body = JSON.parse(call.init?.body as string);
    expect(body.chat_completion_source).toBe("openai");
    expect(body.type).toBe("normal");
    expect(body.model).toBe("gpt-4o");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("工具调用流：toolcall_start/delta/end + done(toolUse)，arguments 跨块累积解析", async () => {
    const fetchMock = mockFetch(() => sseResponse([
      sseEvent({
        id: "chatcmpl-2",
        choices: [{
          index: 0,
          delta: { content: null, tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "query_records", arguments: "" } }] },
          finish_reason: null,
        }],
      }),
      sseEvent({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"table\":\"c" } }] }, finish_reason: null }] }),
      sseEvent({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "haracters\"}" } }] }, finish_reason: "tool_calls" }] }),
    ]));
    const adapter = makeAdapter({}, fetchMock.fn);
    const { events, message } = await runStream(adapter, {
      messages: [],
      tools: [{ name: "query_records", description: "查询", parameters: {} }],
    });

    expect(events.map((e) => e.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(message.stopReason).toBe("toolUse");
    expect(message.content).toEqual([{
      type: "toolCall",
      id: "call_9",
      name: "query_records",
      arguments: { table: "characters" },
    }]);

    // tools 透传
    const body = JSON.parse(fetchMock.calls[0]!.init?.body as string);
    expect(body.tools).toEqual([
      { type: "function", function: { name: "query_records", description: "查询", parameters: {} } },
    ]);
    expect(body.tool_choice).toBe("auto");
  });

  it("[DONE] 无 finish_reason 时按 stop 完成（兼容上游）", async () => {
    const adapter = makeAdapter({}, mockFetch(() => sseResponse(["data: [DONE]\n\n"])).fn);
    const { message } = await runStream(adapter, { messages: [] });
    expect(message.stopReason).toBe("stop");
  });

  it("finish_reason=length → stopReason length", async () => {
    const adapter = makeAdapter({}, mockFetch(() => sseResponse([sseEvent(textChunk("长", "length"))])).fn);
    const { message } = await runStream(adapter, { messages: [] });
    expect(message.stopReason).toBe("length");
  });

  it("SSE 跨 chunk 边界 + 多字节 UTF-8 字符正确拼接", async () => {
    const adapter = makeAdapter({}, mockFetch(() => sseResponse([
      "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你",
      "\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"好\"},\"finish_reason\":\"stop\"}]}\n\n",
    ])).fn);
    const { message } = await runStream(adapter, { messages: [] });
    expect(message.content).toEqual([{ type: "text", text: "你好" }]);
  });
});

describe("StBackendsLlmAdapter 思考流（ticket 19）", () => {
  it("Claude 风格 delta.thinking：thinking_start/delta/end + ThinkingContent 块；请求带 include_reasoning", async () => {
    const fetchMock = mockFetch(() => sseResponse([
      sseEvent({ id: "chatcmpl-t", choices: [{ index: 0, delta: { thinking: "我在" }, finish_reason: null }] }),
      sseEvent({ choices: [{ index: 0, delta: { thinking: "思考" }, finish_reason: null }] }),
      sseEvent({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]));
    const adapter = makeAdapter({ includeReasoning: true }, fetchMock.fn);
    const { events, message } = await runStream(adapter, { messages: [{ role: "user", content: "hi", timestamp: 1 }] });

    expect(events.map((e) => e.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_delta",
      "thinking_end",
      "done",
    ]);
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([{ type: "thinking", thinking: "我在思考" }]);

    const body = JSON.parse(fetchMock.calls[0]!.init?.body as string);
    expect(body.include_reasoning).toBe(true);
  });

  it("reasoning_content 风格：OpenAI 兼容推理模型字段同样累积为独立块", async () => {
    const fetchMock = mockFetch(() => sseResponse([
      sseEvent({ choices: [{ index: 0, delta: { reasoning_content: "推理" }, finish_reason: null }] }),
      sseEvent({ choices: [{ index: 0, delta: { reasoning_content: "中" }, finish_reason: null }] }),
      sseEvent({ choices: [{ index: 0, delta: { content: "回答" }, finish_reason: "stop" }] }),
    ]));
    const adapter = makeAdapter({ includeReasoning: true }, fetchMock.fn);
    const { events, message } = await runStream(adapter, { messages: [] });

    expect(events.map((e) => e.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_delta",
      "text_start",
      "text_delta",
      "thinking_end",
      "text_end",
      "done",
    ]);
    expect(message.content).toEqual([
      { type: "thinking", thinking: "推理中" },
      { type: "text", text: "回答" },
    ]);
  });

  it("思考与工具调用穿插：contentIndex 隔离，思考块不进入 tool_calls 累积", async () => {
    const fetchMock = mockFetch(() => sseResponse([
      sseEvent({ choices: [{ index: 0, delta: { thinking: "先想" }, finish_reason: null }] }),
      sseEvent({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "query_records", arguments: "" } }] }, finish_reason: null }] }),
      sseEvent({ choices: [{ index: 0, delta: { thinking: "再想" }, finish_reason: null }] }),
      sseEvent({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, finish_reason: "tool_calls" }] }),
    ]));
    const adapter = makeAdapter({ includeReasoning: true }, fetchMock.fn);
    const { events, message } = await runStream(adapter, {
      messages: [],
      tools: [{ name: "query_records", description: "查询", parameters: {} }],
    });

    expect(message.stopReason).toBe("toolUse");
    expect(message.content).toEqual([
      { type: "thinking", thinking: "先想再想" },
      { type: "toolCall", id: "call_1", name: "query_records", arguments: {} },
    ]);

    // 思考事件 contentIndex 恒 0，工具事件 contentIndex 恒 1：不互相污染
    const thinkingIndexes = events
      .filter((e) => e.type === "thinking_start" || e.type === "thinking_delta" || e.type === "thinking_end")
      .map((e) => (e as { contentIndex: number }).contentIndex);
    expect(thinkingIndexes).toEqual([0, 0, 0, 0]);
    const toolIndexes = events
      .filter((e) => e.type === "toolcall_start" || e.type === "toolcall_delta" || e.type === "toolcall_end")
      .map((e) => (e as { contentIndex: number }).contentIndex);
    expect(toolIndexes).toEqual([1, 1, 1]);
  });

  it("缺省 includeReasoning=false：请求不带思考开关，上游思考段被忽略（零变化）", async () => {
    const fetchMock = mockFetch(() => sseResponse([
      sseEvent({ choices: [{ index: 0, delta: { thinking: "不该被解析" }, finish_reason: null }] }),
      sseEvent({ choices: [{ index: 0, delta: { content: "正常回答" }, finish_reason: "stop" }] }),
    ]));
    const adapter = makeAdapter({}, fetchMock.fn);
    const { events, message } = await runStream(adapter, { messages: [] });

    expect(message.content).toEqual([{ type: "text", text: "正常回答" }]);
    expect(events.some((e) => e.type.startsWith("thinking"))).toBe(false);

    const body = JSON.parse(fetchMock.calls[0]!.init?.body as string);
    expect(body.include_reasoning).toBe(false);
  });
});

describe("StBackendsLlmAdapter 错误路径", () => {
  it("401 → error 事件 + 鉴权提示；CSRF 缓存被清（下次重取）", async () => {
    const getCsrfToken = vi.fn(async () => "token-1");
    const fetchMock = mockFetch(() => jsonResponse({ error: { message: "Unauthorized" } }, { status: 401 }));
    const adapter = makeAdapter({ getCsrfToken }, fetchMock.fn);
    const { events, message } = await runStream(adapter, { messages: [] });
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("鉴权失败（401）");
    expect(events.at(-1)?.type).toBe("error");
    // 第二次调用重新取令牌
    const fetchMock2 = mockFetch(() => sseResponse([sseEvent(textChunk("ok", "stop"))]));
    const adapter2 = makeAdapter({ getCsrfToken }, fetchMock2.fn);
    await runStream(adapter2, { messages: [] });
    expect(getCsrfToken).toHaveBeenCalledTimes(2);
  });

  it("429 带 quota_error → 额度不足提示；无 quota → 限流提示", async () => {
    const quota = makeAdapter({}, mockFetch(() => jsonResponse(
      { error: { message: "insufficient_quota" }, quota_error: true },
      { status: 429 },
    )).fn);
    const { message: quotaMessage } = await runStream(quota, { messages: [] });
    expect(quotaMessage.errorMessage).toContain("额度不足");

    const plain = makeAdapter({}, mockFetch(() => jsonResponse(
      { error: { message: "rate limited" } },
      { status: 429 },
    )).fn);
    const { message: plainMessage } = await runStream(plain, { messages: [] });
    expect(plainMessage.errorMessage).toContain("限流");
  });

  it("500 带 ST 错误体 → 上游 message 透出", async () => {
    const adapter = makeAdapter({}, mockFetch(() => jsonResponse(
      { error: { message: "Upstream exploded" } },
      { status: 500 },
    )).fn);
    const { message } = await runStream(adapter, { messages: [] });
    expect(message.errorMessage).toContain("Upstream exploded");
  });

  it("网络错误（fetch 抛 TypeError）→ error 事件不抛异常", async () => {
    const adapter = makeAdapter({}, mockFetch(() => {
      throw new TypeError("Failed to fetch");
    }).fn);
    const { events, message } = await runStream(adapter, { messages: [] });
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("Failed to fetch");
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("流中断（EOF 无 [DONE] 无 finish_reason）→ 断流提示", async () => {
    const adapter = makeAdapter({}, mockFetch(() => sseResponse([sseEvent(textChunk("一半"))])).fn);
    const { message } = await runStream(adapter, { messages: [] });
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("响应流意外中断");
  });

  it("SSE 数据非 JSON → 解析失败提示", async () => {
    const adapter = makeAdapter({}, mockFetch(() => sseResponse(["data: not-json\n\n"])).fn);
    const { message } = await runStream(adapter, { messages: [] });
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("SSE 数据解析失败");
  });

  it("流中上游错误 chunk（{\"error\":…}）→ 真实原因透出而非断流误报", async () => {
    const adapter = makeAdapter({}, mockFetch(() => sseResponse([
      sseEvent(textChunk("开头")),
      sseEvent({ error: { message: "upstream blew up mid-stream" } }),
    ])).fn);
    const { message } = await runStream(adapter, { messages: [] });
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("upstream blew up mid-stream");
    expect(message.errorMessage).not.toContain("响应流意外中断");
  });

  it("429 上游错误体 type=insufficient_quota（流式原样转发）→ 额度不足提示", async () => {
    const adapter = makeAdapter({}, mockFetch(() => jsonResponse(
      { error: { message: "You exceeded your current quota", type: "insufficient_quota" } },
      { status: 429 },
    )).fn);
    const { message } = await runStream(adapter, { messages: [] });
    expect(message.errorMessage).toContain("额度不足");
  });

  it("signal 在调用前已 aborted → 直接 aborted 不发起请求", async () => {
    const fetchMock = mockFetch(() => sseResponse([sseEvent(textChunk("不该有"))]));
    const controller = new AbortController();
    controller.abort();
    const adapter = makeAdapter({}, fetchMock.fn);
    const { message } = await runStream(adapter, { messages: [] }, { signal: controller.signal });
    expect(message.stopReason).toBe("aborted");
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("AbortSignal 取消 → aborted", async () => {
    const controller = new AbortController();
    const adapter = makeAdapter({}, abortableFetch([sseEvent(textChunk("开")), sseEvent(textChunk("始"))]));
    const stream = await adapter.streamFn(testModel(), { messages: [] }, { signal: controller.signal });
    const events: AssistantMessageEvent[] = [];
    const reader = stream[Symbol.asyncIterator]();
    let first = await reader.next();
    while (!first.done) {
      events.push(first.value);
      if (first.value.type === "text_delta") break;
      first = await reader.next();
    }
    controller.abort();
    for (let next = await reader.next(); !next.done; next = await reader.next()) {
      events.push(next.value);
    }
    const message = await stream.result();
    expect(message.stopReason).toBe("aborted");
    expect(message.errorMessage).toBe("请求已取消");
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("超时（timeoutMs）→ aborted + 超时提示", async () => {
    const adapter = makeAdapter({ timeoutMs: 30 }, abortableFetch([sseEvent(textChunk("等"))]));
    const { message } = await runStream(adapter, { messages: [] });
    expect(message.stopReason).toBe("aborted");
    expect(message.errorMessage).toContain("生成超时");
  });

  it("CSRF 令牌为 'disabled'（ST 关闭 CSRF）时不带 X-CSRF-Token", async () => {
    const fetchMock = mockFetch(() => sseResponse([sseEvent(textChunk("ok", "stop"))]));
    const adapter = makeAdapter({ getCsrfToken: async () => "disabled" }, fetchMock.fn);
    await runStream(adapter, { messages: [] });
    const headers = fetchMock.calls[0]!.init?.headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("缺省 CSRF 获取走 GET /csrf-token（响应 {token}）", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === ST_CSRF_ENDPOINT) return jsonResponse({ token: "csrf-real" });
      return sseResponse([sseEvent(textChunk("ok", "stop"))]);
    }) as typeof fetch;
    const adapter = makeAdapter({ getCsrfToken: undefined }, fn);
    await runStream(adapter, { messages: [] });
    expect(calls[0]!.url).toBe(ST_CSRF_ENDPOINT);
    const headers = calls[1]!.init?.headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBe("csrf-real");
  });
});

describe("createStLlmPort（读 ST 当前配置）", () => {
  function fakeContext(overrides: Partial<StContext> = {}): StContext {
    return {
      chatId: "story",
      chatCompletionSettings: {
        chat_completion_source: "openai",
        temp_openai: 0.7,
        top_p_openai: 0.9,
        freq_pen_openai: 0,
        pres_pen_openai: 0,
        openai_max_tokens: 1024,
        openai_max_context: 8192,
      },
      getChatCompletionModel: (settings) => (settings.chat_completion_source === "openai" ? "gpt-4o" : ""),
      ...overrides,
    };
  }

  it("端口模型带 ST 配置（模型名/source/上下文预算）", () => {
    const port = createStLlmPort(() => fakeContext());
    expect(port.model.id).toBe("gpt-4o");
    expect((port.model as StBackendsModel).stSource).toBe("openai");
    expect(port.model.contextWindow).toBe(8192);
    expect(port.model.maxTokens).toBe(1024);
    expect(typeof port.streamFn).toBe("function");
  });

  it("生成源未知 → 中文报错", () => {
    expect(() => createStLlmPort(() => fakeContext({ chatCompletionSettings: {} }))).toThrow(
      /Chat Completion 源未知/,
    );
  });

  it("模型未配置 → 中文报错", () => {
    expect(() =>
      createStLlmPort(() =>
        fakeContext({ getChatCompletionModel: () => "" }),
      ),
    ).toThrow(/未配置模型/);
  });

  it("端口 streamFn 可直接跑通（请求体带 stSource）", async () => {
    const fetchMock = mockFetch(() => sseResponse([sseEvent(textChunk("好", "stop"))]));
    const port = createStLlmPort(() => fakeContext(), { fetchImpl: fetchMock.fn, getCsrfToken: async () => "t" });
    const stream = await port.streamFn(port.model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] });
    const message = await stream.result();
    expect(message.stopReason).toBe("stop");
    const body = JSON.parse(fetchMock.calls[0]!.init?.body as string);
    expect(body.chat_completion_source).toBe("openai");
    expect(body.model).toBe("gpt-4o");
  });
});
describe("StBackendsLlmAdapter 连接标签（ADR 0010：错误带连接名前缀）", () => {
  it("带 label 的适配器：错误消息 = Agent 连接 [名称]：<原始错误>（不吞上游 message）", async () => {
    const adapter = makeAdapter(
      { label: "DeepSeek 主用" },
      mockFetch(() =>
        jsonResponse({ error: { message: "Invalid API key provided" } }, { status: 401 }),
      ).fn,
    );
    const { message } = await runStream(adapter, { messages: [] });
    expect(message.errorMessage).toContain("Agent 连接 [DeepSeek 主用]");
    expect(message.errorMessage).toContain("Invalid API key provided");
    // reverse_proxy 路径下 401 来自上游：引导语指向上游密钥，不是 ST 会话
    expect(message.errorMessage).toContain("上游鉴权失败");
    expect(message.errorMessage).not.toContain("刷新页面");
  });

  it("无 label（跟随 ST 当前连接）：错误消息不带前缀（现有格式零变化）", async () => {
    const adapter = makeAdapter({}, mockFetch(() => jsonResponse(
      { error: { message: "Unauthorized" } },
      { status: 401 },
    )).fn);
    const { message } = await runStream(adapter, { messages: [] });
    expect(message.errorMessage).not.toContain("Agent 连接");
    expect(message.errorMessage).toContain("鉴权失败（401）");
  });

  it("带 label 的适配器：流内上游错误 chunk 同样带前缀", async () => {
    const adapter = makeAdapter(
      { label: "本地 vLLM" },
      mockFetch(() => sseResponse([
        sseEvent({ error: { message: "context length exceeded" } }),
      ])).fn,
    );
    const { message } = await runStream(adapter, { messages: [] });
    expect(message.errorMessage).toContain("Agent 连接 [本地 vLLM]");
    expect(message.errorMessage).toContain("context length exceeded");
  });
});

describe("createAgentConnectionLlmPort（ADR 0010：Agent 连接端口工厂）", () => {
  function fakeContext(overrides: Partial<StContext> = {}): StContext {
    return {
      chatId: "story",
      chatCompletionSettings: {
        chat_completion_source: "openai",
        temp_openai: 0.7,
        openai_max_tokens: 1024,
        openai_max_context: 8192,
      },
      getChatCompletionModel: () => "gpt-4o",
      ...overrides,
    };
  }

  it("端口模型带连接信息：模型名/URL/Key + ST 快照参数", () => {
    const port = createAgentConnectionLlmPort(
      { id: "c1", name: "DeepSeek 主用", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-1", model: "deepseek-chat" },
      () => fakeContext(),
    );
    expect(port.model.id).toBe("deepseek-chat");
    expect((port.model as StBackendsModel).stSource).toBe("openai");
    expect((port.model as StBackendsModel).reverseProxy).toBe("https://api.deepseek.com/v1");
    expect((port.model as StBackendsModel).proxyPassword).toBe("sk-1");
    // 生成参数仍来自 ST 快照（决策 Q6：连接不覆盖参数）
    expect(port.model.contextWindow).toBe(8192);
    expect(port.model.maxTokens).toBe(1024);
    expect(typeof port.streamFn).toBe("function");
  });

  it("URL 规范化在工厂完成：粘贴完整 /chat/completions 地址不双拼", () => {
    const port = createAgentConnectionLlmPort(
      { id: "c1", name: "x", baseUrl: "https://api.deepseek.com/v1/chat/completions/", apiKey: "sk-1", model: "m" },
      () => fakeContext(),
    );
    expect((port.model as StBackendsModel).reverseProxy).toBe("https://api.deepseek.com/v1");
  });

  it("无 key 连接：proxyPassword 为空串（ST 侧不产生 undefined 头）", () => {
    const port = createAgentConnectionLlmPort(
      { id: "c1", name: "本地", baseUrl: "http://127.0.0.1:8000/v1", apiKey: "", model: "local-model" },
      () => fakeContext(),
    );
    expect((port.model as StBackendsModel).proxyPassword).toBe("");
  });

  it("streamFn 跑通：请求体带 reverse_proxy/proxy_password（同源代理 reverse_proxy 路径）", async () => {
    const fetchMock = mockFetch(() => sseResponse([sseEvent(textChunk("好", "stop"))]));
    const port = createAgentConnectionLlmPort(
      { id: "c1", name: "DeepSeek 主用", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-1", model: "deepseek-chat" },
      () => fakeContext(),
      { fetchImpl: fetchMock.fn, getCsrfToken: async () => "t" },
    );
    const stream = await port.streamFn(port.model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] });
    const message = await stream.result();
    expect(message.stopReason).toBe("stop");
    expect(fetchMock.calls[0]!.url).toBe(ST_GENERATE_ENDPOINT);
    const body = JSON.parse(fetchMock.calls[0]!.init?.body as string);
    expect(body.reverse_proxy).toBe("https://api.deepseek.com/v1");
    expect(body.proxy_password).toBe("sk-1");
    expect(body.model).toBe("deepseek-chat");
    expect(body.chat_completion_source).toBe("openai");
  });

  it("ST 生成源未知时仍可构造：连接自带 URL/Key/模型，参数用 ST 默认值兜底", () => {
    const port = createAgentConnectionLlmPort(
      { id: "c1", name: "x", baseUrl: "https://x", apiKey: "", model: "m" },
      () => fakeContext({ chatCompletionSettings: {} }),
    );
    expect(port.model.id).toBe("m");
    expect((port.model as StBackendsModel).reverseProxy).toBe("https://x");
    // ST 未配置时的兜底默认值（openai_max_context 缺失 → 4096）
    expect(port.model.contextWindow).toBe(4096);
  });

  it("连接缺模型名 → 报错指向连接本身（而非误导性 ST 提示）", () => {
    expect(() =>
      createAgentConnectionLlmPort(
        { id: "c1", name: "DeepSeek 主用", baseUrl: "https://api.deepseek.com/v1", apiKey: "", model: "" },
        () => fakeContext(),
      ),
    ).toThrow(/Agent 连接 \[DeepSeek 主用\].*模型/);
  });

  it("连接缺 Base URL → 报错指向连接本身", () => {
    expect(() =>
      createAgentConnectionLlmPort(
        { id: "c1", name: "DeepSeek 主用", baseUrl: "", apiKey: "", model: "m" },
        () => fakeContext(),
      ),
    ).toThrow(/Agent 连接 \[DeepSeek 主用\].*URL/);
  });
});
