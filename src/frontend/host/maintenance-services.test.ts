import { ChatSnapshotReplacementSaveError } from "../../features/chat-mirror/chat-snapshot-persistence.ts";
import { describe, expect, it, vi } from "vitest";
import type { SteMemoryRuntime } from "../../runtime.ts";
import { createBackupFile, serializeBackupFile } from "../../features/backup/backup-codec.ts";
import { MemoryCommitPersistenceError, type MemorySpaceId } from "../../features/memory/index.ts";
import type { MemorySpaceBackup } from "../../features/backup/index.ts";
import { createMaintenanceServices } from "./maintenance-services.ts";
import { RecordsClearCleanupError } from "../../features/space-maintenance/space-maintenance-service.ts";

function harness() {
  let chatId = "a";
  const unit: MemorySpaceBackup = {
    schemaVersion: 1,
    space: {
      id: "imported" as MemorySpaceId,
      name: "Imported",
      macros: [],
      initializationSource: null,
      createdAt: "",
      updatedAt: "",
    },
    tables: [],
    fields: [],
    records: [],
    history: [],
    evidence: [],
  };
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
      importSpace: restore,
    },
    backup: { exportCurrentSpace: async () => unit },
    presetApply: { stopSpaceWrites: stop },
    spaceMaintenance: { clearRecords: clear },
    macro: { kick: async () => {} },
    normalizeImportedSpace: async (value: unknown) => value,
  } as unknown as SteMemoryRuntime;
  const services = createMaintenanceServices(runtime, changed, () => {});
  const text = serializeBackupFile(createBackupFile({ spaces: [unit] }, "test", ""));
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
  it("previews without writes and rejects an obsolete chat before importing", async () => {
    const h = harness();
    const preview = await h.services.previewImport(h.text);
    expect(h.restore).not.toHaveBeenCalled();
    h.switchChat();
    await expect(preview.apply()).rejects.toThrow("对话已切换");
    expect(h.restore).not.toHaveBeenCalled();
  });
  it("rejects an empty or multi-space file before preparing an import", async () => {
    const h = harness();
    const file = JSON.parse(h.text);
    for (const spaces of [
      [],
      [
        file.data.spaces[0],
        { ...file.data.spaces[0], space: { ...file.data.spaces[0].space, id: "second" } },
      ],
    ]) {
      await expect(
        h.services.previewImport(JSON.stringify({ ...file, data: { spaces } })),
      ).rejects.toThrow("只包含一个记忆空间");
    }
    expect(h.restore).not.toHaveBeenCalled();
  });
  it("invalidates a saved import when only the view refresh fails", async () => {
    const h = harness();
    h.changed.mockRejectedValueOnce(new Error("refresh failed"));
    const preview = await h.services.previewImport(h.text);
    expect(await preview.apply()).toMatchObject({
      kind: "applied-with-sync-issue",
      message: expect.stringContaining("refresh failed"),
    });
    await expect(preview.apply()).rejects.toThrow("此导入预览已使用");
    expect(h.restore).toHaveBeenCalledOnce();
  });
  it("keeps replacement save failure owned by persistence and invalidates the old import", async () => {
    const h = harness();
    h.restore.mockRejectedValueOnce(
      new ChatSnapshotReplacementSaveError(
        new Error("file failed"),
        "候选空间尚未保存，当前空间尚未替换：file failed",
      ),
    );
    const preview = await h.services.previewImport(h.text);
    expect(await preview.apply()).toMatchObject({
      kind: "replacement-not-saved",
      message: expect.stringContaining("当前空间尚未替换"),
    });
    await expect(preview.apply()).rejects.toThrow("此导入预览已使用");
    expect(h.restore).toHaveBeenCalledOnce();
    expect(h.changed).not.toHaveBeenCalled();
  });
  it("reports committed record clear even when saving or task cleanup fails", async () => {
    for (const failure of [
      new MemoryCommitPersistenceError(new Error("file failed")),
      new RecordsClearCleanupError("space" as MemorySpaceId, new Error("ledger failed")),
    ]) {
      const h = harness();
      h.clear.mockRejectedValueOnce(failure);
      expect(await h.services.clearRecords(h.services.currentContext()!)).toMatchObject({
        kind: "applied-with-sync-issue",
      });
      expect(h.clear).toHaveBeenCalledOnce();
    }
  });
});
