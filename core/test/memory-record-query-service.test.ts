import {
  MemoryRecordQueryService,
  type MemoryField,
  type MemoryFieldId,
  type MemoryFieldValue,
  type MemoryRecord,
  type MemoryRecordId,
  type MemoryRevisionId,
  type MemorySpaceId,
  type MemoryTable,
  type MemoryTableId,
  type MemoryTableKey,
} from "../src/memory/index.ts";
import type {
  MemoryFieldRepository,
  MemoryRecordRepository,
  MemoryTableRepository,
} from "../src/memory/adapter.ts";
import { describe, expect, it } from "vitest";

const spaceId = "space-1" as MemorySpaceId;
const tableId = "table-1" as MemoryTableId;
const nameId = "field-name" as MemoryFieldId;
const ageId = "field-age" as MemoryFieldId;
const activeId = "field-active" as MemoryFieldId;
const birthdayId = "field-birthday" as MemoryFieldId;
const statusId = "field-status" as MemoryFieldId;
const tagsId = "field-tags" as MemoryFieldId;
const timestamp = "2026-07-30T00:00:00.000Z";

const table: MemoryTable = {
  id: tableId,
  memorySpaceId: spaceId,
  key: "characters" as MemoryTableKey,
  kind: "custom",
  name: "人物",
  description: "",
  prompt: "",
  enabled: true,
  displayStrategy: { type: "field", fieldId: nameId },
  createdAt: timestamp,
  updatedAt: timestamp,
};

