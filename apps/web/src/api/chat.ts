import { API_URL, responseJson } from "./http.ts";

// ---------------------------------------------------------------------------
// 类型（与服务端 ChatEvent / llm-config 协议一一对应）
// ---------------------------------------------------------------------------

export interface ChatHistoryMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/** 网页 LLM 配置；空字符串 = 未填写（服务端逐字段回退环境变量）。 */
export interface LlmWebConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
}

/** GET /llm-config：服务端环境回退信息（不含 API Key 值，只有存在性布尔）。 */
export interface LlmConfigInfo {
  readonly env: Readonly<{
    readonly baseUrl: string | null;
    readonly model: string | null;
    readonly apiKeyConfigured: boolean;
  }>;
}

export type ChatEvent =
  | { readonly type: "thinking_delta"; readonly text: string }
  | { readonly type: "message_delta"; readonly text: string }
  | {
      readonly type: "tool_start";
      readonly callId: string;
      readonly name: string;
      readonly args: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly callId: string;
      readonly name: string;
      readonly result: unknown;
      readonly isError: boolean;
    }
  | { readonly type: "done"; readonly stopReason: string; readonly errorMessage: string | null }
  | { readonly type: "error"; readonly message: string };

export class ChatHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ChatHttpError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

export async function fetchLlmConfigInfo(): Promise<LlmConfigInfo> {
  return responseJson(await fetch(`${API_URL}/llm-config`));
}

/**
 * SSE 流式对话：解析 data 行并逐条回调 onEvent。
 * - 非 2xx：抛 ChatHttpError（预检错误，如配置缺失/空间不存在）；
 * - 网络错误：包装为可读信息抛出；
 * - 取消：signal.abort() 后抛 AbortError（调用方按 signal.aborted 区分）。
 */
export async function streamChat(
  spaceId: string,
  messages: readonly ChatHistoryMessage[],
  config: LlmWebConfig,
  signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/memory-spaces/${spaceId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages, config }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(
      `网络错误：无法连接 API 服务（${error instanceof Error ? error.message : String(error)}）`,
      { cause: error },
    );
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { message?: string } | undefined;
    throw new ChatHttpError(response.status, body?.message ?? `HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("浏览器不支持流式读取响应");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).trimEnd();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice("data:".length).trim();
        if (data.length === 0) continue;
        try {
          onEvent(JSON.parse(data) as ChatEvent);
        } catch {
          throw new Error("服务端返回了无法解析的流数据");
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// 非敏感配置的浏览器本地持久化（baseUrl/model 可保存；API Key 绝不落盘）
// ---------------------------------------------------------------------------

const LLM_CONFIG_STORAGE_KEY = "ste-memory.llm-config";

export function loadPersistedLlmConfig(): { baseUrl: string; model: string } {
  try {
    const raw = localStorage.getItem(LLM_CONFIG_STORAGE_KEY);
    if (!raw) return { baseUrl: "", model: "" };
    const parsed = JSON.parse(raw) as { baseUrl?: unknown; model?: unknown };
    return {
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
      model: typeof parsed.model === "string" ? parsed.model : "",
    };
  } catch {
    return { baseUrl: "", model: "" };
  }
}

export function savePersistedLlmConfig(config: { baseUrl: string; model: string }): void {
  try {
    localStorage.setItem(LLM_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // 隐私模式等场景写入失败时静默忽略：配置仍在页面内存中可用
  }
}
