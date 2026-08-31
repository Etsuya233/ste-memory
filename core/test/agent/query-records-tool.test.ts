import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  QUERY_RECORDS_TOOL_NAME,
  QueryRecordsToolError,
  buildMemorySpaceTableDigest,
  createQueryRecordsTool,
} from "../../src/memory/application/agent/index.ts";
import {
  MemoryFieldService,
  MemoryRecordQueryService,
  MemoryTableService,
  type MemoryField,
  type MemoryRecord,
  type MemoryRevisionId,
  type MemoryTable,
  type MemoryTableId,
  type QueryRecordsInput,
} from "../../src/memory/index.ts";
import type { MemorySpaceReader } from "../../src/memory/application/agent/index.ts";
import type {
  MemoryFieldRepository,
  MemoryRecordRepository,
  MemorySpaceRepository,
  MemoryTableRepository,
} from "../../src/memory/adapter.ts";
import { createTestMemorySpace, type TestMemorySpace } from "./memory-space-fixture.ts";
import { SPACE_ID } from "./memory-space-data.ts";

async function toolWith(space: TestMemorySpace = createTestMemorySpace()) {
  const digest = await buildMemorySpaceTableDigest(space.reader, space.memorySpaceId);
  return createQueryRecordsTool({ reader: space.reader, digest });
}

function textOf(result: { content: { type: string; text?: string }[] }) {
  const text = result.content.find((block) => block.type === "text")?.text;
  expect(text).toBeDefined();
  return JSON.parse(text!) as Record<string, unknown>;
}

function captureQueries(space: TestMemorySpace) {
  const captured: QueryRecordsInput[] = [];
  const original = space.reader.queryRecords;
  space.reader.queryRecords = async (memorySpaceId, input) => {
    captured.push(input);
    return original(memorySpaceId, input);
  };
  return captured;
}

describe("query_records 参数 schema", () => {
  it("合法参数通过 pi 校验（形状错误由引擎在 execute 前拦截）", async () => {
    const tool = await toolWith();
    const args = {
      table: "characters",
      fields: ["name"],
      conditions: [{ field: "current_status", op: "contains", value: "受伤" }],
      paging: { page: 1, pageSize: 20 },
      orderBy: { field: "$updated_at", direction: "desc" },
    };
    const toolCall = { id: "call-1", name: QUERY_RECORDS_TOOL_NAME, arguments: args };
    expect(() => validateToolArguments(tool, toolCall)).not.toThrow();
  });

  it("未知 op 与非法分页被 pi 校验拦截", async () => {
    const tool = await toolWith();
    const call = (args: Record<string, unknown>) => ({
      id: "call-1",
      name: QUERY_RECORDS_TOOL_NAME,
      arguments: args,
    });

    expect(() =>
      validateToolArguments(
        tool,
        call({ table: "characters", conditions: [{ field: "name", op: "bogus", value: "x" }] }),
      ),
    ).toThrow(/must be equal to one of the allowed values/);
    expect(() =>
      validateToolArguments(
        tool,
        call({ table: "characters", paging: { page: 1, pageSize: "x" } }),
      ),
    ).toThrow(/must be integer/);
    expect(() =>
      validateToolArguments(
        tool,
        call({
          table: "characters",
          conditions: [{ field: "name", op: "equals", value: { x: 1 } }],
        }),
      ),
    ).toThrow(/Validation failed/);
  });

  it("in/not_in 接受数组 value（多值查询）通过 pi 校验", async () => {
    const tool = await toolWith();
    const args = {
      table: "characters",
      conditions: [
        { field: "current_status", op: "in", value: ["正常", "受伤"] },
        { field: "name", op: "not_in", value: ["周遥"] },
      ],
    };
    const toolCall = { id: "call-1", name: QUERY_RECORDS_TOOL_NAME, arguments: args };
    expect(() => validateToolArguments(tool, toolCall)).not.toThrow();
  });

  it("数组元素也限标量：嵌套对象 value 被 pi 校验拦截", async () => {
    const tool = await toolWith();
    const call = (args: Record<string, unknown>) => ({
      id: "call-1",
      name: QUERY_RECORDS_TOOL_NAME,
      arguments: args,
    });
    expect(() =>
      validateToolArguments(
        tool,
        call({ table: "characters", conditions: [{ field: "name", op: "in", value: [{ x: 1 }] }] }),
      ),
    ).toThrow(/Validation failed/);
  });
});

