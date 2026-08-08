import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings, type PluginSettings } from "../settings/plugin-settings.ts";
import { StSettingsStore } from "./st-settings-store.ts";
import type { StContext } from "./st-chat-adapter.ts";

function fakeContext(overrides: Partial<StContext> = {}): {
  context: StContext;
  extensionSettings: Record<string, unknown>;
  saveSettings: ReturnType<typeof vi.fn>;
} {
  const extensionSettings: Record<string, unknown> = {};
  const saveSettings = vi.fn();
  const context: StContext = {
    extensionSettings,
    saveSettingsDebounced: saveSettings,
    ...overrides,
  };
  return { context, extensionSettings, saveSettings };
}

describe("StSettingsStore（extension_settings 宿主）", () => {
  it("未写过的空设置：读回默认值", () => {
    const { context } = fakeContext();
    const store = new StSettingsStore(() => context);
    expect(store.read()).toEqual(DEFAULT_SETTINGS);
  });

  it("写入后读回原值，并触发 saveSettingsDebounced", () => {
    const { context, extensionSettings, saveSettings } = fakeContext();
    const store = new StSettingsStore(() => context);
    const settings: PluginSettings = { ...DEFAULT_SETTINGS, enabled: false };

    store.write(settings);

    expect(extensionSettings.steMemory).toEqual(settings);
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(store.read()).toEqual(settings);
  });

  it("持久化值缺失键：读时补齐默认（旧版本数据向前兼容）", () => {
    const { context, extensionSettings } = fakeContext();
    extensionSettings.steMemory = { enabled: false };
    const store = new StSettingsStore(() => context);
    const read = store.read();
    expect(read.enabled).toBe(false);
    expect(read.macroName).toBe(DEFAULT_SETTINGS.macroName);
    expect(read.r2).toEqual(DEFAULT_SETTINGS.r2);
  });

  it("持久化值损坏（类型不对）：读回默认，不抛错", () => {
    const { context, extensionSettings } = fakeContext();
    extensionSettings.steMemory = { enabled: "yes", r2: 42 };
    const store = new StSettingsStore(() => context);
    expect(store.read()).toEqual(DEFAULT_SETTINGS);
  });

  it("extensionSettings 缺失（非 ST 环境）：read 默认值、write 静默跳过，不抛错", () => {
    const store = new StSettingsStore(() => ({ chatId: "story" }));
    expect(store.read()).toEqual(DEFAULT_SETTINGS);
    expect(() => store.write({ ...DEFAULT_SETTINGS, enabled: false })).not.toThrow();
  });

  it("每次 read 重取上下文（ST getContext 每次构造新对象的语义）", () => {
    const first = fakeContext();
    const second = fakeContext();
    second.extensionSettings.steMemory = { ...DEFAULT_SETTINGS, enabled: false };
    let current = first.context;
    const store = new StSettingsStore(() => current);
    expect(store.read().enabled).toBe(true);

    current = second.context;
    expect(store.read().enabled).toBe(false);

    // write 作用于当前上下文（切换后的对象）
    store.write({ ...DEFAULT_SETTINGS, enabled: true });
    expect(first.extensionSettings.steMemory).toBeUndefined();
    expect(second.extensionSettings.steMemory).toEqual(mergeSettings({ ...DEFAULT_SETTINGS, enabled: true }));
  });
});
