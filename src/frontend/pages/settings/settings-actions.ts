import type { PluginSettings } from "../../../features/settings/plugin-settings.ts";
import type { SettingsService } from "../../../features/settings/settings-service.ts";
import type { AgentConnection } from "../../../features/settings/agent-connections.ts";
import type { ConnectionTestResult } from "../../../infrastructure/sillytavern/llm/st-backends-status.ts";

export interface SettingsServices {
  settings: Pick<
    SettingsService,
    | "read"
    | "setPluginEnabled"
    | "setMirrorEnabled"
    | "save"
    | "setEmbeddingConnection"
    | "setRerankSettings"
  >;
  testAgentConnection: (connection: AgentConnection) => Promise<ConnectionTestResult>;
  onChanged: () => void | Promise<void>;
  version: string;
}

export interface SettingsSaveResult {
  settings: PluginSettings;
  saved: boolean;
  error?: string;
}

/** Read back after follow-up failures: the service persists before refreshing runtime state. */
export async function setSettingToggle(
  services: SettingsServices,
  key: "enabled" | "mirror",
  value: boolean,
): Promise<SettingsSaveResult> {
  let error: string | undefined;
  try {
    if (key === "enabled") await services.settings.setPluginEnabled(value);
    else await services.settings.setMirrorEnabled(value);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const settings = services.settings.read();
  const saved = (key === "enabled" ? settings.enabled : settings.mirror.enabled) === value;
  try {
    await services.onChanged();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    error = error ? `${error}；${message}` : message;
  }
  return { settings, saved, error };
}

export async function saveFillTimeout(
  services: SettingsServices,
  input: string,
): Promise<SettingsSaveResult> {
  const seconds = Number(input);
  if (!input.trim() || !Number.isInteger(seconds) || seconds < 30 || seconds > 1800)
    throw new Error("每批填写超时须为 30–1800 秒的整数");
  let error: string | undefined;
  try {
    services.settings.save({ ...services.settings.read(), fillAgentTimeoutSeconds: seconds });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const settings = services.settings.read();
  const saved = settings.fillAgentTimeoutSeconds === seconds;
  try {
    await services.onChanged();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    error = error ? `${error}；${message}` : message;
  }
  return { settings, saved, error };
}
