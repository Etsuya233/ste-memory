import { describe, expect, it, vi } from "vitest";
import {
  ST_STATUS_ENDPOINT,
  testAgentConnection,
  type StBackendsStatusAdapterOptions,
} from "./st-backends-status.ts";
import type { AgentConnection } from "../settings/agent-connections.ts";

function connection(overrides: Partial<AgentConnection> = {}): AgentConnection {
  return {
    id: "c1",
    name: "DeepSeek 主用",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-1",
    model: "deepseek-chat",
    ...overrides,
  };
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

function makeOptions(
  fetchFn: typeof fetch,
  overrides: Partial<StBackendsStatusAdapterOptions> = {},
) {
  return { fetchImpl: fetchFn, getCsrfToken: async () => "csrf-abc", ...overrides };
}

describe("testAgentConnection（测试连接：POST /api/backends/chat-completions/status）", () => {
  it("成功：返回模型列表（字典序排序）", async () => {
    const fetchMock = mockFetch(() =>
      jsonResponse({ data: [{ id: "gpt-4o" }, { id: "deepseek-chat" }, { id: "gpt-4o-mini" }] }),
    );
    const result = await testAgentConnection(connection(), makeOptions(fetchMock.fn));
    expect(result).toEqual({ ok: true, models: ["deepseek-chat", "gpt-4o", "gpt-4o-mini"] });
  });

  it("请求形状：同源 status 端点 + openai source + 规范化 reverse_proxy + proxy_password", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ data: [] }));
    await testAgentConnection(
      connection({ baseUrl: "https://api.deepseek.com/v1/chat/completions/", apiKey: "sk-1" }),
      makeOptions(fetchMock.fn),
    );
    expect(fetchMock.calls[0]!.url).toBe(ST_STATUS_ENDPOINT);
    const headers = fetchMock.calls[0]!.init?.headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBe("csrf-abc");
    const body = JSON.parse(fetchMock.calls[0]!.init?.body as string);
    expect(body).toEqual({
      chat_completion_source: "openai",
      reverse_proxy: "https://api.deepseek.com/v1",
      proxy_password: "sk-1",
    });
  });

  it("失败（401 带错误体）：错误带连接名前缀 + 状态码 + 原始 message（不吞信息）", async () => {
    const fetchMock = mockFetch(() =>
      jsonResponse({ error: { message: "Invalid API key provided" } }, { status: 401 }),
    );
    const result = await testAgentConnection(connection(), makeOptions(fetchMock.fn));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Agent 连接 [DeepSeek 主用]");
      expect(result.error).toContain("401");
      expect(result.error).toContain("Invalid API key provided");
    }
  });

  it("失败（HTTP 错误但无可解析错误体）：状态码 + 状态文本", async () => {
    const fetchMock = mockFetch(() => new Response("Bad Gateway", { status: 502 }));
    const result = await testAgentConnection(connection(), makeOptions(fetchMock.fn));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("502");
  });

  it("ST 上游失败（HTTP 200 + {error:true}）：识别为失败而非「成功 0 个模型」", async () => {
    // ST /status 对上游失败（密钥错误/端点不可达）返回 200 + { error: true, data: { data: [] } }
    const fetchMock = mockFetch(() => jsonResponse({ error: true, data: { data: [] } }));
    const result = await testAgentConnection(connection(), makeOptions(fetchMock.fn));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Agent 连接 [DeepSeek 主用]");
      expect(result.error).toContain("上游错误");
    }
    // 网络异常形状 { error: true } 同样识别
    const bare = mockFetch(() => jsonResponse({ error: true }));
    const bareResult = await testAgentConnection(connection(), makeOptions(bare.fn));
    expect(bareResult.ok).toBe(false);
  });

  it("失败（200 但响应体非模型列表）：明确报错不吞", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ weird: true }));
    const result = await testAgentConnection(connection(), makeOptions(fetchMock.fn));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Agent 连接 [DeepSeek 主用]");
  });

  it("网络错误（fetch 抛 TypeError）：不抛异常，错误可读", async () => {
    const fetchMock = mockFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const result = await testAgentConnection(connection(), makeOptions(fetchMock.fn));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Failed to fetch");
    }
  });

  it("CSRF 令牌取不到或 disabled：不带 X-CSRF-Token 继续（ST 关闭 CSRF 时）", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ data: [] }));
    const getCsrfToken = vi.fn(async () => "disabled");
    await testAgentConnection(connection(), makeOptions(fetchMock.fn, { getCsrfToken }));
    const headers = fetchMock.calls[0]!.init?.headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBeUndefined();
  });
});
