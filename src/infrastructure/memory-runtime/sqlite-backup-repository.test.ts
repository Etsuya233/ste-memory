import { afterEach, describe, expect, it } from "vitest";
import { createInProcessSqliteMemoryClient } from "../sqlite/node-client.ts";
import { SqliteMemoryStore } from "./sqlite-memory-store.ts";
import { SqliteMemoryBackupRepository } from "./sqlite-backup-repository.ts";
import { migrateMemorySpaceSnapshot } from "../../features/memory-snapshot/snapshot-migration.ts";
import { legacySnapshotFixture } from "../../features/memory-snapshot/snapshot-test-fixture.ts";
import type { SqliteMemoryClient } from "../sqlite/types.ts";
let client: SqliteMemoryClient;
afterEach(async () => {
  await client?.close();
});
describe("当前聊天备份", () => {
  it("导出已加载SQLite完整快照，不查本地目录或保存副本", async () => {
    client = await createInProcessSqliteMemoryClient();
    const store = new SqliteMemoryStore(client, {
      saveSnapshot: async () => {},
      assertCanEdit: () => {},
      reportRefreshError: console.error,
    });
    const snapshot = migrateMemorySpaceSnapshot({
      version: "legacy-macros",
      snapshot: legacySnapshotFixture(),
    });
    await store.replace(snapshot);
    const backup = new SqliteMemoryBackupRepository(
      store,
      () => snapshot.space.id,
      createInProcessSqliteMemoryClient,
    );
    expect(await backup.exportCurrentSpace()).toEqual(snapshot);
    await store.unload(snapshot.space.id);
    await expect(backup.exportCurrentSpace()).rejects.toThrow("尚未加载");
  });
  it("候选结构和SQLite约束独立验证，不改变当前空间", async () => {
    client = await createInProcessSqliteMemoryClient();
    const store = new SqliteMemoryStore(client, {
      saveSnapshot: async () => {},
      assertCanEdit: () => {},
      reportRefreshError: console.error,
    });
    const snapshot = migrateMemorySpaceSnapshot({
      version: "legacy-macros",
      snapshot: legacySnapshotFixture(),
    });
    await store.replace(snapshot);
    const backup = new SqliteMemoryBackupRepository(
      store,
      () => snapshot.space.id,
      createInProcessSqliteMemoryClient,
    );
    const invalid = {
      ...snapshot,
      fields: snapshot.fields.map((field) => ({ ...field, required: true })),
      records: snapshot.records.map((record) => ({ ...record, payload: {} })),
    };
    await expect(backup.validateSnapshot(invalid)).rejects.toThrow();
    expect(await store.snapshot(snapshot.space.id)).toEqual(snapshot);
  });
});
