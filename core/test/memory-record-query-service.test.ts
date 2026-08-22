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
    await expect(
      query([{ fieldId: "$record_id", operator: "in", value: [] }]),
    ).rejects.toThrowError(rejected);
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

// ---------------------------------------------------------------------------
// 读时显示文本：模板策略表按当前定义与目标记录重渲（存储 displayText 降级为兜底）
// ---------------------------------------------------------------------------

const locTableId = "table-locations" as MemoryTableId;
const charTableId = "table-characters" as MemoryTableId;
const relTableId = "table-rels" as MemoryTableId;
const locNameId = "field-loc-name" as MemoryFieldId;
const charNameId = "field-char-name" as MemoryFieldId;
const charLocId = "field-char-loc" as MemoryFieldId;
const relAId = "field-rel-a" as MemoryFieldId;
const relBId = "field-rel-b" as MemoryFieldId;

function refFixtureTable(
  id: MemoryTableId,
  displayStrategy: MemoryTable["displayStrategy"],
): MemoryTable {
  return {
    id,
    memorySpaceId: spaceId,
    key: id,
    kind: "custom",
    name: id,
    description: "",
    prompt: "",
    enabled: true,
    displayStrategy,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function refFixtureField(
  id: MemoryFieldId,
  tableId: MemoryTableId,
  type: MemoryField["type"],
  referenceTableId: MemoryTableId | null = null,
): MemoryField {
  return {
    id,
    memorySpaceId: spaceId,
    tableId,
    key: id,
    name: id,
    type,
    required: false,
    prompt: "",
    enabled: true,
    position: 0,
    options: [],
    referenceTableId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function refFixtureRecord(
  id: string,
  tableId: MemoryTableId,
  payload: MemoryRecordPayload,
  displayText: string,
): MemoryRecord {
  return {
    id: id as MemoryRecordId,
    memorySpaceId: spaceId,
    tableId,
    payload,
    fieldEvidence: {},
    // displayText 一律传「过期快照」：写时计算后目标又变了的历史形态
    displayText,
    source: { type: "manual" },
    revisionId: `revision-${id}` as MemoryRevisionId,
    revisionSource: "user",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * 三表链式夹具：locations(field) ← characters(template `{name}＠{loc}`) ←
 * relationships(template `{a} <-> {b}`)。地点已从「旧都」改名「雾都」，
 * 而人物/关系的存储 displayText 还是按「旧都」渲染的过期值。
 */
function referenceQueryService(extra?: {
  readonly tables?: readonly MemoryTable[];
  readonly fields?: readonly MemoryField[];
  readonly records?: readonly MemoryRecord[];
}) {
  const tables = [
    refFixtureTable(locTableId, { type: "field", fieldId: locNameId }),
    refFixtureTable(charTableId, {
      type: "template",
      template: `{${charNameId}}＠{${charLocId}}`,
    }),
    refFixtureTable(relTableId, {
      type: "template",
      template: `{${relAId}} <-> {${relBId}}`,
    }),
  ];
  const mergedTables = [...(extra?.tables ?? []), ...tables];
  const fields = [
    refFixtureField(locNameId, locTableId, "short_text"),
    refFixtureField(charNameId, charTableId, "short_text"),
    refFixtureField(charLocId, charTableId, "single_reference", locTableId),
    refFixtureField(relAId, relTableId, "single_reference", charTableId),
    refFixtureField(relBId, relTableId, "single_reference", charTableId),
  ];
  const mergedFields = [...(extra?.fields ?? []), ...fields];
  const records = [
    refFixtureRecord("loc-1", locTableId, { [locNameId]: "雾都" }, "雾都"),
    refFixtureRecord(
      "char-1",
      charTableId,
      { [charNameId]: "顾川", [charLocId]: "loc-1" },
      "顾川＠旧都", // 过期：地点改名前渲染
    ),
    refFixtureRecord(
      "rel-1",
      relTableId,
      { [relAId]: "char-1", [relBId]: "char-missing" },
      "顾川＠旧都 <-> ", // 过期 + 目标后来被删
    ),
  ];
  const mergedRecords = [...(extra?.records ?? []), ...records];
  const tableRepository: MemoryTableRepository = {
    async create() {},
    async delete() {
      return false;
    },
    async find(_spaceId, tableId) {
      return mergedTables.find((candidate) => candidate.id === tableId);
    },
    async findByKey() {
      return undefined;
    },
    async list() {
      return tables;
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
    async list(_spaceId, tableId) {
      return mergedFields.filter((candidate) => candidate.tableId === tableId);
    },
    async update() {
      return false;
    },
  };
  const recordRepository: MemoryRecordRepository = {
    async create() {},
    async find(_spaceId, tableId, id) {
      return mergedRecords.find(
        (candidate) => candidate.tableId === tableId && candidate.id === id,
      );
    },
    async list(_spaceId, tableId) {
      return mergedRecords.filter((candidate) => candidate.tableId === tableId);
    },
    async commit() {
      return false;
    },
    async listHistory() {
      return [];
    },
  };
  return new MemoryRecordQueryService(tableRepository, fieldRepository, recordRepository);
}

describe("MemoryRecordQueryService 读时显示文本", () => {
  it("模板策略表：引用链按当前目标记录重渲（地点改名后关系与人物显示新名）", async () => {
    const result = await referenceQueryService().query(spaceId, {
      tableId: relTableId,
      paging: { page: 1, pageSize: 10 },
    });
    expect(result.records[0]!.displayText).toBe("顾川＠雾都 <-> ");
  });

  it("$display_text 条件对计算值求值：搜新地名命中、搜旧地名不命中", async () => {
    const service = referenceQueryService();
    const fresh = await service.query(spaceId, {
      tableId: relTableId,
      conditions: [{ fieldId: "$display_text", operator: "contains", value: "雾都" }],
      paging: { page: 1, pageSize: 10 },
    });
    expect(fresh.records.map((record) => record.id)).toEqual(["rel-1"]);
    const stale = await service.query(spaceId, {
      tableId: relTableId,
      conditions: [{ fieldId: "$display_text", operator: "contains", value: "旧都" }],
      paging: { page: 1, pageSize: 10 },
    });
    expect(stale.records).toEqual([]);
  });

  it("$display_text 排序按计算值而非存储快照", async () => {
    // rel-a → 阿二（计算序靠后），rel-b → 阿一（计算序靠前）；存储值互换
    const service = referenceQueryService({
      records: [
        refFixtureRecord(
          "char-2",
          charTableId,
          { [charNameId]: "阿二", [charLocId]: "loc-1" },
          "x",
        ),
        refFixtureRecord(
          "rel-a",
          relTableId,
          { [relAId]: "char-2", [relBId]: "char-missing" },
          "阿一＠旧都 <-> ",
        ),
        refFixtureRecord(
          "rel-b",
          relTableId,
          { [relAId]: "char-1", [relBId]: "char-missing" },
          "阿二＠旧都 <-> ",
        ),
      ],
    });
    const result = await service.query(spaceId, {
      tableId: relTableId,
      paging: { page: 1, pageSize: 10 },
      order: { fieldId: "$display_text", direction: "asc" },
    });
    expect(result.records.map((record) => record.id)).toEqual(["rel-a", "rel-1", "rel-b"]);
  });

  it("模板漂移（占位符字段已删）：顶层回退存储值，引用位置渲染空串", async () => {
    const brokenCharTable = refFixtureTable(charTableId, {
      type: "template",
      template: `{${charNameId}}＠{field-deleted}`,
    });
    const service = referenceQueryService({
      tables: [brokenCharTable],
    });
    // 顶层查询人物：渲染抛错 → 回退存储 displayText
    const chars = await service.query(spaceId, {
      tableId: charTableId,
      paging: { page: 1, pageSize: 10 },
    });
    expect(chars.records[0]!.displayText).toBe("顾川＠旧都");
    // 关系引用该人物：单个引用失败渲染空串，不毒化整体
    const rels = await service.query(spaceId, {
      tableId: relTableId,
      paging: { page: 1, pageSize: 10 },
    });
    expect(rels.records[0]!.displayText).toBe(" <-> ");
  });

  it("引用环：渲染终止且环内链路按未找到渲染空串", async () => {
    const aTableId = "table-a" as MemoryTableId;
    const bTableId = "table-b" as MemoryTableId;
    const aRefId = "field-a-ref" as MemoryFieldId;
    const bRefId = "field-b-ref" as MemoryFieldId;
    const service = referenceQueryService({
      tables: [
        refFixtureTable(aTableId, { type: "template", template: `{${aRefId}}` }),
        refFixtureTable(bTableId, { type: "template", template: `{${bRefId}}` }),
      ],
      fields: [
        refFixtureField(aRefId, aTableId, "single_reference", bTableId),
        refFixtureField(bRefId, bTableId, "single_reference", aTableId),
      ],
      records: [
        refFixtureRecord("a-1", aTableId, { [aRefId]: "b-1" }, "stored-a"),
        refFixtureRecord("b-1", bTableId, { [bRefId]: "a-1" }, "stored-b"),
      ],
    });
    const result = await service.query(spaceId, {
      tableId: aTableId,
      paging: { page: 1, pageSize: 10 },
    });
    expect(result.records[0]!.displayText).toBe(""); // 模板仅含环内引用，整条按未找到渲染为空
  });
});
