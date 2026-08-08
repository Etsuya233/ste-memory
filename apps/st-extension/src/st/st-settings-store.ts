import { SETTINGS_KEY, mergeSettings, type PluginSettings, type SettingsStore } from "../settings/plugin-settings.ts";
import type { StContext } from "./st-chat-adapter.ts";

/**
 * ST extension_settings 宿主实现：设置写在 ST 全局扩展设置对象
 * （`context.extensionSettings`，随 ST settings.json 持久化）的 steMemory
 * 命名空间下，写入后触发 `saveSettingsDebounced` 防抖保存。
 *
 * 与 StChatAdapter 同法：持有 getContext 工厂而非一次性快照——ST 的
 * getContext() 每次构造新对象，必须每次读写重取。
 *
 * 防御：extensionSettings 缺失（非 ST 环境/测试）时 read 返回默认值、
 * write 静默跳过，保证插件在任何环境下不抛错。
 */
export class StSettingsStore implements SettingsStore {
  readonly #getContext: () => StContext;

  constructor(getContext: () => StContext) {
    this.#getContext = getContext;
  }

  read(): PluginSettings {
    const raw = this.#getContext().extensionSettings?.[SETTINGS_KEY];
    return mergeSettings(raw);
  }

  write(settings: PluginSettings): void {
    const context = this.#getContext();
    const extensionSettings = context.extensionSettings;
    if (!extensionSettings) return;
    extensionSettings[SETTINGS_KEY] = settings;
    context.saveSettingsDebounced?.();
  }
}


