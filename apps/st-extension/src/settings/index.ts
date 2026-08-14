/** 插件设置出口：纯模型 + 存储端口（宿主实现见 src/st/st-settings-store.ts） */
export {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  isR2Configured,
  mergeSettings,
} from "./plugin-settings.ts";
export type { PluginSettings, R2Settings, SettingsStore } from "./plugin-settings.ts";
/** Agent 连接（ADR 0010）：连接池纯逻辑 + 每 Agent 选择 */
export {
  AGENT_CONNECTION_TARGETS,
  buildStatusTestRequest,
  normalizeBaseUrl,
  removeAgentConnection,
  resolveAgentConnection,
  setAgentConnection,
  sortModelIds,
  upsertAgentConnection,
} from "./agent-connections.ts";
export type { AgentConnection, AgentConnectionTarget } from "./agent-connections.ts";
