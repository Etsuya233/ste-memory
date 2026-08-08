/** 插件设置出口：纯模型 + 存储端口（宿主实现见 src/st/st-settings-store.ts） */
export {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  isR2Configured,
  mergeSettings,
} from "./plugin-settings.ts";
export type { PluginSettings, R2Settings, SettingsStore } from "./plugin-settings.ts";
