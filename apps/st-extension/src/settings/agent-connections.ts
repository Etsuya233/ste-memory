/**
 * Agent 连接纯逻辑模型（ADR 0010 / spec .scratch/agent-connections）：命名
 * LLM 连接池（Base URL + API Key + 模型名）+ 每 Agent 的选择（跟随 ST 当前
 * 连接 / 某连接）。全部为纯函数，settings 不可变更新；id 由调用方注入
 * （宿主 = runtime 的 createId 工厂 / UI 层 createUiId）。
 *
 * 语义约定：fillTaskConnectionId / queryChatConnectionId 为 undefined =
 * 跟随 ST 当前连接（默认行为，未配置自定义连接时与旧版完全一致）。
 */
import type { PluginSettings } from "./plugin-settings.ts";

/** 一个命名的 Agent LLM 连接（自定义 API 的配置单元） */
export interface AgentConnection {
  readonly id: string;
  /** 展示名（错误消息前缀与 UI 选择器使用） */
  readonly name: string;
  /** 上游 base URL（如 https://api.deepseek.com/v1；发送前经 normalizeBaseUrl） */
  readonly baseUrl: string;
  /** API Key（明文存插件设置，ADR 0010 权衡；空 = 无鉴权本地服务） */
  readonly apiKey: string;
  /** 模型名（手写或从服务拉取的 Select 选择） */
  readonly model: string;
}

/** Agent 连接的目标 Agent：设置键用途的稳定字符串 */
export type AgentConnectionTarget = "fillTask" | "queryChat";

/** 两个 Agent 目标（UI 选择器与运行时分流共用） */
export const AGENT_CONNECTION_TARGETS: readonly AgentConnectionTarget[] = ["fillTask", "queryChat"];

/** 目标 → 设置键（选中读取/写入共用，单一来源） */
const TARGET_SETTING_KEY: Record<
  AgentConnectionTarget,
  "fillTaskConnectionId" | "queryChatConnectionId"
> = {
  fillTask: "fillTaskConnectionId",
  queryChat: "queryChatConnectionId",
};

/** Agent 连接错误/展示前缀（适配器与测试连接共用，防措辞漂移） */
export function agentConnectionLabel(name: string): string {
  return `Agent 连接 [${name}]`;
}

/** 某 Agent 当前的连接选择 id（undefined = 跟随 ST 当前连接） */
export function agentConnectionSelection(
  settings: PluginSettings,
  target: AgentConnectionTarget,
): string | undefined {
  return settings[TARGET_SETTING_KEY[target]];
}

/** 新建/覆盖连接：id 已存在原地替换（顺序不变），否则追加到末尾。 */
export function upsertAgentConnection(
  settings: PluginSettings,
  connection: AgentConnection,
): PluginSettings {
  const exists = settings.agentConnections.some((c) => c.id === connection.id);
  return {
    ...settings,
    agentConnections: exists
      ? settings.agentConnections.map((c) => (c.id === connection.id ? connection : c))
      : [...settings.agentConnections, connection],
  };
}

/**
 * 删除连接；被删连接正被某 Agent 选中时该 Agent 回退跟随 ST（undefined），
 * 不残留悬空引用。未知 id 原样返回。
 */
export function removeAgentConnection(
  settings: PluginSettings,
  connectionId: string,
): PluginSettings {
  if (!settings.agentConnections.some((c) => c.id === connectionId)) return settings;
  return {
    ...settings,
    agentConnections: settings.agentConnections.filter((c) => c.id !== connectionId),
    fillTaskConnectionId:
      settings.fillTaskConnectionId === connectionId ? undefined : settings.fillTaskConnectionId,
    queryChatConnectionId:
      settings.queryChatConnectionId === connectionId ? undefined : settings.queryChatConnectionId,
  };
}

/**
 * 设置某 Agent 的连接选择；connectionId = undefined 清除选择（回退跟随 ST）。
 * 未知 id 原样返回（不产生悬空引用）。
 */
export function setAgentConnection(
  settings: PluginSettings,
  target: AgentConnectionTarget,
  connectionId: string | undefined,
): PluginSettings {
  if (connectionId !== undefined && !settings.agentConnections.some((c) => c.id === connectionId)) {
    return settings;
  }
  return { ...settings, [TARGET_SETTING_KEY[target]]: connectionId };
}

/** 运行时分流读取：选中且存在的连接，否则 undefined（跟随 ST 当前连接）。 */
export function resolveAgentConnection(
  settings: PluginSettings,
  target: AgentConnectionTarget,
): AgentConnection | undefined {
  const id = agentConnectionSelection(settings, target);
  if (id === undefined) return undefined;
  return settings.agentConnections.find((c) => c.id === id);
}

/**
 * 发送前 URL 规范化（ST 服务端固定拼 `${base}/chat/completions`）：
 * 修剪空白 → 剥尾部斜杠 → 剥尾部 /chat/completions（防用户粘贴完整地址双拼）→ 再剥斜杠。
 */
export function normalizeBaseUrl(url: string): string {
  let result = url.trim();
  while (result.endsWith("/")) result = result.slice(0, -1);
  if (/\/chat\/completions$/i.test(result)) {
    result = result.slice(0, -"/chat/completions".length);
    while (result.endsWith("/")) result = result.slice(0, -1);
  }
  return result;
}

/** 模型列表字典序排序（不修改输入数组）。 */
export function sortModelIds(models: readonly string[]): string[] {
  return [...models].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 测试连接请求体（POST /api/backends/chat-completions/status，ST 同源代理）。 */
export function buildStatusTestRequest(connection: AgentConnection): {
  readonly chat_completion_source: "openai";
  readonly reverse_proxy: string;
  readonly proxy_password: string;
} {
  return {
    chat_completion_source: "openai",
    reverse_proxy: normalizeBaseUrl(connection.baseUrl),
    // 空串而非省略：ST 侧 reverse_proxy 路径 apiKey = proxy_password，
    // 省略会拼出 "Bearer undefined" 头
    proxy_password: connection.apiKey,
  };
}
