import { afterEach, describe, expect, it, vi } from "vitest";
import type { SteMemoryRuntime } from "../../runtime.ts";
import { SYSTEM_TABLE_PRESET } from "../../features/table-presets/system-preset.ts";
import { createPresetSettingsServices } from "./preset-settings.ts";
import type { PresetContext } from "../pages/settings/preset-settings-services.ts";

function harness() {
  const context = {
    spaceId: "space-a",
    chatIdentity: "char:1:chat-a",
    title: "A",
  } as PresetContext;
  let current = "chat-a";
  const stop = vi.fn(async () => {});
  const apply = vi.fn(async () => ({ kind: "applied" as const }));
  const rebuilt = vi.fn(async () => {});
  const runtime = {
    settings: { read: () => ({ enabled: true }) },
    manager: {
      getStatus: () => ({ kind: "active", space: { id: context.spaceId } }),
      syncToCurrentChat: vi.fn(async () => {}),
    },
    adapter: { getChatSnapshot: () => ({ characterId: 1, chatId: current }) },
    presetPreview: {},
    presetApply: {
      assertCurrentChat: (identity: string) => {
        if (identity !== `char:1:${current}`) throw new Error("chat changed");
      },
      stopSpaceWrites: stop,
      applyPreset: apply,
    },
    macro: { kick: vi.fn(async () => {}) },
    mirror: { flushRebuiltSpace: vi.fn(async () => {}) },
  } as unknown as SteMemoryRuntime;
  return {
    context,
    stop,
    apply,
    rebuilt,
    setCurrent: (value: string) => {
      current = value;
    },
    services: createPresetSettingsServices(runtime, rebuilt, () => {}),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("preset host operations", () => {
  it("checks the captured target again after stopping writes", async () => {
    const h = harness();
    h.stop.mockImplementationOnce(async () => {
      h.setCurrent("chat-b");
    });
    await expect(h.services.applyTablePreset(h.context, SYSTEM_TABLE_PRESET)).rejects.toThrow(
      "chat changed",
    );
    expect(h.apply).not.toHaveBeenCalled();
  });
  it("keeps backup cancellation from stopping tasks or applying the preset", async () => {
    const h = harness();
    vi.stubGlobal("window", {
      showSaveFilePicker: async () => {
        throw new DOMException("cancelled", "AbortError");
      },
    });
    expect(await h.services.backupCurrentSpace(h.context)).toBe(false);
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });
  it("reports a committed rebuild separately when refreshing its UI fails", async () => {
    const h = harness();
    h.rebuilt.mockRejectedValueOnce(new Error("view refresh"));
    const outcome = await h.services.applyTablePreset(h.context, SYSTEM_TABLE_PRESET);
    expect(outcome).toMatchObject({
      kind: "applied-with-sync-issue",
      message: expect.stringContaining("view refresh"),
    });
    expect(h.apply).toHaveBeenCalledOnce();
  });
});
