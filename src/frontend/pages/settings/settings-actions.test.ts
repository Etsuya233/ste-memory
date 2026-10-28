import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  type PluginSettings,
} from "../../../features/settings/plugin-settings.ts";
import { SettingsService } from "../../../features/settings/settings-service.ts";
import { saveFillTimeout, setSettingToggle } from "./settings-actions.ts";

function harness() {
  let current = structuredClone(DEFAULT_SETTINGS);
  const refreshMirror = vi.fn(async () => {});
  const service = new SettingsService({
    store: {
      read: () => current,
      write: (next: PluginSettings) => {
        current = next;
      },
    },
    syncToCurrentChat: async () => {},
    refreshMemoryMacros: async () => {},
    refreshAgentMacros: async () => {},
    refreshMirror,
    refreshVectorIndex: async () => {},
    writeChatScopeMacros: () => {},
    validateMacros: async (macros) => macros,
    getChatScopeMacros: () => [],
    getChatContext: () => "chat",
  });
  const services = { settings: service, onChanged: vi.fn(async () => {}), version: "test" };
  return { service, services, refreshMirror };
}

describe("settings page saves", () => {
  it("merges timeout into the latest settings and retains independently saved switches", async () => {
    const { service, services } = harness();
    service.save({
      ...service.read(),
      macroLimit: 9876,
      enabled: false,
      mirror: { enabled: false, includeHistory: false },
    });
    const result = await saveFillTimeout(services, "90");
    expect(result).toMatchObject({
      saved: true,
      settings: {
        fillAgentTimeoutSeconds: 90,
        macroLimit: 9876,
        enabled: false,
        mirror: { enabled: false, includeHistory: false },
      },
    });
    expect(services.onChanged).toHaveBeenCalledOnce();
  });

  it.each(["", " ", "29", "1801", "30.5", "invalid"])(
    "rejects invalid timeout %j before writing",
    async (input) => {
      const { service, services } = harness();
      const save = vi.spyOn(service, "save");
      await expect(saveFillTimeout(services, input)).rejects.toThrow("30–1800");
      expect(save).not.toHaveBeenCalled();
      expect(services.onChanged).not.toHaveBeenCalled();
    },
  );

  it("reads back a persisted plugin toggle after runtime refresh fails and notifies host", async () => {
    const { service, services, refreshMirror } = harness();
    refreshMirror.mockRejectedValueOnce(new Error("mirror unavailable"));
    const result = await setSettingToggle(services, "enabled", false);
    expect(result).toMatchObject({
      saved: true,
      error: "mirror unavailable",
      settings: { enabled: false },
    });
    expect(service.read().enabled).toBe(false);
    expect(services.onChanged).toHaveBeenCalledOnce();
  });

  it("preserves mirror history and keeps the persisted toggle after follow-up fails", async () => {
    const { service, services, refreshMirror } = harness();
    service.save({ ...service.read(), mirror: { enabled: true, includeHistory: false } });
    refreshMirror.mockRejectedValueOnce(new Error("refresh failed"));
    const result = await setSettingToggle(services, "mirror", false);
    expect(result).toMatchObject({
      saved: true,
      error: "refresh failed",
      settings: { mirror: { enabled: false, includeHistory: false } },
    });
    expect(services.onChanged).toHaveBeenCalledOnce();
  });

  it("reports host refresh failure without losing the successfully saved timeout", async () => {
    const { services } = harness();
    services.onChanged.mockRejectedValueOnce(new Error("host refresh failed"));
    const result = await saveFillTimeout(services, "1800");
    expect(result).toMatchObject({
      saved: true,
      error: "host refresh failed",
      settings: { fillAgentTimeoutSeconds: 1800 },
    });
  });

  it("retains stored state when persistence fails", async () => {
    const { service, services } = harness();
    vi.spyOn(service, "save").mockImplementationOnce(() => {
      throw new Error("write failed");
    });
    const result = await saveFillTimeout(services, "30");
    expect(result).toMatchObject({
      saved: false,
      error: "write failed",
      settings: { fillAgentTimeoutSeconds: 600 },
    });
  });
});
