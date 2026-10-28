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
  const updated = vi.fn(async () => {});
  const stopQueries = vi.fn();
  const updateApply = vi.fn(async () => ({ issues: ["file save failed"] }));
  const retrySave = vi.fn(async () => ({ issues: [] }));
  const runtime = {
    settings: { read: () => ({ enabled: true }) },
    manager: {
      getStatus: () => ({ kind: "active", space: { id: context.spaceId, name: "A" } }),
      syncToCurrentChat: vi.fn(async () => {}),
    },
    adapter: { getChatSnapshot: () => ({ characterId: 1, chatId: current }) },
    presetPreview: {},
    presetUpdate: { preview: vi.fn(), apply: updateApply, retrySave },
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
    updated,
    stopQueries,
    updateApply,
    retrySave,
    setCurrent: (value: string) => {
      current = value;
    },
    services: createPresetSettingsServices(runtime, rebuilt, stopQueries, updated),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("preset host operations", () => {
  it("reports committed incremental updates and refresh failures without invoking rebuild", async () => {
    const h = harness();
    h.updated.mockRejectedValueOnce(new Error("view refresh"));
    const plan = { spaceId: h.context.spaceId } as Parameters<
      typeof h.services.spaceUpdate.apply
    >[0];
    const outcome = await h.services.spaceUpdate.apply(plan, ["name"], h.context.chatIdentity);
    expect(outcome.issues).toEqual(["file save failed", expect.stringContaining("view refresh")]);
    expect(h.stopQueries).toHaveBeenCalledWith(h.context.spaceId);
    expect(h.updateApply).toHaveBeenCalledOnce();
    expect(h.apply).not.toHaveBeenCalled();
  });
  it("retries only snapshot saving after an incremental update", async () => {
    const h = harness();
    expect(
      await h.services.spaceUpdate.retrySave(h.context.spaceId, h.context.chatIdentity),
    ).toEqual({ issues: [] });
    expect(h.retrySave).toHaveBeenCalledOnce();
    expect(h.updateApply).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.stopQueries).not.toHaveBeenCalled();
  });
  it("rejects an old chat before calling incremental apply", async () => {
    const h = harness();
    h.setCurrent("chat-b");
    const plan = { spaceId: h.context.spaceId } as Parameters<
      typeof h.services.spaceUpdate.apply
    >[0];
    await expect(
      h.services.spaceUpdate.apply(plan, ["name"], h.context.chatIdentity),
    ).rejects.toThrow("chat changed");
    expect(h.updateApply).not.toHaveBeenCalled();
    expect(h.updated).not.toHaveBeenCalled();
  });
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
