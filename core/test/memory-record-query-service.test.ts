import {
  MemoryRecordQueryService,
  type MemoryField,
  type MemoryFieldId,
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

function record(id: string, name: string, age: number, active: boolean): MemoryRecord {
  return {
    id: id as MemoryRecordId,
    memorySpaceId: spaceId,
    tableId,
    payload: { [nameId]: name, [ageId]: age, [activeId]: active },
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
  ];
  const records = [
    record("record-c", "顾川", 27, true),
    record("record-b", "周遥", 30, false),
    record("record-a", "林夏", 27, true),
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