describe("query_records 执行器：key 校验与错误回喂", () => {
  it("未知表 key 报错并附带可用表 key 列表", async () => {
    const tool = await toolWith();
    await expect(tool.execute("call-1", { table: "characterss" })).rejects.toThrow(
      new QueryRecordsToolError(
        `表 key「characterss」不存在或未启用。可用表 key：characters、locations。`,
      ),
    );
  });

  it("未知/未启用字段 key 报错并附带可用字段 key 列表", async () => {
    const tool = await toolWith();
    await expect(tool.execute("call-1", { table: "characters", fields: ["nmae"] })).rejects.toThrow(
      /字段 key「nmae」在表「characters」中不存在或未启用（投影字段）/,
    );
    await expect(
      tool.execute("call-1", { table: "characters", fields: ["secret_notes"] }),
    ).rejects.toThrow(/字段 key「secret_notes」在表「characters」中不存在或未启用/);
    await expect(
      tool.execute("call-1", {
        table: "characters",
        conditions: [{ field: "nmae", op: "equals", value: "x" }],
      }),
    ).rejects.toThrow(/（条件字段）.*可用字段 key：name、current_status、location、aliases/);
  });

  it("系统字段不能用于投影，只可用于条件/排序", async () => {
    const tool = await toolWith();
    await expect(
      tool.execute("call-1", { table: "characters", fields: ["$record_id"] }),
    ).rejects.toThrow(/系统字段「\$record_id」不能用于投影 fields/);
  });

  it("服务层 op×类型不匹配转可读信息回喂（含字段 key）", async () => {
    const tool = await toolWith();
    await expect(
      tool.execute("call-1", {
        table: "characters",
        conditions: [{ field: "current_status", op: "contains", value: "受伤" }],
      }),
    ).rejects.toThrow(/查询被拒绝：操作符或值与字段类型不匹配，字段：current_status/);
  });

  it("分页默认 page 1 / pageSize 20，透传自定义分页", async () => {
    const space = createTestMemorySpace();
    const captured = captureQueries(space);
    const tool = await toolWith(space);

    await tool.execute("call-1", { table: "characters" });
    expect(captured[0]?.paging).toEqual({ page: 1, pageSize: 20 });

    await tool.execute("call-1", { table: "characters", paging: { page: 2, pageSize: 1 } });
    expect(captured[1]?.paging).toEqual({ page: 2, pageSize: 1 });
  });

  it("超过服务层 pageSize 上限（100）的查询被拒绝并回喂可读错误", async () => {
    const tool = await toolWith();
    await expect(
      tool.execute("call-1", { table: "characters", paging: { page: 1, pageSize: 101 } }),
    ).rejects.toThrow(/查询被拒绝：分页无效（page 从 1 起，pageSize 为 1–100）/);
  });
});

describe("query_records 执行器：读时显示文本（模板策略按当前目标记录解析）", () => {
  it("存储 displayText 过期的模板策略表：引用字段按目标记录显示文本重新渲染", async () => {
    // 模拟修复前的历史数据：关系记录存储 displayText 为「 <-> 」（批内引用曾解析为空）
    const space = relationshipsSpace();
    const digest = await buildMemorySpaceTableDigest(space.reader, space.memorySpaceId);
    const tool = createQueryRecordsTool({ reader: space.reader, digest });

    const result = textOf(
      await tool.execute("call-1", {
        table: "relationships",
        fields: ["character_a", "character_b"],
      }),
    );
    const records = result.records as {
      id: string;
      display: string;
      values: Record<string, unknown>;
    }[];
    expect(records).toHaveLength(1);
    expect(records[0]!.display).toBe("秋元悦也 <-> 平野健介");
    // values 仍是裸 id（引用字段 v1 语义不变）
    expect(records[0]!.values.character_a).toBe("char-1");
    expect(records[0]!.values.character_b).toBe("char-2");
  });

  it("field 策略表直接使用存储 displayText，不做额外查询", async () => {
    const space = relationshipsSpace();
    const captured: QueryRecordsInput[] = [];
    const original = space.reader.queryRecords;
    space.reader.queryRecords = async (memorySpaceId, input) => {
      captured.push(input);
      return original(memorySpaceId, input);
    };
    const digest = await buildMemorySpaceTableDigest(space.reader, space.memorySpaceId);
    const tool = createQueryRecordsTool({ reader: space.reader, digest });

    await tool.execute("call-1", { table: "characters" });
    // 只有主查询本身，没有读时解析的额外目标表查询
    expect(captured).toHaveLength(1);
    expect(captured[0]!.tableId).toBe("table-characters");
  });

  it("目标记录不存在：读时解析渲染为空（与提交路径同语义）", async () => {
    const space = relationshipsSpace();
    // 关系记录引用一个不存在的角色 id（char-1 → char-missing）
    const relationship = space.recordsByTableId.get("table-relationships")![0]!;
    (relationship.payload as Record<string, string>)["field-char-a"] = "char-missing";
    const digest = await buildMemorySpaceTableDigest(space.reader, space.memorySpaceId);
    const tool = createQueryRecordsTool({ reader: space.reader, digest });

    const result = textOf(await tool.execute("call-1", { table: "relationships" }));
    const records = result.records as { display: string }[];
    expect(records[0]!.display).toBe(" <-> 平野健介");
  });
});

