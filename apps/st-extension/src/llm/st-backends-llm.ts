import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type SimpleStreamOptions,
  type TextContent,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { LlmPort } from "@ste-memory/core/memory/agent";
import type { StContext } from "../st/st-chat-adapter.ts";
import { PLUGIN_DISPLAY_NAME } from "../constants.ts";
import {
  createStBackendsModel,
  readStChatCompletionConfig,
  type StBackendsModel,
  type StChatCompletionConfig,
} from "./st-completion-settings.ts";
import { buildStGenerateBody } from "./st-backends-request.ts";
import { SseEventParser } from "./sse-parse.ts";

/**
 * LLM 适配器（ticket 12）：pi `StreamFn` 的 ST backends 同源代理实现。
 *
 * - 请求：`POST /api/backends/chat-completions/generate`（未文档化内部 API，
 *   chat-completions.js:2157，契约集中隔离在本模块 + st-backends-request），
 *   同源无 CORS，CSRF 头经 `GET /csrf-token` 获取（script.js 客户端同法）；
 * - 模型与密钥复用 ST 当前配置：模型名来自 ST getChatCompletionModel 映射，
 *   密钥在 ST 服务端 secret store，插件永远不见 key；
 * - 流式：上游 SSE 经 ST 原样透传（util.js forwardFetchResponse）——解析
 *   OpenAI chat-completions 增量格式（delta.content / delta.tool_calls /
 *   finish_reason / [DONE]），转为 pi 事件协议；
 * - 错误：HTTP 错误/限流/断流/超时/取消均以 pi 事件流编码（stopReason
 *   "error" | "aborted" + errorMessage），绝不抛异常（StreamFn 契约）。
 *
 * 已知取舍（记录在案）：`include_reasoning: false` 固定——v1 不解析思考流
 * （delta.thinking / reasoning_content），上游思考段被忽略；usage 恒为 0
 * （ST 流不透出用量）。
 */

/** ST backends 同源代理端点（server-startup.js:180 挂载 + chat-completions.js:2157 路由） */
export const ST_GENERATE_ENDPOINT = "/api/backends/chat-completions/generate";
/** CSRF 令牌端点（server-main.js:192/205：启用返回 token，关闭返回 'disabled'） */
export const ST_CSRF_ENDPOINT = "/csrf-token";

/** 单次生成整体超时缺省（agent 设计文档：5 分钟） */
export const DEFAULT_ST_GENERATE_TIMEOUT_MS = 300_000;

export interface StBackendsLlmAdapterOptions {
  /** ST 当前对话生成配置快照（createStLlmPort 构造时读取一次） */
  readonly config: StChatCompletionConfig;
  /** fetch 实现；缺省 = globalThis.fetch（测试注入 mock） */
  readonly fetchImpl?: typeof fetch;
  /** CSRF 令牌获取；缺省 = GET /csrf-token（结果缓存，401/403 后清缓存重取） */
  readonly getCsrfToken?: () => Promise<string | undefined>;
  /** 单次生成整体超时（毫秒）；缺省 5 分钟；options.timeoutMs 优先 */
  readonly timeoutMs?: number;
  /** 时钟；缺省 = Date.now（测试注入固定值） */
  readonly now?: () => number;
  readonly log?: Pick<Console, "warn" | "error">;
}

/** 零用量（ST 流不透出 token 用量，恒 0；pi AssistantMessage.usage 必填） */
const ZERO_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 流内工具调用累积块（partialArgs 是流式草稿，终态剥离） */
interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  partialArgs: string;
}

function tryParseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class StBackendsLlmAdapter {
  readonly #options: StBackendsLlmAdapterOptions & {
    readonly fetchImpl: typeof fetch;
    readonly timeoutMs: number;
    readonly now: () => number;
  };
  /** CSRF 令牌缓存：undefined = 未获取/获取失败（下次重试）；'disabled' = ST 关闭 CSRF */
  #csrfToken: string | undefined;

  constructor(options: StBackendsLlmAdapterOptions) {
    this.#options = {
      ...options,
      fetchImpl: options.fetchImpl ?? ((...args) => fetch(...args)),
      timeoutMs: options.timeoutMs ?? DEFAULT_ST_GENERATE_TIMEOUT_MS,
      now: options.now ?? (() => Date.now()),
    };
  }

  /** pi StreamFn 契约：同步返回事件流，所有失败编码进流内，绝不抛异常 */
  readonly streamFn: StreamFn = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void this.#run(model as StBackendsModel, context, options, stream);
    return stream;
  };

  async #run(
    model: StBackendsModel,
    context: Context,
    options: SimpleStreamOptions | undefined,
    stream: AssistantMessageEventStream,
  ): Promise<void> {
    const output = this.#createOutput(model);
    const timeoutMs = options?.timeoutMs ?? this.#options.timeoutMs;    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      // signal 在调用前已 abort（如上层超时/取消竞态）：once 监听器不会触发，这里显式检查
      if (options?.signal?.aborted) throw new Error("请求已取消");
      if (typeof model.stSource !== "string" || model.stSource === "") {
        throw new Error("模型缺少 ST 生成源信息（stSource）——请经 createStLlmPort 构造 LLM 端口");
      }
      if (model.id === "") {
        throw new Error("ST 未配置当前生成源的模型——请在 ST 的 API 连接中检查模型选择");
      }

      const body = buildStGenerateBody(model, context, options, this.#options.config);
      const response = await this.#options.fetchImpl(ST_GENERATE_ENDPOINT, {
        method: "POST",
        headers: await this.#requestHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        // 会话/CSRF 失效：令牌可能已轮换，清缓存下次重取
        if (response.status === 401 || response.status === 403) this.#csrfToken = undefined;
        throw new Error(await this.#httpErrorMessage(response));
      }

      stream.push({ type: "start", partial: output });

      const reader = response.body?.getReader();
      if (!reader) throw new Error("ST 代理响应没有可读流");
      const decoder = new TextDecoder("utf-8");
      const parser = new SseEventParser();
      const handler = new StreamEventHandler(output, (event) => stream.push(event), model.id);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const data of parser.push(decoder.decode(value, { stream: true }))) {
          handler.process(data);
        }
      }
      // 多字节字符跨块边界 + 残留缓冲：冲刷
      for (const data of parser.push(decoder.decode())) {
        handler.process(data);
      }
      for (const data of parser.finish()) {
        handler.process(data);
      }

      // 终态：先收尾所有内容块（text_end / toolcall_end），再决定 done/error
      handler.finalize();

      if (options?.signal?.aborted) throw new Error("请求已取消");
      if (timedOut) throw new Error(`生成超时（${Math.round(timeoutMs / 1000)}s）`);
      if (output.stopReason === "error") {
        throw new Error(output.errorMessage ?? "上游返回错误");
      }
      if (handler.hasFinishReason) {
        const reason = (output.stopReason === "pending" ? "stop" : output.stopReason) as
          | "stop"
          | "length"
          | "toolUse";
        stream.push({ type: "done", reason, message: output });
        stream.end();
        return;
      }
      if (handler.doneSentinel) {
        // 兼容未带 finish_reason 的 [DONE]（ST 客户端同法：直接结束）
        output.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message: output });
        stream.end();
        return;
      }
      // 流结束但既无 finish_reason 也无 [DONE]：断流
      throw new Error("响应流意外中断（未收到完成标记）");
    } catch (error) {
      const aborted = options?.signal?.aborted === true;
      output.stopReason = aborted || timedOut ? "aborted" : "error";
      output.errorMessage =
        aborted ? "请求已取消" :
        timedOut ? `生成超时（${Math.round(timeoutMs / 1000)}s）` :
        errorMessageOf(error);
      this.#options.log?.error?.(`[${PLUGIN_DISPLAY_NAME}] LLM 生成失败：${output.errorMessage}`);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
    }
  }

  #createOutput(model: StBackendsModel): AssistantMessage {
    return {
      role: "assistant",
      content: [],
      // 防御：模型对象缺失/畸形时也不抛（StreamFn 契约：一切失败编码进事件流）
      api: model?.api ?? "openai-completions",
      provider: model?.provider ?? "sillytavern",
      model: model?.id ?? "",
      usage: ZERO_USAGE,
      stopReason: "pending",
      timestamp: this.#options.now(),
    };
  }

  /** 请求头：Content-Type + CSRF（getRequestHeaders() 同款；'disabled'/缺失时不带） */
  async #requestHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.#csrfToken === undefined) {
      try {
        const token = this.#options.getCsrfToken
          ? await this.#options.getCsrfToken()
          : await defaultGetCsrfToken(this.#options.fetchImpl);
        if (token !== undefined) this.#csrfToken = token;
      } catch {
        // 取令牌失败：不缓存，下次重试；不带 CSRF 头继续（ST 关闭 CSRF 时无头也能过）
        return headers;
      }
    }
    const token = this.#csrfToken;
    if (token && token !== "disabled") headers["X-CSRF-Token"] = token;
    return headers;
  }

  /** HTTP 错误 → 人可读中文信息（ST 错误体 {error:{message}}，429 带 quota_error） */
  async #httpErrorMessage(response: Response): Promise<string> {
    const raw = await safeText(response);
    const detail = parseErrorDetail(raw);
    switch (response.status) {
      case 401:
        return `ST 会话鉴权失败（401）——登录状态失效，请刷新页面后重试${suffix(detail.message)}`;
      case 403:
        return `请求被 ST 拒绝（403）——CSRF 令牌无效，请刷新页面后重试${suffix(detail.message)}`;
      case 429:
        return `${detail.quota ? "模型额度不足" : "请求被限流"}（429）${suffix(detail.message)}`;
      case 502:
      case 504:
        return `ST 代理上游错误（${response.status}）${suffix(detail.message)}`;
      default:
        return `ST 代理请求失败（${response.status}）${suffix(detail.message ?? raw)}`;
    }
  }
}

