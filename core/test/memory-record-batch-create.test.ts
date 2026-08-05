import {
  MemoryRecordService,
  type MemoryEvidence,
  type MemoryField,
  type MemoryFieldId,
  type MemoryRecord,
  type MemoryRecordHistory,
  type MemoryRecordId,
  type MemoryRevisionId,
  type MemorySpaceId,
  type MemoryTable,
  type MemoryTableId,
} from "../src/memory/index.ts";
import type {
  MemoryFieldRepository,
  MemoryRecordMutation,
  MemoryRecordRepository,
  MemoryTableRepository,
} from "../src/memory/adapter.ts";
import { describe, expect, it } from "vitest";

const spaceId = "space-1" as MemorySpaceId;
const peopleId = "people" as MemoryTableId;
const placesId = "places" as MemoryTableId;
const nameId = "name" as MemoryFieldId;
const homeId = "home" as MemoryFieldId;

function table(id: MemoryTableId): MemoryTable {
  return {
    id,
    memorySpaceId: spaceId,
    key: id,
    kind: "custom",
    name: id,
    description: "",
    prompt: "",
    enabled: true,
    displayStrategy: { type: "field", fieldId: nameId },
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

function field(
  id: MemoryFieldId,
  tableId: MemoryTableId,
  referenceTableId: MemoryTableId | null = null,
): MemoryField {
  return {
    id,
    memorySpaceId: spaceId,
    tableId,
    name: id,
    type: referenceTableId === null ? "short_text" : "single_reference",
    required: id === nameId,
    prompt: "",
    enabled: true,
    position: 0,
    options: [],
    referenceTableId,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

/** 内存仓库：与 SQLite 实现相同的语义（create 插入无历史；replace 写历史 + 乐观锁）。 */
class Records implements MemoryRecordRepository {
  readonly values: MemoryRecord[] = [];
  readonly history: MemoryRecordHistory[] = [];
  readonly committedEvidence: readonly MemoryEvidence[][] = [];

  async create(record: MemoryRecord): Promise<void> {
    this.values.push(record);
  }

  async find(memorySpaceId: MemorySpaceId, tableId: MemoryTableId, id: MemoryRecordId) {
    return this.values.find(
      (record) =>
        record.memorySpaceId === memorySpaceId && record.tableId === tableId && record.id === id,
    );
  }

  async list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId) {
    return this.values.filter(
      (record) => record.memorySpaceId === memorySpaceId && record.tableId === tableId,
    );
  }

  async commit(
    mutations: readonly MemoryRecordMutation[],
    evidence: readonly MemoryEvidence[],
  ): Promise<boolean> {
    if (
      mutations.some(
        (mutation) =>
          mutation.kind === "replace" &&
          this.values.find(
            (record) =>
              record.memorySpaceId === mutation.previous.memorySpaceId &&
              record.tableId === mutation.previous.tableId &&
              record.id === mutation.previous.id,
          )?.revisionId !== mutation.previous.revisionId,
      )
    ) {
      return false;
    }
    this.committedEvidence.push(evidence);
    for (const mutation of mutations) {
      if (mutation.kind === "create") {
        this.values.push(mutation.current);
        continue;
      }
      this.history.push(mutation.history);
      const index = this.values.findIndex((record) => record.id === mutation.previous.id);
      if (mutation.current) this.values[index] = mutation.current;
      else this.values.splice(index, 1);
    }
    return true;
  }

  async listHistory(query: Parameters<MemoryRecordRepository["listHistory"]>[0]) {
    return this.history.filter(
      (item) =>
        item.memorySpaceId === query.memorySpaceId &&
        (!query.tableId || item.tableId === query.tableId) &&
        (!query.recordId || item.recordId === query.recordId) &&
        (!query.revisionId || item.revisionId === query.revisionId) &&
        (!query.archivedFrom || item.archivedAt >= query.archivedFrom) &&
        (!query.archivedTo || item.archivedAt <= query.archivedTo),
    );
  }
}

function setup() {
  const tables = [table(peopleId), table(placesId)];
  const fields = [
    field(nameId, peopleId),
    field(homeId, peopleId, placesId),
    field(nameId, placesId),
  ];
  const records = new Records();
  let recordNumber = 0;
  let historyNumber = 0;
  const tableRepository: MemoryTableRepository = {
    async create() {},
    delete: async () => false,
    find: async (candidateSpaceId, id) =>
      tables.find((item) => item.memorySpaceId === candidateSpaceId && item.id === id),
    findByKey: async (candidateSpaceId, key) =>
      tables.find((item) => item.memorySpaceId === candidateSpaceId && item.key === key),
    list: async (candidateSpaceId) =>
      tables.filter((item) => item.memorySpaceId === candidateSpaceId),
    update: async () => false,
  };
  const fieldRepository: MemoryFieldRepository = {
    async create() {},
    delete: async () => false,
    find: async (candidateSpaceId, tableId, id) =>
      fields.find(
        (item) =>
          item.memorySpaceId === candidateSpaceId && item.tableId === tableId && item.id === id,
      ),
    findByKey: async (candidateSpaceId, tableId, key) =>
      fields.find(
        (item) =>
          item.memorySpaceId === candidateSpaceId && item.tableId === tableId && item.key === key,
      ),
    list: async (candidateSpaceId, tableId) =>
      fields.filter((item) => item.memorySpaceId === candidateSpaceId && item.tableId === tableId),
    update: async () => false,
  };
  return {
    records,
    service: new MemoryRecordService(
      tableRepository,
      fieldRepository,
      records,
      () => `record-${++recordNumber}` as MemoryRecordId,
      () => `history-${++historyNumber}`,
      () => "revision-batch" as MemoryRevisionId,
      () => "2026-07-28T02:00:00.000Z",
    ),
  };
}

describe("MemoryRecordService 批量 create", () => {
  it("create/update/delete 在同一原子批次提交：临时 ID 解析为真实 ID，create 不写历史", async () => {
    const { records, service } = setup();
    const linxia = (await service.create(spaceId, peopleId, { payload: { [nameId]: "林夏" } }))!;
    const yunjin = (await service.create(spaceId, peopleId, { payload: { [nameId]: "云烬" } }))!;

    const result = await service.mutate(
      spaceId,
      {
        revisionSource: "agent",
        operations: [
          { type: "create", tableId: placesId, tempId: "tmp:r1", patch: { [nameId]: "港口" } },
          {
            type: "create",
            tableId: peopleId,
            tempId: "tmp:r2",
            patch: { [nameId]: "周遥", [homeId]: "tmp:r1" },
          },
          {
            type: "update",
            tableId: peopleId,
            recordId: linxia.id,
            expectedRevisionId: linxia.revisionId,
            patch: { [homeId]: "tmp:r1" },
          },
          {
            type: "delete",
            tableId: peopleId,
            recordId: yunjin.id,
            expectedRevisionId: yunjin.revisionId,
          },
        ],
      },
      [],
    );

    expect(result).toMatchObject({ revisionId: "revision-batch", changed: 4 });
    const port = records.values.find((record) => record.payload[nameId] === "港口")!;
    const zhouyao = records.values.find((record) => record.payload[nameId] === "周遥")!;
    expect(port).toMatchObject({
      id: "record-3",
      payload: { [nameId]: "港口" },
      revisionId: "revision-batch",
      revisionSource: "agent",
      source: { type: "manual" },
      createdAt: "2026-07-28T02:00:00.000Z",
    });
    expect(zhouyao).toMatchObject({
      id: "record-4",
      payload: { [nameId]: "周遥", [homeId]: "record-3" },
      revisionId: "revision-batch",
      revisionSource: "agent",
    });
    // 引用字段的 tmp: 值被改写为真实 ID，而非原样入库
    expect(zhouyao.payload[homeId]).toBe(port.id);
    expect(await records.find(spaceId, peopleId, linxia.id)).toMatchObject({
      payload: { [nameId]: "林夏", [homeId]: port.id },
      revisionId: "revision-batch",
    });
    expect(await records.find(spaceId, peopleId, yunjin.id)).toBeUndefined();
    // 历史只含 update/delete 的旧快照；create 无旧状态不写历史
    expect(records.history).toEqual([
      expect.objectContaining({ recordId: linxia.id, revisionId: "revision-batch" }),
      expect.objectContaining({ recordId: yunjin.id, revisionId: "revision-batch" }),
    ]);
  });

  it("批次内任何操作的预期 revision 过期时整批失败，create 不落库", async () => {
    const { records, service } = setup();
    const linxia = (await service.create(spaceId, peopleId, { payload: { [nameId]: "林夏" } }))!;

    await expect(
      service.mutate(
        spaceId,
        {
          revisionSource: "agent",
          operations: [
            { type: "create", tableId: placesId, tempId: "tmp:r1", patch: { [nameId]: "港口" } },
            {
              type: "update",
              tableId: peopleId,
              recordId: linxia.id,
              expectedRevisionId: "stale" as MemoryRevisionId,
              patch: { [nameId]: "周遥" },
            },
          ],
        },
        [],
      ),
    ).rejects.toThrowError(expect.objectContaining({ type: "memory_record_revision_conflict" }));
    expect(records.values).toHaveLength(1);
    expect(records.history).toHaveLength(0);
    expect(records.committedEvidence).toHaveLength(0);
  });

  it("引用不存在的批内临时 ID 时报引用错误", async () => {
    const { service } = setup();

    await expect(
      service.mutate(
        spaceId,
        {
          revisionSource: "agent",
          operations: [
            {
              type: "create",
              tableId: peopleId,
              tempId: "tmp:r1",
              patch: { [nameId]: "周遥", [homeId]: "tmp:missing" },
            },
          ],
        },
        [],
      ),
    ).rejects.toThrowError(expect.objectContaining({ type: "memory_record_reference_invalid" }));
  });
});