/**
 * 人物 + 关系的双表空间：characters 用 field 策略（name），
 * relationships 用模板策略 `{character_a} <-> {character_b}`（引用 characters）。
 */
function relationshipsSpace(): TestMemorySpace {
  const timestamp = "2026-07-30T00:00:00.000Z";
  const charactersTableId = "table-characters" as MemoryTableId;
  const relationshipsTableId = "table-relationships" as MemoryTableId;
  const nameId = "field-name" as MemoryField["id"];
  const charAId = "field-char-a" as MemoryField["id"];
  const charBId = "field-char-b" as MemoryField["id"];

  const charactersTable: MemoryTable = {
    id: charactersTableId,
    memorySpaceId: SPACE_ID,
    key: "characters",
    kind: "custom",
    name: "人物",
    description: "",
    prompt: "",
    enabled: true,
    displayStrategy: { type: "field", fieldId: nameId },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const relationshipsTable: MemoryTable = {
    id: relationshipsTableId,
    memorySpaceId: SPACE_ID,
    key: "relationships",
    kind: "custom",
    name: "人际关系",
    description: "",
    prompt: "",
    enabled: true,
    displayStrategy: {
      type: "template",
      template: `{${charAId}} <-> {${charBId}}`,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const nameField: MemoryField = {
    id: nameId,
    memorySpaceId: SPACE_ID,
    tableId: charactersTableId,
    key: "name",
    name: "名称",
    type: "short_text",
    required: true,
    prompt: "",
    enabled: true,
    position: 0,
    options: [],
    referenceTableId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const charAField: MemoryField = {
    ...nameField,
    id: charAId,
    tableId: relationshipsTableId,
    key: "character_a",
    name: "人物 A",
    type: "single_reference",
    required: true,
    position: 0,
    referenceTableId: charactersTableId,
  };
  const charBField: MemoryField = {
    ...charAField,
    id: charBId,
    key: "character_b",
    name: "人物 B",
    position: 1,
  };
  const tables = [charactersTable, relationshipsTable];
  const fieldsByTableId = new Map<MemoryTableId, readonly MemoryField[]>([
    [charactersTableId, [nameField]],
    [relationshipsTableId, [charAField, charBField]],
  ]);
  const charA: MemoryRecord = {
    id: "char-1" as MemoryRecord["id"],
    memorySpaceId: SPACE_ID,
    tableId: charactersTableId,
    payload: { [nameId]: "秋元悦也" },
    fieldEvidence: {},
    displayText: "秋元悦也",
    source: { type: "manual" },
    revisionId: "revision-char-1" as MemoryRevisionId,
    revisionSource: "user",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const charB: MemoryRecord = {
    ...charA,
    id: "char-2" as MemoryRecord["id"],
    payload: { [nameId]: "平野健介" },
    displayText: "平野健介",
    revisionId: "revision-char-2" as MemoryRevisionId,
  };
  // 存储 displayText 是修复前的过期值（引用解析为空）——读时解析应纠正展示
  const relationship: MemoryRecord = {
    id: "rel-1" as MemoryRecord["id"],
    memorySpaceId: SPACE_ID,
    tableId: relationshipsTableId,
    payload: { [charAId]: "char-1", [charBId]: "char-2" },
    fieldEvidence: {},
    displayText: " <-> ",
    source: { type: "manual" },
    revisionId: "revision-rel-1" as MemoryRevisionId,
    revisionSource: "user",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const recordsByTableId = new Map<MemoryTableId, readonly MemoryRecord[]>([
    [charactersTableId, [charA, charB]],
    [relationshipsTableId, [relationship]],
  ]);

  const tablesRepo: MemoryTableRepository = {
    async create() {},
    async delete() {
      return false;
    },
    async find(memorySpaceId, id) {
      return memorySpaceId === SPACE_ID
        ? tables.find((candidate) => candidate.id === id)
        : undefined;
    },
    async findByKey() {
      return undefined;
    },
    async list(memorySpaceId) {
      return memorySpaceId === SPACE_ID ? [...tables] : [];
    },
    async update() {
      return false;
    },
  };
  const fieldsRepo: MemoryFieldRepository = {
    async create() {},
    async delete() {
      return false;
    },
    async find(memorySpaceId, tableId, id) {
      return memorySpaceId === SPACE_ID
        ? fieldsByTableId.get(tableId)?.find((candidate) => candidate.id === id)
        : undefined;
    },
    async findByKey() {
      return undefined;
    },
    async list(memorySpaceId, tableId) {
      return memorySpaceId === SPACE_ID ? [...(fieldsByTableId.get(tableId) ?? [])] : [];
    },
    async update() {
      return false;
    },
  };
  const recordsRepo: MemoryRecordRepository = {
    async create() {},
    async find(memorySpaceId, tableId, id) {
      return memorySpaceId === SPACE_ID
        ? recordsByTableId.get(tableId)?.find((candidate) => candidate.id === id)
        : undefined;
    },
    async list(memorySpaceId, tableId) {
      return memorySpaceId === SPACE_ID ? [...(recordsByTableId.get(tableId) ?? [])] : [];
    },
    async commit() {
      return false;
    },
    async listHistory() {
      return [];
    },
  };
  const spacesRepo: MemorySpaceRepository = {
    async create() {},
    async delete() {
      return false;
    },
    async find() {
      return undefined;
    },
    async list() {
      return [];
    },
    async rename() {
      return undefined;
    },
    async clearRecords() {
      return false;
    },
    async deleteAllTables() {
      return false;
    },
  };
  const createId = (() => `id-${Math.random().toString(36).slice(2)}`) as () => MemoryTableId;
  const tableService = new MemoryTableService(spacesRepo, tablesRepo, createId, () => timestamp);
  const fieldService = new MemoryFieldService(tablesRepo, fieldsRepo, createId, () => timestamp);
  const queryService = new MemoryRecordQueryService(tablesRepo, fieldsRepo, recordsRepo);
  const reader: MemorySpaceReader = {
    listTables: (memorySpaceId) => tableService.list(memorySpaceId),
    listFields: (memorySpaceId, tableId) => fieldService.list(memorySpaceId, tableId),
    queryRecords: (memorySpaceId, input) => queryService.query(memorySpaceId, input),
  };
  return {
    memorySpaceId: SPACE_ID,
    reader,
    ports: { tables: tablesRepo, fields: fieldsRepo, records: recordsRepo },
    tables,
    fieldsByTableId,
    recordsByTableId,
  };
}
describe("query_records 执行器：结果形状", () => {
  it("返回 { id, revisionId, display, values }，values 用字段 key 键控，剥掉证据/来源噪音", async () => {
    const tool = await toolWith();
    const result = textOf(
      await tool.execute("call-1", {
        table: "characters",
        conditions: [{ field: "current_status", op: "equals", value: "受伤" }],
      }),
    );

    expect(result).toMatchObject({
      table: "characters",
      page: 1,
      pageSize: 20,
      total: 2,
      totalPages: 1,
    });
    const records = result.records as Record<string, unknown>[];
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      id: "record-1",
      revisionId: "revision-record-1",
      display: "云烬",
      values: {
        name: "云烬",
        current_status: "受伤",
        location: "loc-1",
        aliases: ["云烬", "烬"],
      },
    });
    expect(records[0]).not.toHaveProperty("fieldEvidence");
    expect(records[0]).not.toHaveProperty("source");
    expect(records[0]).not.toHaveProperty("tableId");
    expect(records[0]).not.toHaveProperty("memorySpaceId");
  });

  it("不指定 fields 返回全部启用字段；指定 fields 只做投影", async () => {
    const tool = await toolWith();
    const projected = textOf(
      await tool.execute("call-1", { table: "characters", fields: ["name"] }),
    );
    const records = projected.records as Record<string, unknown>[];
    expect(Object.keys(records[0]!.values as Record<string, unknown>)).toEqual(["name"]);

    const all = textOf(await tool.execute("call-1", { table: "characters" }));
    const allRecords = all.records as Record<string, unknown>[];
    expect(Object.keys(allRecords[0]!.values as Record<string, unknown>).sort()).toEqual([
      "aliases",
      "current_status",
      "location",
      "name",
    ]);
  });

  it("系统字段条件（$display_text）与排序走通", async () => {
    const tool = await toolWith();
    const result = textOf(
      await tool.execute("call-1", {
        table: "characters",
        conditions: [{ field: "$display_text", op: "contains", value: "云" }],
        orderBy: { field: "$updated_at", direction: "desc" },
      }),
    );
    const records = result.records as { display: string }[];
    expect(records.map((record) => record.display)).toEqual(["云烬"]);
  });

  it("空结果返回空 records 数组（模型据此判断「该新建」）", async () => {
    const tool = await toolWith();
    const result = textOf(
      await tool.execute("call-1", {
        table: "characters",
        conditions: [{ field: "current_status", op: "equals", value: "死亡" }],
      }),
    );
    expect(result).toMatchObject({ total: 0, totalPages: 0, records: [] });
  });

  it("空结果附带通用 tips（非空结果不出现 tips 字段）", async () => {
    const tool = await toolWith();
    const empty = textOf(
      await tool.execute("call-1", {
        table: "characters",
        conditions: [{ field: "current_status", op: "equals", value: "死亡" }],
      }),
    );
    expect(empty.total).toBe(0);
    expect(typeof empty.tips).toBe("string");
    expect(empty.tips).toContain("未找到满足条件的记录");
    expect(empty.tips).not.toContain("引用字段");

    const hit = textOf(
      await tool.execute("call-1", {
        table: "characters",
        conditions: [{ field: "current_status", op: "equals", value: "受伤" }],
      }),
    );
    expect(hit.records).toHaveLength(2);
    expect(hit).not.toHaveProperty("tips");
  });

  it("条件含引用字段时空结果 tips 提示以目标记录 id 作条件值（而非显示文本）", async () => {
    const tool = await toolWith();
    const result = textOf(
      await tool.execute("call-1", {
        table: "characters",
        conditions: [{ field: "location", op: "equals", value: "不存在的地点" }],
      }),
    );
    expect(result.total).toBe(0);
    expect(result.tips).toContain("location");
    expect(result.tips).toContain("目标表记录的 id");
  });

  it("in/not_in 执行：single_select 成员匹配与 $record_id 多值", async () => {
    const tool = await toolWith();
    const ids = (result: Record<string, unknown>) =>
      (result.records as { id: string }[]).map((record) => record.id);

    const inStatus = textOf(
      await tool.execute("call-1", {
        table: "characters",
        conditions: [{ field: "current_status", op: "in", value: ["正常", "死亡"] }],
      }),
    );
    expect(ids(inStatus)).toEqual(["record-2"]);

    const notInStatus = textOf(
      await tool.execute("call-1", {
        table: "characters",
        conditions: [{ field: "current_status", op: "not_in", value: ["受伤"] }],
      }),
    );
    expect(ids(notInStatus)).toEqual(["record-2"]);

    const byId = textOf(
      await tool.execute("call-1", {
        table: "characters",
        conditions: [{ field: "$record_id", op: "in", value: ["record-1", "record-3"] }],
      }),
    );
    expect(ids(byId)).toEqual(["record-1", "record-3"]);
  });

  it("in 配标量 value 通过 schema 但被服务层拒绝并回喂可读错误", async () => {
    const tool = await toolWith();
    await expect(
      tool.execute("call-1", {
        table: "characters",
        conditions: [{ field: "current_status", op: "in", value: "正常" }],
      }),
    ).rejects.toThrow(/查询被拒绝：操作符或值与字段类型不匹配，字段：current_status/);
  });

  it("工具描述说明 in/not_in 多值语义与列表字段指引", async () => {
    const tool = await toolWith();
    expect(tool.description).toContain("in / not_in");
    expect(tool.description).toContain("无需拆多次 equals");
    expect(tool.description).toContain("列表字段");
  });
});