/**
 * SSE data 负载 → pi 事件（纯增量抽取）：
 * - `choices[0].delta.content` → 文本块（text_start/text_delta）；
 * - `choices[0].delta.tool_calls[]` → 工具调用块（toolcall_start/toolcall_delta），
 *   按 index 累积，arguments 增量 JSON 解析（终态解析失败 → 保留最后一次成功值）；
 * - `choices[0].finish_reason` → stopReason 映射；
 * - `[DONE]` 哨兵 → doneSentinel。
 */
class StreamEventHandler {
  readonly #output: AssistantMessage;
  readonly #push: (event: AssistantMessageEvent) => void;
  readonly #modelId: string;
  #textBlock: TextContent | null = null;
  readonly #toolCallBlocks = new Map<number, ToolCallBlock>();
  hasFinishReason = false;
  doneSentinel = false;

  constructor(output: AssistantMessage, push: (event: AssistantMessageEvent) => void, modelId: string) {
    this.#output = output;
    this.#push = push;
    this.#modelId = modelId;
  }

  process(data: string): void {
    if (data === "[DONE]") {
      this.doneSentinel = true;
      return;
    }
    if (data === "") return;
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      throw new Error(`SSE 数据解析失败：${data.length > 200 ? `${data.slice(0, 200)}…` : data}`);
    }
    if (typeof chunk !== "object" || chunk === null) return;
    const payload = chunk as Record<string, unknown>;
    // 上游在流中报错（OpenAI 流式错误形状 {"error":{...}}，ST 客户端 tryParseStreamingError 同查）：
    // 不能静默丢弃——否则会误报成「响应流意外中断」，丢失真实原因
    if (payload.error) {
      const error = payload.error as Record<string, unknown>;
      const message = typeof error.message === "string" && error.message ? error.message : "";
      throw new Error(message ? `上游返回错误：${message}` : `上游返回错误：${data.slice(0, 200)}`);
    }
    if (typeof payload.id === "string") this.#output.responseId ||= payload.id;
    if (typeof payload.model === "string" && payload.model && payload.model !== this.#modelId) {
      this.#output.responseModel ||= payload.model;
    }
    const choice = Array.isArray(payload.choices)
      ? (payload.choices[0] as Record<string, unknown> | undefined)
      : undefined;
    if (!choice) return;
    const finishReason = choice.finish_reason;
    if (typeof finishReason === "string" && finishReason) {
      this.hasFinishReason = true;
      const mapped = mapFinishReason(finishReason);
      this.#output.stopReason = mapped.stopReason;
      if (mapped.errorMessage) this.#output.errorMessage = mapped.errorMessage;
    }
    const delta = choice.delta as Record<string, unknown> | undefined;
    if (delta && typeof delta.content === "string" && delta.content.length > 0) {
      this.#appendText(delta.content);
    }
    if (delta && Array.isArray(delta.tool_calls)) {
      for (const rawCall of delta.tool_calls) {
        if (typeof rawCall !== "object" || rawCall === null) continue;
        this.#appendToolCall(rawCall as Record<string, unknown>);
      }
    }
  }

  /** 流终态：剥离流式草稿字段 + 为所有内容块补发收尾事件（text_end / toolcall_end） */
  finalize(): void {
    for (const block of this.#output.content) {
      if (block.type === "toolCall") {
        // 流式草稿字段剥离（类型经 unknown 中转：delete 只接受可选属性）
        delete (block as unknown as { partialArgs?: string }).partialArgs;
      }
      const contentIndex = this.#output.content.indexOf(block);
      if (block.type === "text") {
        this.#push({ type: "text_end", contentIndex, content: block.text, partial: this.#output });
      } else if (block.type === "toolCall") {
        this.#push({
          type: "toolcall_end",
          contentIndex,
          toolCall: {
            type: "toolCall",
            id: block.id,
            name: block.name,
            arguments: block.arguments,
          },
          partial: this.#output,
        });
      }
    }
  }

  #appendText(delta: string): void {
    let block = this.#textBlock;
    if (!block) {
      block = { type: "text", text: "" };
      this.#output.content.push(block);
      this.#textBlock = block;
      this.#push({ type: "text_start", contentIndex: this.#output.content.indexOf(block), partial: this.#output });
    }
    block.text += delta;
    this.#push({
      type: "text_delta",
      contentIndex: this.#output.content.indexOf(block),
      delta,
      partial: this.#output,
    });
  }

  #appendToolCall(call: Record<string, unknown>): void {
    const index = typeof call.index === "number" ? call.index : 0;
    const fn = (call.function ?? {}) as Record<string, unknown>;
    let block = this.#toolCallBlocks.get(index);
    if (!block) {
      block = {
        type: "toolCall",
        id: typeof call.id === "string" ? call.id : "",
        name: typeof fn.name === "string" ? fn.name : "",
        arguments: {},
        partialArgs: "",
      };
      this.#toolCallBlocks.set(index, block);
      this.#output.content.push(block);
      this.#push({
        type: "toolcall_start",
        contentIndex: this.#output.content.indexOf(block),
        partial: this.#output,
      });
    }
    if (typeof call.id === "string" && call.id && !block.id) block.id = call.id;
    if (typeof fn.name === "string" && fn.name && !block.name) block.name = fn.name;
    if (typeof fn.arguments === "string" && fn.arguments) {
      block.partialArgs += fn.arguments;
      const parsed = tryParseJson(block.partialArgs);
      if (parsed !== undefined) block.arguments = parsed;
      this.#push({
        type: "toolcall_delta",
        contentIndex: this.#output.content.indexOf(block),
        delta: fn.arguments,
        partial: this.#output,
      });
    }
  }
}

