import { expect, it, vi } from "vitest";
import { createTestDatabase } from "./test-support.ts";
import { IndexedDbMemoryHistory } from "./memory-history.ts";
import { MemoryHistoryService } from "../../features/memory-history/history-service.ts";
import { ChatSnapshotReplacementSaveError } from "../../features/chat-mirror/chat-snapshot-persistence.ts";
import { migrateMemorySpaceSnapshot } from "../../features/memory-snapshot/snapshot-migration.ts";
import { legacySnapshotFixture } from "../../features/memory-snapshot/snapshot-test-fixture.ts";
import type { MemorySpaceBackup } from "../../features/memory-snapshot/snapshot.ts";
import type { ChatSpaceManager } from "../../features/chat-binding/chat-space-manager.ts";
import {
  createBackupFile,
  parseBackupFile,
  serializeBackupFile,
} from "../../features/backup/index.ts";

const at = "2026-11-11T00:00:00.000Z";
const original: MemorySpaceBackup = {
  ...migrateMemorySpaceSnapshot({ version: "legacy-macros", snapshot: legacySnapshotFixture() }),
  floorLedger: [
    { floor: 0, status: "processed", updatedAt: at },
    { floor: 2, status: "error", updatedAt: at },
    { floor: 3, status: "processed", updatedAt: at },
    { floor: 4, status: "processed", updatedAt: at },
  ],
};
const edit = (name: string, stableId = original.space.stableId): MemorySpaceBackup => ({
  ...original,
  space: { ...original.space, name, stableId },
});

function harness() {
  const db = createTestDatabase();
  const store = new IndexedDbMemoryHistory(db);
  let current = original;
  let chatKey = "A";
  let epoch = 0;
  let id = 0;
  const settings = { enabled: true, limit: 1, interval: 3 };
  const importSpace = vi.fn<ChatSpaceManager["importSpace"]>();
  const service = () =>
    new MemoryHistoryService({
      store,
      settings: () => settings,
      now: () => new Date(Date.parse(at) + id * 1000).toISOString(),
      createId: () => String(++id),
      selection: (requested) => {
        if (requested !== chatKey) {
          throw new Error("聊天已切换");
        }
        return JSON.stringify([epoch, current.space.id, current.space.stableId]);
      },
      capture: async () => current,
      currentSnapshot: () => current,
      normalize: async (snapshot) => snapshot,
      importSpace,
    });
  return {
    db,
    store,
    settings,
    service,
    importSpace,
    setCurrent: (snapshot: MemorySpaceBackup) => {
      current = snapshot;
    },
    switchChat: (next: string) => {
      chatKey = next;
      epoch++;
    },
  };
}

it("各来源独立 gzip 保存，元数据保留空洞，导出兼容 JSON 备份导入", async () => {
  const { store, db } = harness();
  for (const source of ["manual", "automatic", "before-restore"] as const) {
    const version = await store.save({
      chatKey: "A",
      id: source,
      createdAt: at,
      source,
      snapshot: original,
    });
    expect(version).toMatchObject({
      source,
      compression: "gzip",
      format: 1,
      recordCount: 1,
      processedRanges: [
        { from: 0, to: 0 },
        { from: 3, to: 4 },
      ],
      errorRanges: [{ from: 2, to: 2 }],
    });
    const payload = (await db.memoryHistoryPayloads.get(source))!.payload;
    expect([...new Uint8Array(payload).slice(0, 2)]).toEqual([31, 139]);
    expect(version.compressedBytes).toBe(payload.byteLength);
    expect(version.originalBytes).toBe(new Blob([JSON.stringify(original)]).size);
    const snapshot = await store.read("A", source);
    const file = createBackupFile({ spaces: [snapshot] }, "test", at);
    expect(parseBackupFile(serializeBackupFile(file)).data.spaces[0]).toEqual(original);
  }
  await store.remove("A", "automatic");
  await db.memoryHistoryPayloads.update("manual", { payload: new ArrayBuffer(2) });
  expect((await store.list("A")).map((version) => version.source)).toEqual([
    "manual",
    "before-restore",
  ]);
  await expect(store.read("A", "manual")).rejects.toThrow("载荷损坏");
  expect(await store.read("A", "before-restore")).toEqual(original);
  await expect(store.read("B", "before-restore")).rejects.toThrow("当前聊天没有");
  await expect(store.remove("B", "before-restore")).rejects.toThrow("当前聊天没有");
});

it("首次保存，刷新后继续累计不同楼层，谱系替换重新开始", async () => {
  const h = harness();
  h.settings.limit = 20;
  const first = h.service();
  const fill = (service: MemoryHistoryService, newFloors: number[], snapshot = original) =>
    service.recordSuccessfulFill({ chatKey: "A", snapshot, newFloors });
  await fill(first, []);
  await fill(first, [5, 6, 5]);
  expect(await h.store.list("A")).toHaveLength(1);
  const refreshed = h.service();
  await fill(refreshed, [6]);
  expect(await h.store.list("A")).toHaveLength(1);
  await fill(refreshed, [7, 8, 9, 10]);
  expect(await h.store.list("A")).toHaveLength(2);
  expect((await h.store.progress("A"))?.floors).toEqual([]);
  h.settings.enabled = false;
  await fill(refreshed, [11, 12, 13]);
  expect(await h.store.list("A")).toHaveLength(2);
  h.settings.enabled = true;
  const rebuilt = edit("重建", "rebuilt");
  h.setCurrent(rebuilt);
  await refreshed.resetAfterReplacement("A", rebuilt);
  await fill(refreshed, [0], rebuilt);
  expect(await h.store.list("A")).toHaveLength(2);
  await fill(refreshed, [1, 2], rebuilt);
  expect(await h.store.list("A")).toHaveLength(3);
});