function field(id: MemoryFieldId, type: MemoryField["type"]): MemoryField {
  return {
    id,
    memorySpaceId: spaceId,
    tableId,
    key: id as unknown as MemoryField["key"],
    name: id,
    type,
    required: false,
    prompt: "",
    enabled: true,
    position: 0,
    options: [],
    referenceTableId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function record(
  id: string,
  name: string,
  age: number,
  active: boolean,
  status: string,
  tags: readonly string[],
): MemoryRecord {
  return {
    id: id as MemoryRecordId,
    memorySpaceId: spaceId,
    tableId,
    payload: {
      [nameId]: name,
      [ageId]: age,
      [activeId]: active,
      [statusId]: status,
      [tagsId]: tags,
    },
    fieldEvidence: {},
    displayText: name,
    source: { type: "manual" },
    revisionId: `revision-${id}` as MemoryRevisionId,
    revisionSource: "user",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function queryService() {
  const fields = [
    field(nameId, "short_text"),
    field(ageId, "integer"),
    field(activeId, "boolean"),
    field(birthdayId, "date"),
    { ...field(statusId, "single_select"), options: ["正常", "受伤", "死亡"] },
    field(tagsId, "short_text_list"),
  ];
  const records = [
    record("record-c", "顾川", 27, true, "正常", ["剑"]),
    record("record-b", "周遥", 30, false, "受伤", ["琴"]),
    record("record-a", "林夏", 27, true, "受伤", ["剑", "琴"]),
  ];
  const tables: MemoryTableRepository = {
    async create() {},
    async delete() {
      return false;
    },
    async find(candidateSpaceId, candidateTableId) {
      return candidateSpaceId === spaceId && candidateTableId === tableId ? table : undefined;
    },
    async findByKey() {
      return undefined;
    },
    async list() {
      return [table];
    },
    async update() {
      return false;
    },
  };
  const fieldRepository: MemoryFieldRepository = {
    async create() {},
    async delete() {
      return false;
    },
    async find(_spaceId, _tableId, id) {
      return fields.find((candidate) => candidate.id === id);
    },
    async findByKey() {
      return undefined;
    },
    async list() {
      return fields;
    },
    async update() {
      return false;
    },
  };
  const recordRepository: MemoryRecordRepository = {
    async create() {},
    async find(_spaceId, _tableId, id) {
      return records.find((candidate) => candidate.id === id);
    },
    async list() {
      return records;
    },
    async commit() {
      return false;
    },
    async listHistory() {
      return [];
    },
  };
  return new MemoryRecordQueryService(tables, fieldRepository, recordRepository);
}

describe("MemoryRecordQueryService", () => {
  it("combines typed conditions, projects fields, and stabilizes field sorting by record ID", async () => {
    const result = await queryService().query(spaceId, {
      tableId,
      fieldIds: [nameId],
      conditions: [
        { fieldId: activeId, operator: "equals", value: true },
        { fieldId: ageId, operator: "greater_than_or_equal", value: 27 },
      ],
      paging: { page: 1, pageSize: 10 },
      order: { fieldId: ageId, direction: "asc" },
    });

    expect(result).toMatchObject({
      page: 1,
      pageSize: 10,
      total: 2,
      totalPages: 1,
      records: [
        { id: "record-a", payload: { [nameId]: "林夏" } },
        { id: "record-c", payload: { [nameId]: "顾川" } },
      ],
    });
  });

  it("reports the complete query context when a typed condition value is invalid", async () => {
    const input = {
      tableId,
      fieldIds: [nameId],
      conditions: [{ fieldId: birthdayId, operator: "equals" as const, value: "2026-02-30" }],
      paging: { page: 2, pageSize: 5 },
      order: { fieldId: nameId, direction: "desc" as const },
    };

    await expect(queryService().query(spaceId, input)).rejects.toThrowError(
      expect.objectContaining({
        type: "memory_record_query_invalid",
        param: {
          ...input,
          fieldId: birthdayId,
          reason: "condition_invalid",
        },
      }),
    );
  });

  it("rejects malformed conditions without evaluating arbitrary expressions", async () => {
    await expect(
      queryService().query(spaceId, {
        tableId,
        conditions: [null as never],
        paging: { page: 1, pageSize: 10 },
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        type: "memory_record_query_invalid",
        param: expect.objectContaining({ reason: "shape_invalid" }),
      }),
    );
  });
});

describe("in/not_in 多值算子", () => {
  it("in 对单值字段做成员匹配，与排序/分页/投影组合语义不变", async () => {
    const result = await queryService().query(spaceId, {
      tableId,
      fieldIds: [nameId, statusId],
      conditions: [{ fieldId: statusId, operator: "in", value: ["正常", "死亡"] }],
      paging: { page: 1, pageSize: 10 },
      order: { fieldId: nameId, direction: "asc" },
    });
    expect(result).toMatchObject({
      total: 1,
      totalPages: 1,
      records: [{ id: "record-c", payload: { [nameId]: "顾川", [statusId]: "正常" } }],
    });

    const byAge = await queryService().query(spaceId, {
      tableId,
      conditions: [{ fieldId: ageId, operator: "in", value: [27, 30] }],
      paging: { page: 1, pageSize: 2 },
      order: { fieldId: ageId, direction: "asc" },
    });
    expect(byAge).toMatchObject({
      total: 3,
      totalPages: 2,
      records: [{ id: "record-a" }, { id: "record-c" }],
    });

    const byName = await queryService().query(spaceId, {
      tableId,
      conditions: [{ fieldId: nameId, operator: "in", value: ["顾川", "林夏"] }],
      paging: { page: 1, pageSize: 10 },
    });
    expect(byName.records.map((record) => record.id).sort()).toEqual(["record-a", "record-c"]);
  });

  it("not_in 取反：不在数组中的记录命中", async () => {
    const result = await queryService().query(spaceId, {
      tableId,
      conditions: [{ fieldId: statusId, operator: "not_in", value: ["受伤"] }],
      paging: { page: 1, pageSize: 10 },
    });
    expect(result.records.map((record) => record.id)).toEqual(["record-c"]);
  });

  it("空数组与元素类型/选项不匹配被拒绝", async () => {
    const invalid = (condition: {
      fieldId: MemoryFieldId | "$record_id";
      operator: "in";
      value: MemoryFieldValue;
    }) =>
      queryService().query(spaceId, {
        tableId,
        conditions: [condition],
        paging: { page: 1, pageSize: 10 },
      });
    const rejected = expect.objectContaining({
      type: "memory_record_query_invalid",
      param: expect.objectContaining({ reason: "condition_invalid" }),
    });

    await expect(invalid({ fieldId: statusId, operator: "in", value: [] })).rejects.toThrowError(
      rejected,
    );
    await expect(
      invalid({ fieldId: statusId, operator: "in", value: [1, 2] as unknown as MemoryFieldValue }),
    ).rejects.toThrowError(rejected);
    await expect(
      invalid({ fieldId: ageId, operator: "in", value: ["27"] as unknown as MemoryFieldValue }),
    ).rejects.toThrowError(rejected);
    await expect(
      invalid({ fieldId: statusId, operator: "in", value: ["不存在"] }),
    ).rejects.toThrowError(rejected);
  });

  it("列表字段拒绝 in/not_in（成员匹配已有 contains/not_contains）", async () => {
    const rejected = expect.objectContaining({
      type: "memory_record_query_invalid",
      param: expect.objectContaining({ reason: "condition_invalid" }),
    });
    await expect(
      queryService().query(spaceId, {
        tableId,
        conditions: [{ fieldId: tagsId, operator: "in", value: ["剑"] }],
        paging: { page: 1, pageSize: 10 },
      }),
    ).rejects.toThrowError(rejected);
    await expect(
      queryService().query(spaceId, {
        tableId,
        conditions: [{ fieldId: tagsId, operator: "not_in", value: ["剑"] }],
        paging: { page: 1, pageSize: 10 },
      }),
    ).rejects.toThrowError(rejected);
  });

  it("$record_id 支持 in/not_in；空数组/非字符串数组/标量拒绝；其余系统字段拒绝", async () => {
    const query = (conditions: QueryRecordsCondition[]) =>
      queryService().query(spaceId, {
        tableId,
        conditions,
        paging: { page: 1, pageSize: 10 },
      });

    const byId = await query([{ fieldId: "$record_id", operator: "in", value: ["record-a"] }]);
    expect(byId.records.map((record) => record.id)).toEqual(["record-a"]);

    const notIn = await query([
      { fieldId: "$record_id", operator: "not_in", value: ["record-a", "record-b"] },
    ]);
    expect(notIn.records.map((record) => record.id)).toEqual(["record-c"]);

    const rejected = expect.objectContaining({
      type: "memory_record_query_invalid",
      param: expect.objectContaining({ reason: "condition_invalid" }),
    });
    await expect(query([{ fieldId: "$record_id", operator: "in", value: [] }])).rejects.toThrowError(
      rejected,
    );
    await expect(
      query([
        { fieldId: "$record_id", operator: "in", value: [1, 2] as unknown as MemoryFieldValue },
      ]),
    ).rejects.toThrowError(rejected);
    await expect(
      query([{ fieldId: "$record_id", operator: "in", value: "record-a" }]),
    ).rejects.toThrowError(rejected);
    await expect(
      query([{ fieldId: "$display_text", operator: "in", value: ["顾川"] }]),
    ).rejects.toThrowError(rejected);
    await expect(
      query([{ fieldId: "$created_at", operator: "in", value: [timestamp] }]),
    ).rejects.toThrowError(rejected);
    await expect(
      query([{ fieldId: "$updated_at", operator: "not_in", value: [timestamp] }]),
    ).rejects.toThrowError(rejected);
  });
});
