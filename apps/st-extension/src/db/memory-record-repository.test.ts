import { createServices, createTestDatabase, NOW } from "./test-support.ts";
import { SystemMemoryTableInstaller } from "@ste-memory/memory-host-shared";
import type {
  MemoryField,
  MemoryFieldId,
  MemoryRecordHistoryId,
  MemoryRecordId,
  MemoryRecordMutation,
  MemoryRevisionId,
  MemorySpace,
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
} from "@ste-memory/core/memory";
import { Dexie, type Table } from "dexie";
import { describe, expect, it } from "vitest";
import { SteMemoryDatabase } from "./database.ts";
import { DexieMemoryRecordRepository } from "./memory-record-repository.ts";

async function setup() {
  const services = createServices(createTestDatabase());
  const space = await services.spaces.create("会话");
  await new SystemMemoryTableInstaller(services.tables, services.fields).install(space.id);
  const table = (await services.tableRepository.list(space.id)).find(
    (item) => item.key === "characters",
  )!;
  const fields = await services.fieldRepository.list(space.id, table.id);
  const name = fields.find((field) => field.name === "名称")!;
  const identity = fields.find((field) => field.name === "身份/定位")!;
  return { ...services, space, table, fields, name, identity };
}

/** ticket 03 时代的 v1 schema，用于验证 v1 → v2 升级路径。 */
class SteMemoryDatabaseV1 extends Dexie {
  memorySpaces!: Table<MemorySpace, MemorySpaceId>;
  memoryTables!: Table<MemoryTable, MemoryTableId>;
  memoryFields!: Table<MemoryField, MemoryFieldId>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      memorySpaces: "id",
      memoryTables: "id, &[memorySpaceId+key], memorySpaceId",
      memoryFields: "id, &[memorySpaceId+tableId+key], [memorySpaceId+tableId]",
    });
  }
}