it("自动保存失败保留累计，重试保存原任务快照并留下其后新增的楼层", async () => {
  const h = harness();
  const service = h.service();
  const save = vi.spyOn(h.store, "save").mockRejectedValueOnce(new Error("QuotaExceededError"));
  await expect(
    service.recordSuccessfulFill({ chatKey: "A", snapshot: original, newFloors: [5] }),
  ).rejects.toThrow("QuotaExceededError");
  const newer = edit("后来修改");
  h.setCurrent(newer);
  await service.recordSuccessfulFill({ chatKey: "A", snapshot: newer, newFloors: [6] });
  expect(await h.store.list("A")).toEqual([]);
  expect((await h.store.progress("A"))?.floors).toEqual([5, 6]);
  await service.retryAutomatic("A");
  const [version] = await h.store.list("A");
  expect(await h.store.read("A", version!.id)).toEqual(original);
  expect((await h.store.progress("A"))?.floors).toEqual([6]);
  expect(service.automaticFailure("A")).toBeUndefined();
  expect(save).toHaveBeenCalledTimes(2);
});

it("恢复上限为一时保护双方，文件重试沿用原恢复并在核验后裁剪", async () => {
  const h = harness();
  const service = h.service();
  const manual = await service.save("A", "手动版本");
  await service.recordSuccessfulFill({ chatKey: "A", snapshot: original, newFloors: [] });
  const target = (await h.store.list("A")).find((version) => version.source === "automatic")!;
  const previous = edit("恢复前修改");
  h.setCurrent(previous);
  h.settings.enabled = false;
  let confirm!: () => Promise<void>;
  h.importSpace.mockImplementation(async (snapshot, _stage, hooks) => {
    await hooks!.beforeActivate();
    await h.store.trim(1, "A");
    expect(await h.store.read("A", target.id)).toEqual(original);
    await expect(h.store.remove("A", target.id)).rejects.toThrow("正在恢复");
    h.setCurrent(snapshot);
    confirm = hooks!.confirmed;
    throw new ChatSnapshotReplacementSaveError(new Error("文件失败"), "保存尚未核验");
  });
  await expect(service.restore(await service.prepareRestore("A", target.id))).rejects.toThrow(
    "保存尚未核验",
  );
  expect(await h.store.list("A")).toHaveLength(3);
  await expect(service.prepareRestore("A", target.id)).rejects.toThrow("上一次");
  await confirm();
  await service.finishRestore("A");
  const retained = await h.store.list("A");
  expect(retained.map((version) => version.source)).toEqual(["before-restore", "manual"]);
  expect(await h.store.read("A", retained[0]!.id)).toEqual(previous);
  expect(retained[1]!.id).toBe(manual.id);
  expect(h.importSpace).toHaveBeenCalledTimes(1);
});

it("恢复前失败、准备后编辑及切聊都会阻止应用目标", async () => {
  const h = harness();
  const service = h.service();
  const version = await service.save("A");
  h.importSpace.mockImplementation(async (snapshot, _stage, hooks) => {
    await hooks!.beforeActivate();
    h.setCurrent(snapshot);
    throw new Error("目标不应激活");
  });
  const stale = await service.prepareRestore("A", version.id);
  h.setCurrent(edit("准备后修改"));
  await expect(service.restore(stale)).rejects.toThrow("重新查看摘要");
  const crossChat = await service.prepareRestore("A", version.id);
  h.switchChat("B");
  h.switchChat("A");
  await expect(service.restore(crossChat)).rejects.toThrow("已变化");
  const fresh = await service.prepareRestore("A", version.id);
  vi.spyOn(h.store, "save").mockRejectedValueOnce(new Error("本机存储空间不足"));
  await expect(service.restore(fresh)).rejects.toThrow("本机存储空间不足");
  expect((await service.prepareRestore("A", version.id)).current.space.name).toBe("准备后修改");
  expect(await h.store.list("A")).toHaveLength(1);
});

it("恢复前备份已落库后切聊，按原聊天上限裁剪并保留该备份", async () => {
  const h = harness();
  const service = h.service();
  await service.save("A", "手动保留");
  await service.recordSuccessfulFill({ chatKey: "A", snapshot: original, newFloors: [] });
  const target = (await h.store.list("A")).find((version) => version.source === "automatic")!;
  const previous = edit("备份后未恢复");
  h.setCurrent(previous);
  h.settings.enabled = false;
  h.importSpace.mockImplementation(async (_snapshot, _stage, hooks) => {
    await hooks!.beforeActivate();
    h.switchChat("B");
    throw new Error("候选操作已过期");
  });
  const prepared = await service.prepareRestore("A", target.id);
  await expect(service.restore(prepared)).rejects.toThrow("候选操作已过期");
  const retained = await h.store.list("A");
  expect(retained.map((version) => version.source)).toEqual(["before-restore", "manual"]);
  expect(await h.store.read("A", retained[0]!.id)).toEqual(previous);
  expect(await h.store.list("B")).toEqual([]);
});
