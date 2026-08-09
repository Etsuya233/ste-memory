import { describe, expect, it } from "vitest";
import {
  MemoryRecordService,
  type MemoryField,
  type MemoryFieldId,
  type MemoryRecord,
  type MemoryRecordHistoryId,
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

const spaceId = "space-1" as MemorySpaceId;
const tableId = "table-1" as MemoryTableId;
const refTableId = "table-2" as MemoryTableId;
const nameId = "field-name" as MemoryFieldId;
const roleId = "field-role" as MemoryFieldId;
const refId = "field-ref" as MemoryFieldId;
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
  displayStrategy: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const refTable: MemoryTable = {
  ...table,
  id: refTableId,
  key: "locations" as MemoryTableKey,
  name: "地点",
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
    referenceTableId: id === refId ? refTableId : null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function record(
  id: string,
  tableIdValue: MemoryTableId,
  payload: Record<string, unknown>,
  displayText: string,
): MemoryRecord {
  return {
    id: id as MemoryRecordId,
    memorySpaceId: spaceId,
    tableId: tableIdValue,
    payload,
    fieldEvidence: {},
    displayText,
    source: { type: "manual" },
    revisionId: `revision-${id}` as MemoryRevisionId,
    revisionSource: "user",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function service(): MemoryRecordService {
  const fields = [
    field(nameId, "short_text"),
    field(roleId, "short_text"),
    field(refId, "single_reference"),
  ];
  const records = [
    record("record-1", tableId, { [nameId]: "顾川", [roleId]: "旅人" }, "顾川"),
    record("target-1", refTableId, { [nameId]: "旧书店" }, "旧书店"),
  ];
  const tables: MemoryTableRepository = {
    async create() {},
    async delete() {
      return false;
    },
    async find(candidateSpaceId, candidateTableId) {
      if (candidateSpaceId !== spaceId) return undefined;
      return candidateTableId === tableId
        ? table
        : candidateTableId === refTableId
          ? refTable
          : undefined;
    },
    async findByKey() {
      return undefined;
    },
    async list() {
      return [table, refTable];
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
  return new MemoryRecordService(
    tables,
    fieldRepository,
    recordRepository,
    () => "record-new" as MemoryRecordId,
    () => "history-new" as MemoryRecordHistoryId,
    () => "revision-new" as MemoryRevisionId,
    () => timestamp,
  );
}

function expectInvalid(promise: Promise<string>, humanMsg: string): Promise<void> {
  return expect(promise).rejects.toThrowError(
    expect.objectContaining({
      type: "memory_table_display_strategy_invalid",
      humanMsg,
    }),
  );
}

describe("MemoryRecordService.previewDisplayText（显示文本预览，ticket 10）", () => {
  it("field 策略：取指定字段的值作为显示文本", async () => {
    await expect(
      service().previewDisplayText(
        spaceId,
        tableId,
        { type: "field", fieldId: nameId },
        {
          [nameId]: "顾川",
          [roleId]: "旅人",
        },
      ),
    ).resolves.toBe("顾川");
  });

  it("template 策略：渲染模板并替换占位符", async () => {
    await expect(
      service().previewDisplayText(
        spaceId,
        tableId,
        { type: "template", template: "{field-name}（{field-role}）" },
        { [nameId]: "顾川", [roleId]: "旅人" },
      ),
    ).resolves.toBe("顾川（旅人）");
  });

  it("template 策略：引用字段解析为目标记录显示文本", async () => {
    await expect(
      service().previewDisplayText(
        spaceId,
        tableId,
        { type: "template", template: "{field-ref}里住着{field-name}" },
        { [nameId]: "顾川", [refId]: "target-1" },
      ),
    ).resolves.toBe("旧书店里住着顾川");
  });

  it("field 策略引用不存在的字段：抛策略无效错误", async () => {
    await expectInvalid(
      service().previewDisplayText(
        spaceId,
        tableId,
        { type: "field", fieldId: "field-missing" as MemoryFieldId },
        { [nameId]: "顾川" },
      ),
      "显示字段必须是当前表中的短文本字段",
    );
  });

  it("template 策略引用不存在的字段：抛策略无效错误", async () => {
    await expectInvalid(
      service().previewDisplayText(
        spaceId,
        tableId,
        { type: "template", template: "{field-missing}" },
        { [nameId]: "顾川" },
      ),
      "显示模板只能引用当前表中的字段",
    );
  });

  it("template 策略没有占位符：抛策略无效错误", async () => {
    await expectInvalid(
      service().previewDisplayText(spaceId, tableId, { type: "template", template: "纯文本" }, {}),
      "显示模板只能引用当前表中的字段",
    );
  });

  it("表格不存在：返回空字符串", async () => {
    await expect(
      service().previewDisplayText(
        spaceId,
        "table-missing" as MemoryTableId,
        {
          type: "field",
          fieldId: nameId,
        },
        {},
      ),
    ).resolves.toBe("");
  });
});
