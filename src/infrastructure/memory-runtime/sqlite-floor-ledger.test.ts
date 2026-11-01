import { describe, expect, it } from "vitest";
import { createServices, NOW } from "../indexeddb/test-support.ts";
import { SqliteFloorLedger } from "./sqlite-floor-ledger.ts";
import { createBackupFile, decodeBackupFile } from "../../features/backup/backup-codec.ts";
import {
  createChatMirrorFile,
  decodeChatMirrorFile,
} from "../../features/chat-mirror/chat-mirror-codec.ts";
import { cloneMemorySnapshot } from "../../features/memory-snapshot/snapshot-clone.ts";
import type { BackupIdFactory } from "../../features/backup/backup-port.ts";

async function setup() {
  const services = await createServices();
  const space = await services.spaces.create("进度");
  const ledger = new SqliteFloorLedger(services.memoryStore, () => NOW);
  return { ...services, space, ledger };
}

describe("SQLite 权威楼层进度", () => {
  it("手动已处理、出错及删除进度均提交完整快照，同楼层覆盖且查询补未知", async () => {
    const h = await setup();
    await h.ledger.markProcessed(h.space.id, [1, 3]);
    await h.ledger.markError(h.space.id, [3, 4]);
    await h.ledger.deleteStatuses(h.space.id, 4, 4);
    expect(await h.ledger.statuses(h.space.id, 0, 4)).toEqual([
      { floor: 0, status: "untracked" },
      { floor: 1, status: "processed" },
      { floor: 2, status: "untracked" },
      { floor: 3, status: "error" },
      { floor: 4, status: "untracked" },
    ]);
    expect(await h.ledger.processedCount(h.space.id, 0, 4)).toBe(1);
    const snapshot = (await h.memoryStore.snapshot(h.space.id))!;
    expect(snapshot.floorLedger).toEqual([
      { floor: 1, status: "processed", updatedAt: NOW },
      { floor: 3, status: "error", updatedAt: NOW },
    ]);
    await h.memoryStore.unload(h.space.id);
    await h.memoryStore.replace(snapshot);
    expect(await h.ledger.processedCount(h.space.id, 0, 4)).toBe(1);
  });

  it("批次进度在提交前不可见，回滚不污染已提交读取", async () => {
    const h = await setup();
    const token = await h.memoryStore.begin(h.space.id);
    await new SqliteFloorLedger(h.memoryStore, () => NOW, token).markProcessed(h.space.id, [0, 1]);
    expect((await h.memoryStore.snapshot(h.space.id))!.floorLedger).toEqual([]);
    await h.memoryStore.rollbackTask(h.space.id, token);
    expect((await h.memoryStore.snapshot(h.space.id))!.floorLedger).toEqual([]);
  });

  it("备份、聊天镜像和副本完整携带进度，空间身份更换不改楼层含义", async () => {
    const h = await setup();
    await h.ledger.markProcessed(h.space.id, [7]);
    const snapshot = (await h.memoryStore.snapshot(h.space.id))!;
    const backup = decodeBackupFile(
      JSON.parse(JSON.stringify(createBackupFile({ spaces: [snapshot] }, "test", NOW))),
    );
    const mirror = decodeChatMirrorFile(
      JSON.parse(JSON.stringify(createChatMirrorFile(snapshot, snapshot.space.id, NOW, "test"))),
    )!;
    expect(backup.data.spaces[0]!.floorLedger).toEqual(snapshot.floorLedger);
    expect(mirror.data.floorLedger).toEqual(snapshot.floorLedger);
    const ids = { space: () => "copy" } as BackupIdFactory;
    const copy = cloneMemorySnapshot(snapshot, ids, "副本", NOW);
    expect(copy.floorLedger).toEqual(snapshot.floorLedger);
    expect(copy.space.id).toBe("copy");
  });
});