describe("Dexie memory record repository", () => {
  it("creates records with manual or explicit source information", async () => {
    const { records, recordRepository, space, table, name, identity } = await setup();

    const first = await records.create(space.id, table.id, {
      payload: { [name.id]: "林夏", [identity.id]: "调查员" },
    });
    expect(first).toMatchObject({
      displayText: "林夏",
      source: { type: "manual" },
      revisionSource: "user",
      payload: { [name.id]: "林夏", [identity.id]: "调查员" },
    });
    expect(await recordRepository.find(space.id, table.id, first!.id)).toEqual(first);

    const second = await records.create(space.id, table.id, {
      payload: { [name.id]: "周遥", [identity.id]: "记者" },
      source: {
        type: "source",
        sourceTime: "2026-07-27T11:30:00.000Z",
        sourceLocation: "消息 42",
      },
    });
    expect(second?.source).toEqual({
      type: "source",
      sourceTime: "2026-07-27T11:30:00.000Z",
      sourceLocation: "消息 42",
    });

    // 创建时间升序（id 兜底）
    expect(await recordRepository.list(space.id, table.id)).toEqual([first, second]);

    // 分页与搜索（core 服务层语义）
    const page = await records.list(space.id, table.id, { page: 1, pageSize: 1, search: "记者" });
    expect(page).toMatchObject({
      page: 1,
      pageSize: 1,
      total: 1,
      totalPages: 1,
      records: [{ displayText: "周遥" }],
    });
  });

  it("patches records, archives the old snapshot, and rejects stale revisions", async () => {
    const { records, space, table, name, identity } = await setup();
    const created = await records.create(space.id, table.id, {
      payload: { [name.id]: "林夏", [identity.id]: "调查员" },
    });

    const updated = await records.update(space.id, table.id, created!.id, {
      expectedRevisionId: created!.revisionId,
      patch: { [identity.id]: null },
      revisionSource: "user",
    });
    expect(updated).toMatchObject({
      displayText: "林夏",
      payload: { [name.id]: "林夏", [identity.id]: null },
      revisionSource: "user",
    });
    expect(updated!.revisionId).not.toBe(created!.revisionId);

    await expect(
      records.update(space.id, table.id, created!.id, {
        expectedRevisionId: created!.revisionId,
        patch: { [name.id]: "周遥" },
        revisionSource: "user",
      }),
    ).rejects.toMatchObject({
      type: "memory_record_revision_conflict",
      param: { recordId: created!.id },
    });

    // 修订批次归档旧状态，可按 tableId/recordId/revisionId/归档时间窗查询
    const histories = await records.listHistory(space.id, {
      tableId: table.id,
      recordId: created!.id,
      revisionId: updated!.revisionId,
      archivedFrom: NOW,
      archivedTo: NOW,
    });
    expect(histories).toEqual([
      expect.objectContaining({
        recordId: created!.id,
        payload: { [name.id]: "林夏", [identity.id]: "调查员" },
      }),
    ]);
  });

  it("archives a complete snapshot before physically deleting a current record", async () => {
    const { records, space, table, name } = await setup();
    const created = await records.create(space.id, table.id, {
      payload: { [name.id]: "林夏" },
    });

    expect(
      await records.delete(space.id, table.id, created!.id, created!.revisionId, "user"),
    ).toBe(true);
    expect(await records.find(space.id, table.id, created!.id)).toBeUndefined();

    const histories = await records.listHistory(space.id, { recordId: created!.id });
    expect(histories).toEqual([
      expect.objectContaining({ recordId: created!.id, displayText: "林夏" }),
    ]);
  });

  it("returns reference locations and preserves a target when deletion is blocked", async () => {
    const { records, space, table, fields, tableRepository, fieldRepository } = await setup();
    const characterName = fields.find((field) => field.name === "名称")!;
    const locationTable = (await tableRepository.list(space.id)).find(
      (candidate) => candidate.key === "locations",
    )!;
    const locationFields = await fieldRepository.list(space.id, locationTable.id);
    const locationName = locationFields.find((field) => field.name === "名称")!;
    const relatedCharacters = locationFields.find((field) => field.name === "相关人物")!;

    const character = await records.create(space.id, table.id, {
      payload: { [characterName.id]: "林夏" },
    });
    const location = await records.create(space.id, locationTable.id, {
      payload: { [locationName.id]: "港口", [relatedCharacters.id]: [character!.id] },
    });

    const blocked = records.delete(space.id, table.id, character!.id, character!.revisionId, "user");
    await expect(blocked).rejects.toMatchObject({
      type: "memory_record_referenced",
      param: {
        recordId: character!.id,
        references: [
          { tableId: locationTable.id, recordId: location!.id, fieldId: relatedCharacters.id },
        ],
      },
    });
    expect(await records.find(space.id, table.id, character!.id)).toBeDefined();
  });

  it("rejects a reference field value whose target record does not exist", async () => {
    const { records, space, tableRepository, fieldRepository } = await setup();
    const locationTable = (await tableRepository.list(space.id)).find(
      (candidate) => candidate.key === "locations",
    )!;
    const locationFields = await fieldRepository.list(space.id, locationTable.id);
    const locationName = locationFields.find((field) => field.name === "名称")!;
    const relatedCharacters = locationFields.find((field) => field.name === "相关人物")!;

    await expect(
      records.create(space.id, locationTable.id, {
        payload: { [locationName.id]: "港口", [relatedCharacters.id]: ["record-999"] },
      }),
    ).rejects.toMatchObject({
      type: "memory_record_reference_invalid",
      param: { fieldId: relatedCharacters.id },
    });
  });

  it("commits a mixed create/update batch atomically with one shared revision", async () => {
    const { records, recordRepository, space, table, name, tableRepository, fieldRepository } =
      await setup();
    const locationTable = (await tableRepository.list(space.id)).find(
      (candidate) => candidate.key === "locations",
    )!;
    const locationFields = await fieldRepository.list(space.id, locationTable.id);
    const locationName = locationFields.find((field) => field.name === "名称")!;
    const relatedCharacters = locationFields.find((field) => field.name === "相关人物")!;
    const created = await records.create(space.id, table.id, {
      payload: { [name.id]: "林夏" },
    });

    const result = await records.mutate(
      space.id,
      {
        revisionSource: "agent",
        operations: [
          {
            type: "create",
            tableId: table.id,
            tempId: "tmp:character",
            patch: { [name.id]: "周遥" },
          },
          {
            type: "create",
            tableId: locationTable.id,
            tempId: "tmp:location",
            patch: {
              [locationName.id]: "港口",
              [relatedCharacters.id]: ["tmp:character"],
            },
          },
          {
            type: "update",
            tableId: table.id,
            recordId: created!.id,
            expectedRevisionId: created!.revisionId,
            patch: { [name.id]: "林夏（修订）" },
          },
        ],
      },
      [],
    );

    expect(result.changed).toBe(3);
    // 批内临时 ID 解析为真实记录 ID，三条变更共享同一修订身份
    const [location] = await recordRepository.list(space.id, locationTable.id);
    // 创建时间相同 → id 升序：record-1 是批前创建的旧角色，record-2 是批内新角色
    const [updatedCharacter, newCharacter] = await recordRepository.list(space.id, table.id);
    expect(updatedCharacter).toMatchObject({
      id: created!.id,
      revisionId: result.revisionId,
      displayText: "林夏（修订）",
    });
    expect(newCharacter).toMatchObject({
      revisionId: result.revisionId,
      revisionSource: "agent",
      displayText: "周遥",
    });
    expect(location).toMatchObject({
      revisionId: result.revisionId,
      revisionSource: "agent",
      payload: { [locationName.id]: "港口", [relatedCharacters.id]: [newCharacter!.id] },
    });
  });

  it("returns false when a replace mutation hits a stale revision (commit 乐观锁)", async () => {
    const { records, recordRepository, space, table, name } = await setup();
    const created = await records.create(space.id, table.id, {
      payload: { [name.id]: "林夏" },
    });
    const stale = { ...created!, revisionId: "stale-revision" as MemoryRevisionId };
    const mutations: MemoryRecordMutation[] = [
      {
        kind: "replace",
        previous: stale,
        current: { ...stale, revisionId: "next-revision" as MemoryRevisionId },
        // 上面的展开会丢掉 branded 类型，这里重新断言
        history: {
          id: "history-1" as MemoryRecordHistoryId,
          recordId: stale.id,
          memorySpaceId: stale.memorySpaceId,
          tableId: stale.tableId,
          payload: stale.payload,
          fieldEvidence: stale.fieldEvidence,
          displayText: stale.displayText,
          source: stale.source,
          previousRevisionId: stale.revisionId,
          previousRevisionSource: stale.revisionSource,
          revisionId: "next-revision" as MemoryRevisionId,
          revisionSource: "user",
          createdAt: stale.createdAt,
          updatedAt: stale.updatedAt,
          archivedAt: NOW,
        },
      },
    ];

    expect(await recordRepository.commit(mutations, [])).toBe(false);
    // 整批回滚：记录与历史均未变
    expect((await recordRepository.find(space.id, table.id, created!.id))?.revisionId).toBe(
      created!.revisionId,
    );
    expect(
      await recordRepository.listHistory({ memorySpaceId: space.id, recordId: created!.id }),
    ).toEqual([]);
  });

  it("persists snapshot and reference evidence, reuses source identity, and archives old evidence", async () => {
    const { records, recordRepository, space, table, name, identity } = await setup();
    const snapshot = {
      source_type: "sillytavern_jsonl",
      source_id: 7,
      content: "林夏自称调查员。",
      storage_mode: "snapshot",
      extraProps: { name: "林夏", lineNumber: 8 },
    } as const;
    const reference = {
      source_type: "sillytavern_jsonl",
      source_id: 8,
      storage_mode: "reference",
      extraProps: { lineNumber: 9 },
    } as const;

    const created = await records.create(space.id, table.id, {
      payload: { [name.id]: "林夏", [identity.id]: "调查员" },
      fieldEvidence: { [name.id]: [snapshot], [identity.id]: [reference] },
    });
    expect(created!.fieldEvidence[name.id]![0]).toMatchObject({
      source_id: 7,
      storage_mode: "snapshot",
      content: snapshot.content,
      extraProps: snapshot.extraProps,
    });
    expect(created!.fieldEvidence[identity.id]![0]).toMatchObject({
      source_id: 8,
      storage_mode: "reference",
      extraProps: reference.extraProps,
    });
    expect(created!.fieldEvidence[identity.id]![0]).not.toHaveProperty("content");
    // 有字段证据 → 来源按推断为 source
    expect(created!.source).toEqual({ type: "source", sourceTime: null, sourceLocation: null });

    // 同一来源身份复用同一条证据（证据条目可写可读）
    const duplicate = await records.create(space.id, table.id, {
      payload: { [name.id]: "林夏（化名）" },
      fieldEvidence: { [name.id]: [snapshot] },
    });
    expect(duplicate!.fieldEvidence[name.id]![0]!.evidence_id).toBe(
      created!.fieldEvidence[name.id]![0]!.evidence_id,
    );
    expect(await recordRepository.findEvidence(space.id, "sillytavern_jsonl", 7)).toMatchObject({
      source_id: 7,
      storage_mode: "snapshot",
      content: snapshot.content,
    });

    const conflictingMode = records.create(space.id, table.id, {
      payload: { [name.id]: "冲突模式" },
      fieldEvidence: {
        [name.id]: [
          {
            source_type: snapshot.source_type,
            source_id: snapshot.source_id,
            storage_mode: "reference",
          },
        ],
      },
    });
    await expect(conflictingMode).rejects.toMatchObject({
      type: "memory_evidence_storage_mode_conflict",
    });

    // 字符串来源 ID
    const stringReference = await records.create(space.id, table.id, {
      payload: { [name.id]: "编号来源" },
      fieldEvidence: {
        [name.id]: [
          {
            source_type: "external",
            source_id: "008",
            storage_mode: "reference",
            extraProps: { path: "messages/008" },
          },
        ],
      },
    });
    expect(stringReference!.fieldEvidence[name.id]![0]!.source_id).toBe("008");

    // 过期修订 + 证据的更新整体回滚，不残留孤儿证据
    const stale = records.update(space.id, table.id, created!.id, {
      expectedRevisionId: "stale-revision" as MemoryRevisionId,
      patch: { [name.id]: "不应保存" },
      revisionSource: "user",
      fieldEvidence: {
        [name.id]: [
          {
            source_type: "sillytavern_jsonl",
            source_id: 9,
            storage_mode: "snapshot",
            content: "冲突请求中的证据",
          },
        ],
      },
    });
    await expect(stale).rejects.toMatchObject({ type: "memory_record_revision_conflict" });
    expect(await recordRepository.findEvidence(space.id, "sillytavern_jsonl", 9)).toBeUndefined();

    // 更新清空被打补丁字段的证据，保留其余字段的证据
    const updated = await records.update(space.id, table.id, created!.id, {
      expectedRevisionId: created!.revisionId,
      patch: { [name.id]: "林夏（修订）" },
      revisionSource: "user",
    });
    expect(updated!.fieldEvidence[name.id]).toEqual([]);
    expect(updated!.fieldEvidence[identity.id]).toHaveLength(1);

    // 修订历史归档保留旧证据快照
    const history = await records.listHistory(space.id, { recordId: created!.id });
    expect(history[0]!.fieldEvidence[name.id]![0]).toMatchObject({
      source_id: 7,
      content: snapshot.content,
    });
  });

  it("isolates records by memory space and table (跨空间/跨表互不可见)", async () => {
    const services = createServices(createTestDatabase());
    const spaceA = await services.spaces.create("空间 A");
    const spaceB = await services.spaces.create("空间 B");
    await new SystemMemoryTableInstaller(services.tables, services.fields).install(spaceA.id);
    await new SystemMemoryTableInstaller(services.tables, services.fields).install(spaceB.id);
    const tableA = (await services.tableRepository.list(spaceA.id)).find(
      (item) => item.key === "characters",
    )!;
    const tableB = (await services.tableRepository.list(spaceB.id)).find(
      (item) => item.key === "characters",
    )!;
    const fieldsA = await services.fieldRepository.list(spaceA.id, tableA.id);
    const nameA = fieldsA.find((field) => field.name === "名称")!;
    const created = await services.records.create(spaceA.id, tableA.id, {
      payload: { [nameA.id]: "林夏" },
    });

    expect(await services.recordRepository.find(spaceB.id, tableA.id, created!.id)).toBeUndefined();
    expect(await services.recordRepository.find(spaceA.id, tableB.id, created!.id)).toBeUndefined();
    expect(await services.recordRepository.list(spaceB.id, tableA.id)).toEqual([]);
    // 缺表格 → 服务层返回 undefined
    expect(await services.records.list(spaceB.id, tableA.id, { page: 1, pageSize: 10 })).toBeUndefined();
  });

  it("cascades records, history and evidence on table/space deletion (ON DELETE CASCADE 同语义)", async () => {
    const { records, recordRepository, space, table, name, tableRepository, spaceRepository } =
      await setup();
    const created = await records.create(space.id, table.id, {
      payload: { [name.id]: "林夏" },
      fieldEvidence: {
        [name.id]: [
          {
            source_type: "sillytavern_jsonl",
            source_id: 7,
            content: "林夏自称调查员。",
            storage_mode: "snapshot",
          },
        ],
      },
    });
    await records.update(space.id, table.id, created!.id, {
      expectedRevisionId: created!.revisionId,
      patch: { [name.id]: "林夏（修订）" },
      revisionSource: "user",
    });

    // 删表格：记录与修订历史清空；证据只挂在空间上，不随表删
    await tableRepository.delete(space.id, table.id);
    expect(await recordRepository.find(space.id, table.id, created!.id)).toBeUndefined();
    expect(
      await recordRepository.listHistory({ memorySpaceId: space.id, recordId: created!.id }),
    ).toEqual([]);
    expect(await recordRepository.findEvidence(space.id, "sillytavern_jsonl", 7)).toBeDefined();

    // 删空间：证据一并清空，空间级历史清空
    await spaceRepository.delete(space.id);
    expect(await recordRepository.findEvidence(space.id, "sillytavern_jsonl", 7)).toBeUndefined();
    expect(await recordRepository.listHistory({ memorySpaceId: space.id })).toEqual([]);
  });

  it("orders history by archivedAt descending (最新修订在前)", async () => {
    // 递增时钟：每次 now() 推进一分钟，让修订时间可区分
    let tick = 0;
    const services = createServices(createTestDatabase(), () =>
      new Date(Date.parse(NOW) + ++tick * 60_000).toISOString(),
    );
    const space = await services.spaces.create("会话");
    await new SystemMemoryTableInstaller(services.tables, services.fields).install(space.id);
    const table = (await services.tableRepository.list(space.id)).find(
      (item) => item.key === "characters",
    )!;
    const fields = await services.fieldRepository.list(space.id, table.id);
    const name = fields.find((field) => field.name === "名称")!;

    const created = await services.records.create(space.id, table.id, {
      payload: { [name.id]: "林夏" },
    });
    const first = await services.records.update(space.id, table.id, created!.id, {
      expectedRevisionId: created!.revisionId,
      patch: { [name.id]: "林夏（第一次修订）" },
      revisionSource: "user",
    });
    const second = await services.records.update(space.id, table.id, created!.id, {
      expectedRevisionId: first!.revisionId,
      patch: { [name.id]: "林夏（第二次修订）" },
      revisionSource: "agent",
    });

    const histories = await services.records.listHistory(space.id, { recordId: created!.id });
    expect(histories.map((entry) => entry.displayText)).toEqual(["林夏（第一次修订）", "林夏"]);
    expect(histories[0]!.revisionId).toBe(second!.revisionId);
    expect(histories[1]!.revisionId).toBe(first!.revisionId);
  });

  it("upgrades an existing v1 database to v2 without data loss (schema 升级路径)", async () => {
    const name = "ste-memory-test-upgrade";
    const v1 = new SteMemoryDatabaseV1(name);
    await v1.open();
    await v1.memorySpaces.add({
      id: "space-1" as MemorySpaceId,
      name: "会话",
      createdAt: NOW,
      updatedAt: NOW,
    });
    v1.close();

    const upgraded = new SteMemoryDatabase(name);
    try {
      // v1 数据在升级后仍在
      expect((await upgraded.memorySpaces.get("space-1" as MemorySpaceId))?.name).toBe("会话");
      // v2 新增的表可用
      await upgraded.memoryRecords.add({
        id: "record-1" as MemoryRecordId,
        memorySpaceId: "space-1" as MemorySpaceId,
        tableId: "table-1" as MemoryTableId,
        payload: {},
        fieldEvidence: {},
        displayText: "林夏",
        source: { type: "manual" },
        revisionId: "revision-1" as MemoryRevisionId,
        revisionSource: "user",
        createdAt: NOW,
        updatedAt: NOW,
      });
      expect(await upgraded.memoryRecords.count()).toBe(1);
    } finally {
      await upgraded.delete();
    }
  });

  it("persists records and history across a database reopen (页面刷新语义)", async () => {
    const name = "ste-memory-test-records-reopen";
    const first = new SteMemoryDatabase(name);
    const services = createServices(first);
    const space = await services.spaces.create("会话");
    await new SystemMemoryTableInstaller(services.tables, services.fields).install(space.id);
    const table = (await services.tableRepository.list(space.id)).find(
      (item) => item.key === "characters",
    )!;
    const fields = await services.fieldRepository.list(space.id, table.id);
    const nameField = fields.find((field) => field.name === "名称")!;
    const created = await services.records.create(space.id, table.id, {
      payload: { [nameField.id]: "林夏" },
    });
    await services.records.update(space.id, table.id, created!.id, {
      expectedRevisionId: created!.revisionId,
      patch: { [nameField.id]: "林夏（修订）" },
      revisionSource: "user",
    });
    first.close();

    const second = new SteMemoryDatabase(name);
    try {
      const reopened = new DexieMemoryRecordRepository(second);
      // v2 schema 升级后记录与修订历史都还在
      expect((await reopened.find(space.id, table.id, created!.id))?.displayText).toBe(
        "林夏（修订）",
      );
      expect(await reopened.listHistory({ memorySpaceId: space.id, recordId: created!.id })).toEqual([
        expect.objectContaining({ recordId: created!.id, displayText: "林夏" }),
      ]);
    } finally {
      await second.delete();
    }
  });
});
