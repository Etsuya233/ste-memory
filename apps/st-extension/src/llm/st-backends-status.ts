import {
  agentConnectionLabel,
  buildStatusTestRequest,
  sortModelIds,
  type AgentConnection,
} from "../settings/agent-connections.ts";
import { defaultGetCsrfToken } from "./st-backends-llm.ts";

/** ST backends status 端点（测试连接/模型列表：POST /api/backends/chat-completions/status） */
export const ST_STATUS_ENDPOINT = "/api/backends/chat-completions/status";

export type ConnectionTestResult =
  | { readonly ok: true; readonly models: readonly string[] }
  | { readonly ok: false; readonly error: string };

export interface StBackendsStatusAdapterOptions {
  /** fetch 实现；缺省 = globalThis.fetch（测试注入 mock） */
  readonly fetchImpl?: typeof fetch;
  /** CSRF 令牌获取；缺省 = GET /csrf-token（每次调用重取，测试按钮低频无缓存必要） */
  readonly getCsrfToken?: () => Promise<string | undefined>;
}

/**
 * 测试 Agent 连接（ADR 0010）：复用 ST 同源 status 端点（零 token 成本）验证
 * URL/Key 并拉取模型列表。成功 → 模型 id 列表（字典序）；失败 → 可读中文错误，
 * 带连接名前缀且保留原始错误（HTTP 状态 + 上游 message），绝不吞信息。
 */
export async function testAgentConnection(
  connection: AgentConnection,
  options: StBackendsStatusAdapterOptions = {},
): Promise<ConnectionTestResult> {
  const fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  const label = agentConnectionLabel(connection.name);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    try {
      const token = options.getCsrfToken
        ? await options.getCsrfToken()
        : await defaultGetCsrfToken(fetchImpl);
      if (token && token !== "disabled") headers["X-CSRF-Token"] = token;
    } catch {
      // 取令牌失败：不带 CSRF 头继续（ST 关闭 CSRF 时无头也能过）
    }
    const response = await fetchImpl(ST_STATUS_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(buildStatusTestRequest(connection)),
    });
    const raw = await safeText(response);
    const detail = parseErrorDetail(raw);
    if (!response.ok) {
      return {
        ok: false,
        error: `${label}：连接测试失败（${response.status}）${suffix(detail.message ?? raw)}`,
      };
    }
    // ST /status 对上游失败（密钥错误/端点不可达）返回 HTTP 200 + { error: true }，
    // 必须显式识别——否则误报「连接成功，拉取到 0 个模型」
    if (detail.upstreamError) {
      return {
        ok: false,
        error: `${label}：连接测试失败（上游错误）——检查 API Key 是否正确、端点是否可达${suffix(detail.message)}`,
      };
    }
    const models = parseModelIds(raw);
    if (models === undefined) {
      return { ok: false, error: `${label}：连接测试返回的数据不是模型列表` };
    }
    return { ok: true, models: sortModelIds(models) };
  } catch (error) {
    return {
      ok: false,
      error: `${label}：连接测试失败（网络错误）：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** 从 status 响应体抽取模型 id 列表；形状不符返回 undefined */
function parseModelIds(raw: string): string[] | undefined {
  try {
    const data = JSON.parse(raw) as { data?: unknown };
    if (!Array.isArray(data.data)) return undefined;
    const ids: string[] = [];
    for (const item of data.data) {
      if (
        typeof item === "object" &&
        item !== null &&
        typeof (item as { id?: unknown }).id === "string"
      ) {
        ids.push((item as { id: string }).id);
      }
    }
    return ids;
  } catch {
    return undefined;
  }
}

function parseErrorDetail(raw: string): { message?: string; upstreamError?: boolean } {
  try {
    const data = JSON.parse(raw) as { error?: unknown; data?: unknown };
    return {
      message:
        typeof data.error === "object" && data.error !== null
          ? (data.error as { message?: unknown }).message
            ? String((data.error as { message: unknown }).message)
            : undefined
          : undefined,
      upstreamError: data.error === true || typeof data.error === "object",
    };
  } catch {
    return {};
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function suffix(detail: string | undefined): string {
  return detail ? `：${detail}` : "";
}
