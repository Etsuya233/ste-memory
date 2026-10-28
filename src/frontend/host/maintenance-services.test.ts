import { describe, expect, it, vi } from "vitest";
import type { SteMemoryRuntime } from "../../runtime.ts";
import { createBackupFile, serializeBackupFile } from "../../features/backup/backup-codec.ts";
import { MemoryCommitPersistenceError } from "../../features/memory/index.ts";
import { createMaintenanceServices } from "./maintenance-services.ts";
import { RecordsClearCleanupError } from "../../features/space-maintenance/space-maintenance-service.ts";
import type { MemorySpaceId } from "../../features/memory/index.ts";

function harness() {
  let chatId = "a";
  const restore = vi.fn(async () => {});
  const stop = vi.fn(async () => {});
  const changed = vi.fn(async () => {});
  const clear = vi.fn(async () => true);
  const runtime = {
    version: "test",
    settings: { read: () => ({ enabled: true }) },
    adapter: { getChatSnapshot: () => ({ chatId, characterId: 1 }) },
    manager: {
      getStatus: () => ({ kind: "active", space: { id: "space", name: "A" } }),
      syncToCurrentChat: async () => {},
    },
    backup: { loadSnapshot: async () => ({ spaces: [] }), restoreSnapshot: restore },
    presetApply: { stopSpaceWrites: stop },
    spaceMaintenance: { clearRecords: clear },
    macro: { kick: async () => {} },
    mirror: { kick: async () => {} },
    normalizeImportedSpace: async (value: unknown) => value,
  } as unknown as SteMemoryRuntime;
  const services = createMaintenanceServices(runtime, changed, () => {});
  const text = serializeBackupFile(createBackupFile({ spaces: [] }, "test", ""));
  return {
    services,
    text,
    restore,
    stop,
    changed,
    clear,
    switchChat: () => {
      chatId = "b";
    },
  };
}
describe("maintenance import boundaries", () => {
  it("previews without writes and rejects an obsolete chat before restoring", async () => {
    const h = harness();
    const preview = await h.services.previewImport(h.text, "all");
    expect(h.restore).not.toHaveBeenCalled();
    h.switchChat();
    await expect(preview.apply()).rejects.toThrow("对话已切换");
    expect(h.restore).not.toHaveBeenCalled();
  });
  it("invalidates a committed import when only the view refresh fails", async () => {
    const h = harness();
    h.changed.mockRejectedValueOnce(new Error("refresh failed"));
    const preview = await h.services.previewImport(h.text, "all");
    expect(await preview.apply()).toMatchObject({
      kind: "applied-with-sync-issue",
      message: expect.stringContaining("refresh failed"),
    });
    await expect(preview.apply()).rejects.toThrow("此导入已提交");
    expect(h.restore).toHaveBeenCalledOnce();
  });
  it("recognizes post-commit snapshot persistence errors without replaying the import", async () => {
    const h = harness();
    h.restore.mockRejectedValueOnce(new MemoryCommitPersistenceError(new Error("file failed")));
    const preview = await h.services.previewImport(h.text, "all");
    expect(await preview.apply()).toMatchObject({ kind: "applied-with-sync-issue" });
    await expect(preview.apply()).rejects.toThrow("此导入已提交");
    expect(h.restore).toHaveBeenCalledOnce();
  });
  it("reports task cleanup failure after record deletion as committed", async () => {
    const h = harness();
    h.clear.mockRejectedValueOnce(
      new RecordsClearCleanupError("space" as MemorySpaceId, new Error("ledger failed")),
    );
    expect(await h.services.clearRecords(h.services.currentContext()!)).toMatchObject({
      kind: "applied-with-sync-issue",
      message: expect.stringContaining("ledger failed"),
    });
    expect(h.clear).toHaveBeenCalledOnce();
  });
});
