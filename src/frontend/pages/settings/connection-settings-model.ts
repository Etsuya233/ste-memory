import {
  normalizeBaseUrl,
  connectionHeaderError,
  type AgentConnection,
} from "../../../features/settings/agent-connections.ts";
import type { PluginSettings } from "../../../features/settings/plugin-settings.ts";
import type { SettingsServices, SettingsSaveResult } from "./settings-actions.ts";

/** Services may persist successfully before a runtime refresh rejects. Read back the edited part. */
export async function persistSettingsEdit(
  services: SettingsServices,
  write: () => void | Promise<void>,
  isSaved: (settings: PluginSettings) => boolean,
): Promise<SettingsSaveResult> {
  let error: string | undefined;
  try {
    await write();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const settings = services.settings.read();
  const saved = isSaved(settings);
  try {
    await services.onChanged();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    error = error ? `${error}；${message}` : message;
  }
  return { settings, saved, error };
}

export function normalizedAgentConnection(connection: AgentConnection): AgentConnection {
  if (!connection.name.trim()) throw new Error("请填写连接名称");
  if (!connection.model.trim()) throw new Error("请填写模型名称");
  const baseUrl = normalizeBaseUrl(connection.baseUrl);
  const url = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("连接地址须为不含登录信息、查询参数或片段的 HTTP / HTTPS 地址");
  const next = {
    ...connection,
    name: connection.name.trim(),
    baseUrl,
    apiKey: connection.apiKey.trim(),
    model: connection.model.trim(),
  };
  // Keep header validation shared with actual requests and connection selection.
  const error = connectionHeaderError(Object.entries(next.customHeaders ?? {}));
  if (error) throw new Error(error);
  return next;
}