/** OpenAI finish_reason → pi stopReason（与 pi openai-completions mapStopReason 同语义） */
function mapFinishReason(reason: string): { stopReason: AssistantMessage["stopReason"]; errorMessage?: string } {
  switch (reason) {
    case "stop":
    case "end":
      return { stopReason: "stop" };
    case "length":
      return { stopReason: "length" };
    case "function_call":
    case "tool_calls":
      return { stopReason: "toolUse" };
    case "content_filter":
      return { stopReason: "error", errorMessage: "上游返回 content_filter（内容被过滤）" };
    default:
      return { stopReason: "error", errorMessage: `上游返回未知 finish_reason：${reason}` };
  }
}

/** 缺省 CSRF 获取：GET /csrf-token（与 ST 客户端 script.js firstLoadInit 同法） */
async function defaultGetCsrfToken(fetchImpl: typeof fetch): Promise<string | undefined> {
  const response = await fetchImpl(ST_CSRF_ENDPOINT);
  if (!response.ok) return undefined;
  const data = (await response.json()) as { token?: unknown };
  return typeof data.token === "string" ? data.token : undefined;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function parseErrorDetail(raw: string): { message?: string; quota?: boolean } {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as {
      error?: { message?: unknown; type?: unknown; code?: unknown };
      quota_error?: unknown;
    };
    return {
      message: typeof data.error?.message === "string" ? data.error.message : undefined,
      // 流式错误路径 ST 原样转发上游 body（无 quota_error 包装），需同时认
      // OpenAI 系错误的 type/code = insufficient_quota（chat-completions.js 非流式同款判定）
      quota:
        data.quota_error === true ||
        data.error?.type === "insufficient_quota" ||
        data.error?.code === "insufficient_quota",
    };
  } catch {
    return {};
  }
}

function suffix(detail: string | undefined): string {
  return detail ? `：${detail}` : "";
}

/**
 * 构造插件 LLM 端口（core LlmPort）：读 ST 当前配置一次（模型 + 生成参数快照），
 * 之后的 streamFn 是纯函数（model, context, options）。任务开始时调用一次
 * （ticket 13 的填表任务），ST 配置变更在下次任务生效。
 */
export function createStLlmPort(
  getContext: () => StContext,
  options: Omit<StBackendsLlmAdapterOptions, "config"> = {},
): LlmPort {
  const config = readStChatCompletionConfig(getContext());
  if (!config.source) {
    throw new Error("ST 当前 Chat Completion 源未知——请在 ST 的 API 连接中配置 Chat Completion");
  }
  if (!config.modelName) {
    throw new Error("ST 当前生成源未配置模型——请在 ST 的 API 连接中检查模型选择");
  }
  const adapter = new StBackendsLlmAdapter({ ...options, config });
  return {
    model: createStBackendsModel(config),
    streamFn: adapter.streamFn,
  };
}
