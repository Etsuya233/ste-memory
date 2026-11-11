import { ChatSnapshotReplacementSaveError } from "../../features/chat-mirror/chat-snapshot-persistence.ts";
import { describe, expect, it, vi } from "vitest";
import type { SteMemoryRuntime } from "../../runtime.ts";
import { createBackupFile, serializeBackupFile } from "../../features/backup/backup-codec.ts";
import { MemoryCommitPersistenceError, type MemorySpaceId } from "../../features/memory/index.ts";
import type { MemorySpaceBackup } from "../../features/backup/index.ts";
import { createMaintenanceServices } from "./maintenance-services.ts";
import { RecordsClearCleanupError } from "../../features/space-maintenance/space-maintenance-service.ts";
import { MEMORY_SNAPSHOT_SCHEMA_VERSION } from "../../features/memory-snapshot/snapshot.ts";
import type { LogAppendInput } from "../../features/logging/log.ts";

function harness() {
  let chatId = "a";
  let statusKind = "active";
  const unit: MemorySpaceBackup = {
    schemaVersion: MEMORY_SNAPSHOT_SCHEMA_VERSION,
    floorLedger: [],
    space: {
      id: "imported" as MemorySpaceId,
      stableId: "imported" as MemorySpaceId,
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
  const clearAssistantHistory = vi.fn(async () => {});
  const normalize = vi.fn(async (value: unknown) => value);
  const append = vi.fn(async (_input: LogAppendInput) => {});
  const runtime = {
    version: "test",
    logs: { append },
    persistence: { getStatus: () => ({ kind: "idle", cleanup: { kind: "idle" } }) },
    settings: { read: () => ({ enabled: true }) },
    adapter: {
      getChatSnapshot: () => ({ chatId, characterId: 1 }),
      captureFileTarget: () => ({
        identity: `char:1:${chatId}`,
        kind: "character",
        chatId,
        avatarUrl: "a.png",
      }),
    },
    manager: {
      getStatus: () => ({ kind: statusKind, space: { id: "space", name: "A" } }),
      getActiveStatus: (chatKey: string) =>
        statusKind === "active" && chatKey === `char:1:${chatId}`
          ? { kind: "active", space: { id: "space", name: "A" } }
          : undefined,
      importSpace: restore,
    },
    backup: { exportCurrentSpace: async () => unit },
    presetApply: { stopSpaceWrites: stop },
    spaceMaintenance: { clearRecords: clear },
    macro: { kick: async () => {} },
    normalizeImportedSpace: normalize,
    queryChat: { store: { clearSpaceHistory: clearAssistantHistory } },
  } as unknown as SteMemoryRuntime;
  const services = createMaintenanceServices(runtime, changed);
  const text = serializeBackupFile(createBackupFile({ spaces: [unit] }, "test", ""));
  return {
    services,
    text,
    restore,
    stop,
    changed,
    clear,
    clearAssistantHistory,
    normalize,
    append,
    failLoad: () => {
      statusKind = "load-error";
    },
    switchChat: () => {
      chatId = "b";
    },
  };
}
describe("maintenance import boundaries", () => {
  it("损坏空间可在明确目标聊天导入恢复，错误日志关联操作并保留异常链", async () => {
    const h = harness();
    h.failLoad();
    expect(h.services.currentContext()?.spaceId).toBeNull();
    const preview = await h.services.previewImport(h.text);
    expect(await preview.apply()).toMatchObject({
      kind: "done",
      logKey: expect.stringMatching(/^import-/),
    });
    expect(h.restore).toHaveBeenCalledOnce();
    await expect(h.services.previewImport("invalid JSON")).rejects.toThrow("阶段：读取备份");
    const input = h.append.mock.calls.at(-1)![0];
    expect(input).toMatchObject({
      type: "memory-import",
      level: "error",
      key: expect.stringMatching(/^import-/),
    });
    expect(JSON.parse(input.text)).toMatchObject({
      phase: "read-backup",
      error: {
        name: "DomainError",
        stack: expect.any(String),
        cause: { name: "SyntaxError", stack: expect.any(String) },
      },
    });
  });
  it("宏预检查失败不取消当前任务", async () => {
    const h = harness();
    h.normalize.mockRejectedValueOnce(new Error("宏预检查失败"));
    const preview = await h.services.previewImport(h.text);
    await expect(preview.apply()).rejects.toThrow("宏预检查失败");
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.restore).not.toHaveBeenCalled();
  });
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
        "候选空间已在内存生效，保存尚未核验：file failed",
      ),
    );
    const preview = await h.services.previewImport(h.text);
    expect(await preview.apply()).toMatchObject({
      kind: "replacement-unverified",
      message: expect.stringContaining("保存尚未核验"),
    });
    await expect(preview.apply()).rejects.toThrow("此导入预览已使用");
    expect(h.restore).toHaveBeenCalledOnce();
    expect(h.changed).not.toHaveBeenCalled();
    expect(h.clearAssistantHistory).not.toHaveBeenCalled();
  });
  it("keeps assistant history when record-clear candidate verification fails", async () => {
    const h = harness();
    h.clear.mockRejectedValueOnce(
      new ChatSnapshotReplacementSaveError(
        new Error("remote differs"),
        "清除候选已在内存生效，远端文件尚未核验：remote differs",
      ),
    );
    expect(await h.services.clearRecords(h.services.currentContext()!)).toEqual({
      kind: "replacement-unverified",
      message: "清除候选已在内存生效，远端文件尚未核验：remote differs",
    });
    expect(h.clear).toHaveBeenCalledOnce();
    expect(h.clearAssistantHistory).not.toHaveBeenCalled();
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
