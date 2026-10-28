import { describe, expect, it, vi } from "vitest";
import {
  MemoryCommitPersistenceError,
  type MemoryFieldId,
  type MemoryTableId,
  type MemorySpaceId,
} from "../memory/index.ts";
import { TablePresetApplyService } from "./table-preset-apply-service.ts";
import { SYSTEM_TABLE_PRESET } from "./system-preset.ts";

describe("preset rebuild commit boundary", () => {
  it("continues post-commit synchronization and reports the persistence issue without another rebuild", async () => {
    const rebuild = vi.fn(async (): Promise<boolean> => {
      throw new MemoryCommitPersistenceError(new Error("file unavailable"));
    });
    const clear = vi.fn();
    const refresh = vi.fn(async () => {});
    const mirror = vi.fn(async () => {});
    let seq = 0;
    const service = new TablePresetApplyService({
      rebuild: { rebuild },
      cancelActiveTask: async () => {},
      defaultPreset: () => SYSTEM_TABLE_PRESET,
      currentChatIdentity: () => "a",
      clearChatScopeMacros: clear,
      createIds: {
        table: () => `t-${++seq}` as MemoryTableId,
        field: () => `f-${++seq}` as MemoryFieldId,
        group: () => `g-${++seq}`,
      },
      now: () => "",
      validateStructure: async (value) => value,
    });
    expect(
      await service.applyPreset("s" as MemorySpaceId, SYSTEM_TABLE_PRESET, {
        chatIdentity: "a",
        refreshMacros: refresh,
        syncMirror: mirror,
      }),
    ).toMatchObject({
      kind: "applied-with-sync-issue",
      message: expect.stringContaining("file unavailable"),
    });
    expect(rebuild).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(mirror).toHaveBeenCalledOnce();
  });
});
