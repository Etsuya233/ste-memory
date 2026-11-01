import { describe, expect, it } from "vitest";
import { decodeBackupFile, createBackupFile } from "../backup/backup-codec.ts";
import { BACKUP_FORMAT } from "../backup/backup-file.ts";
import { createChatMirrorFile, decodeChatMirrorFile } from "../chat-mirror/chat-mirror-codec.ts";
import { CHAT_MIRROR_FORMAT } from "../chat-mirror/chat-mirror-file.ts";
import { migrateMemorySpaceSnapshot } from "./snapshot-migration.ts";
import { MEMORY_SNAPSHOT_SCHEMA_VERSION } from "./snapshot.ts";
import { legacySnapshotFixture } from "./snapshot-test-fixture.ts";

function backup(snapshot: unknown, version: number) {
  return {
    format: BACKUP_FORMAT,
    version,
    exportedAt: "now",
    appVersion: "test",
    data: { spaces: [snapshot] },
  };
}
function mirror(snapshot: unknown, version: number) {
  return {
    format: CHAT_MIRROR_FORMAT,
    version,
    spaceId: "space",
    updatedAt: "now",
    appVersion: "test",
    data: snapshot,
  };
}

describe("统一记忆空间快照迁移", () => {
  it.each([1, 2])("旧v%i备份和镜像产生同一个当前快照，不改变输入和身份", (version) => {
    const legacy = legacySnapshotFixture();
    const before = structuredClone(legacy);
    const fromBackup = decodeBackupFile(backup(legacy, version)).data.spaces[0]!;
    expect(decodeChatMirrorFile(mirror(legacy, version))!.data).toEqual(fromBackup);
    expect(legacy).toEqual(before);
    expect(decodeBackupFile(backup(legacy, version)).data.spaces[0]).toEqual(fromBackup);
    expect(fromBackup.schemaVersion).toBe(MEMORY_SNAPSHOT_SCHEMA_VERSION);
    expect(fromBackup.space).toMatchObject({ id: "space", macros: [], initializationSource: null });
    expect(fromBackup.tables[0]).toMatchObject({ id: "table", position: 0 });
    expect(fromBackup.tables[0]).not.toHaveProperty("kind");
    expect(fromBackup.tables[0]!.vectorIndex!.groups[0]).toMatchObject({
      id: "group",
      key: "group",
    });
    expect(fromBackup.records[0]!.fieldEvidence).toEqual({ field: [] });
    expect(fromBackup.history).toEqual(legacy.history);
  });

  it("非空孤立证据拒绝迁移，保留原始内容", () => {
    const legacy = legacySnapshotFixture();
    const snapshot = {
      ...legacy,
      records: [
        {
          ...legacy.records[0]!,
          fieldEvidence: {
            removed: [
              {
                evidence_id: "evidence",
                source_type: "message",
                source_id: 1,
                storage_mode: "reference",
                extraProps: {},
              },
            ],
          },
        },
      ],
    };
    const before = structuredClone(snapshot);
    expect(() => decodeBackupFile(backup(snapshot, 1))).toThrow("不存在的字段 removed");
    expect(decodeChatMirrorFile(mirror(snapshot, 1))).toBeNull();
    expect(snapshot).toEqual(before);
  });

  it("保存拒绝不完整当前快照与空间身份冲突", () => {
    const current = migrateMemorySpaceSnapshot({
      version: "legacy-macros",
      snapshot: legacySnapshotFixture(),
    });
    const orphan = {
      ...current,
      records: [{ ...current.records[0]!, fieldEvidence: { removed: [] } }],
    };
    expect(() => createBackupFile({ spaces: [orphan] }, "test", "now")).toThrow(
      "不存在的字段 removed",
    );
    expect(() => createChatMirrorFile(orphan, "space", "now", "test")).toThrow(
      "不存在的字段 removed",
    );
    expect(() => createChatMirrorFile(current, "another-space", "now", "test")).toThrow(
      "空间身份不一致",
    );
    expect(() => createBackupFile({ spaces: [current, current] }, "test", "now")).toThrow(
      "id 重复",
    );
    const table = { ...current.tables[0]! };
    Reflect.deleteProperty(table, "position");
    expect(() =>
      migrateMemorySpaceSnapshot({ version: 1, snapshot: { ...current, tables: [table] } }),
    ).toThrow("position");
    const group = { ...current.tables[0]!.vectorIndex!.groups[0]! };
    Reflect.deleteProperty(group, "key");
    const vectorTable = {
      ...current.tables[0]!,
      vectorIndex: { ...current.tables[0]!.vectorIndex!, groups: [group] },
    };
    expect(() =>
      migrateMemorySpaceSnapshot({ version: 1, snapshot: { ...current, tables: [vectorTable] } }),
    ).toThrow("key");
  });

  it("当前快照保存重开保持原样，当前缺字段和未知版本直接拒绝", () => {
    const current = migrateMemorySpaceSnapshot({
      version: "legacy-macros",
      snapshot: legacySnapshotFixture(),
    });
    expect(migrateMemorySpaceSnapshot({ version: current.schemaVersion, snapshot: current })).toBe(
      current,
    );
    const file = createBackupFile({ spaces: [current] }, "test", "now");
    expect(decodeBackupFile(JSON.parse(JSON.stringify(file))).data.spaces[0]).toEqual(current);
    const chat = createChatMirrorFile(current, "space", "now", "test");
    expect(decodeChatMirrorFile(JSON.parse(JSON.stringify(chat)))!.data).toEqual(current);
    const brokenSpace = { ...current.space };
    Reflect.deleteProperty(brokenSpace, "macros");
    const broken = { ...current, space: brokenSpace };
    expect(() => decodeBackupFile({ ...file, data: { spaces: [broken] } })).toThrow("macros");
    expect(() => createBackupFile({ spaces: [broken as typeof current] }, "test", "now")).toThrow(
      "macros",
    );
    expect(decodeChatMirrorFile({ ...chat, data: broken })).toBeNull();
    expect(() =>
      decodeBackupFile({ ...file, data: { spaces: [{ ...current, schemaVersion: 999 }] } }),
    ).toThrow("schemaVersion");
    expect(() => decodeBackupFile(backup(current, 1))).toThrow("不应含 schemaVersion");
    expect(decodeChatMirrorFile(mirror({ ...current, schemaVersion: 999 }, 2))).toBeNull();
    expect(() => decodeBackupFile(backup(current, 999))).toThrow("文件版本不支持");
  });
});
