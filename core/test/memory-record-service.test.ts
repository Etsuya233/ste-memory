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
} from "../src/memory/index.ts";
import type {
  MemoryFieldRepository,
  MemoryRecordMutation,
  MemoryRecordRepository,
  MemoryTableRepository,
} from "../src/memory/adapter.ts";
import { describe, expect, it } from "vitest";

const spaceId = "space-1" as MemorySpaceId;
const characterTableId = "characters" as MemoryTableId;
const locationTableId = "locations" as MemoryTableId;
const nameId = "name" as MemoryFieldId;
const ageId = "age" as MemoryFieldId;
const activeId = "active" as MemoryFieldId;
const birthdayId = "birthday" as MemoryFieldId;
const roleId = "role" as MemoryFieldId;
const locationId = "location" as MemoryFieldId;

function table(id: MemoryTableId, displayFieldId: MemoryFieldId): MemoryTable {
  return {
    id,
    memorySpaceId: spaceId,
    key: id,
    kind: "custom",
    name: id,
    description: "",
    prompt: "",
    enabled: true,
    displayStrategy: { type: "field", fieldId: displayFieldId },
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

function field(
  id: MemoryFieldId,
  tableId: MemoryTableId,
  type: MemoryField["type"],
  required = false,
  options: readonly string[] = [],
  referenceTableId: MemoryTableId | null = null,
): MemoryField {
  return {
    id,
    memorySpaceId: spaceId,
    tableId,
    name: id,
    type,
    required,
    prompt: "",
    enabled: true,
    position: 0,
    options,
    referenceTableId,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

class Records implements MemoryRecordRepository {
  readonly values: MemoryRecord[] = [];
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
  async commit(mutations: readonly MemoryRecordMutation[]): Promise<boolean> {
    for (const mutation of mutations) {
      if (mutation.kind === "create") {
        this.values.push(mutation.current);
      } else if (mutation.current) {
        const index = this.values.findIndex((record) => record.id === mutation.previous.id);
        if (index >= 0) this.values[index] = mutation.current;
      } else {
        const index = this.values.findIndex((record) => record.id === mutation.previous.id);
        if (index >= 0) this.values.splice(index, 1);
      }
    }
    return true;
  }
  async listHistory() {
    return [];
  }
}

function createService() {
  const tables = [table(characterTableId, nameId), table(locationTableId, nameId)];
  const fields = [
    field(nameId, characterTableId, "short_text", true),
    field(ageId, characterTableId, "integer"),
    field(activeId, characterTableId, "boolean"),
    field(birthdayId, characterTableId, "date"),
    field(roleId, characterTableId, "single_select", false, ["主角", "配角"]),
    field(locationId, characterTableId, "single_reference", false, [], locationTableId),
    field(nameId, locationTableId, "short_text", true),
  ];
  const records = new Records();
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
    fields,
    records,
    service: new MemoryRecordService(
      tableRepository,
      fieldRepository,
      records,
      () => `record-${records.values.length + 1}` as MemoryRecordId,
      () => "history-1" as MemoryRecordHistoryId,
      () => `revision-${records.values.length + 1}` as MemoryRevisionId,
      () => "2026-07-28T01:02:03.000Z",
    ),
  };
}

describe("MemoryRecordService", () => {
  it("creates a typed current record with stable identity, display text, and source details", async () => {
    const { service } = createService();
    const location = await service.create(spaceId, locationTableId, {
      payload: { [nameId]: "港口" },
    });

    const created = await service.create(spaceId, characterTableId, {
      payload: {
        [nameId]: "林夏",
        [ageId]: 27,
        [activeId]: true,
        [birthdayId]: "1999-04-12",
        [roleId]: "主角",
        [locationId]: location?.id,
      },
      source: {
        type: "source",
        sourceTime: "2026-07-27T11:30:00.000Z",
        sourceLocation: "消息 42",
      },
      revisionId: "revision-2",
      revisionSource: "user",
    });

    expect(created).toMatchObject({
      id: "record-2",
      memorySpaceId: spaceId,
      tableId: characterTableId,
      displayText: "林夏",
      payload: {
        name: "林夏",
        age: 27,
        active: true,
        birthday: "1999-04-12",
        role: "主角",
        location: "record-1",
      },
      source: {
        type: "source",
        sourceTime: "2026-07-27T11:30:00.000Z",
        sourceLocation: "消息 42",
      },
      createdAt: "2026-07-28T01:02:03.000Z",
      updatedAt: "2026-07-28T01:02:03.000Z",
    });
  });

  it.each([
    [{ [nameId]: "林夏", [ageId]: 27.5 }, "age"],
    [{ [nameId]: "林夏", [activeId]: "true" }, "active"],
    [{ [nameId]: "林夏", [birthdayId]: "2026-02-30" }, "birthday"],
    [{ [nameId]: "林夏", [roleId]: "反派" }, "role"],
    [{ [nameId]: "林夏", [locationId]: "missing" }, "location"],
  ])("rejects invalid typed field values and references", async (payload, fieldId) => {
    const { service } = createService();

    await expect(service.create(spaceId, characterTableId, { payload })).rejects.toThrowError(
      expect.objectContaining({ param: { fieldId } }),
    );
  });

  it("requires configured fields and marks source-free creation as manual", async () => {
    const { service } = createService();

    await expect(service.create(spaceId, characterTableId, { payload: {} })).rejects.toThrowError(
      expect.objectContaining({
        type: "memory_record_required_field_missing",
        param: { fieldId: nameId },
      }),
    );
    expect(
      await service.create(spaceId, characterTableId, { payload: { [nameId]: "林夏" } }),
    ).toMatchObject({ source: { type: "manual" } });
  });

  it("searches display text and field values with stable pagination", async () => {
    const { service } = createService();
    await service.create(spaceId, characterTableId, {
      payload: { [nameId]: "林夏", [roleId]: "主角" },
    });
    await service.create(spaceId, characterTableId, {
      payload: { [nameId]: "周遥", [roleId]: "配角" },
    });
    await service.create(spaceId, characterTableId, {
      payload: { [nameId]: "顾川", [roleId]: "主角" },
    });

    expect(
      await service.list(spaceId, characterTableId, { page: 2, pageSize: 1, search: "主角" }),
    ).toMatchObject({
      page: 2,
      pageSize: 1,
      total: 2,
      totalPages: 2,
      records: [{ id: "record-3", displayText: "顾川" }],
    });
  });

  it("validates persisted payload values when records are read", async () => {
    const { records, service } = createService();
    records.values.push({
      id: "record-1" as MemoryRecordId,
      memorySpaceId: spaceId,
      tableId: characterTableId,
      payload: { [nameId]: "林夏", [ageId]: 27.5 },
      fieldEvidence: {},
      displayText: "林夏",
      source: { type: "manual" },
      revisionId: "revision-1" as MemoryRevisionId,
      revisionSource: "user",
      createdAt: "2026-07-28T01:02:03.000Z",
      updatedAt: "2026-07-28T01:02:03.000Z",
    });

    await expect(
      service.find(spaceId, characterTableId, "record-1" as MemoryRecordId),
    ).rejects.toThrowError(
      expect.objectContaining({
        type: "memory_record_field_value_invalid",
        param: { fieldId: ageId },
      }),
    );
  });

  it("rejects empty required collections and invalid calendar datetimes", async () => {
    const setup = createService();
    const roleIndex = setup.fields.findIndex((item) => item.id === roleId);
    setup.fields[roleIndex] = {
      ...setup.fields[roleIndex]!,
      type: "multi_select",
      required: true,
    };
    await expect(
      setup.service.create(spaceId, characterTableId, {
        payload: { [nameId]: "林夏", [roleId]: [] },
      }),
    ).rejects.toThrowError(expect.objectContaining({ type: "memory_record_field_value_invalid" }));

    setup.fields[roleIndex] = { ...setup.fields[roleIndex]!, required: false };
    const birthdayIndex = setup.fields.findIndex((item) => item.id === birthdayId);
    setup.fields[birthdayIndex] = { ...setup.fields[birthdayIndex]!, type: "datetime" };
    await expect(
      setup.service.create(spaceId, characterTableId, {
        payload: { [nameId]: "林夏", [birthdayId]: "2026-02-30 10:00:00" },
      }),
    ).rejects.toThrowError(expect.objectContaining({ type: "memory_record_field_value_invalid" }));
    await expect(
      setup.service.create(spaceId, characterTableId, {
        payload: { [nameId]: "林夏", [birthdayId]: "2026-02-28T10:00:00" },
      }),
    ).rejects.toThrowError(expect.objectContaining({ type: "memory_record_field_value_invalid" }));
  });
});

describe("字段定义漂移后的读路径与更新路径（ticket 11 修复）", () => {
  it("删除字段后：记录仍可读，孤儿键从读路径投影中剔除", async () => {
    const setup = createService();
    await setup.service.create(spaceId, characterTableId, {
      payload: { [nameId]: "林夏", [ageId]: 28 },
    });
    // 模拟 ticket 09 删字段：字段定义移除，记录 payload 仍带孤儿键
    // （原地变更：repository 闭包捕获数组引用，替换数组不生效）
    const ageIndex = setup.fields.findIndex((item) => item.id === ageId);
    setup.fields.splice(ageIndex, 1);

    const found = await setup.service.find(spaceId, characterTableId, "record-1" as MemoryRecordId);
    expect(found?.payload).toEqual({ [nameId]: "林夏" });
    const page = await setup.service.list(spaceId, characterTableId, {
      page: 1,
      pageSize: 10,
    });
    expect(page?.records[0]?.payload).toEqual({ [nameId]: "林夏" });
  });

  it("新增必填字段后：旧记录仍可读（不抛必填缺失）", async () => {
    const setup = createService();
    await setup.service.create(spaceId, characterTableId, {
      payload: { [nameId]: "林夏" },
    });
    const roleIndex = setup.fields.findIndex((item) => item.id === roleId);
    setup.fields[roleIndex] = { ...setup.fields[roleIndex]!, required: true };

    await expect(
      setup.service.find(spaceId, characterTableId, "record-1" as MemoryRecordId),
    ).resolves.toMatchObject({ id: "record-1" });
  });

  it("选项变更后：旧值仍可读；编辑其他字段不受影响且旧值被携带", async () => {
    const setup = createService();
    await setup.service.create(spaceId, characterTableId, {
      payload: { [nameId]: "林夏", [roleId]: "主角" },
    });
    const roleIndex = setup.fields.findIndex((item) => item.id === roleId);
    setup.fields[roleIndex] = { ...setup.fields[roleIndex]!, options: ["A", "B"] };

    const found = await setup.service.find(spaceId, characterTableId, "record-1" as MemoryRecordId);
    expect(found?.payload).toEqual({ [nameId]: "林夏", [roleId]: "主角" });

    await setup.service.update(spaceId, characterTableId, "record-1" as MemoryRecordId, {
      expectedRevisionId: found!.revisionId,
      revisionSource: "user",
      patch: { [nameId]: "周遥" },
    });
    const updated = await setup.service.find(
      spaceId,
      characterTableId,
      "record-1" as MemoryRecordId,
    );
    expect(updated?.payload).toEqual({ [nameId]: "周遥", [roleId]: "主角" });
  });

  it("引用目标表删除后：悬空引用记录仍可读，无关字段编辑不被阻断", async () => {
    const setup = createService();
    await setup.service.create(spaceId, locationTableId, { payload: { [nameId]: "京都" } });
    await setup.service.create(spaceId, characterTableId, {
      payload: { [nameId]: "林夏", [locationId]: "record-1" },
    });
    // 模拟删除目标表：表定义移除（级联删记录），引用字段定义仍在
    // （原地变更：repository 闭包捕获数组引用，替换数组不生效）
    for (let index = setup.fields.length - 1; index >= 0; index--) {
      if (setup.fields[index]!.tableId === locationTableId) setup.fields.splice(index, 1);
    }
    for (let index = setup.records.values.length - 1; index >= 0; index--) {
      if (setup.records.values[index]!.tableId === locationTableId) {
        setup.records.values.splice(index, 1);
      }
    }

    const found = await setup.service.find(spaceId, characterTableId, "record-2" as MemoryRecordId);
    expect(found?.payload).toEqual({ [nameId]: "林夏", [locationId]: "record-1" });

    await setup.service.update(spaceId, characterTableId, "record-2" as MemoryRecordId, {
      expectedRevisionId: found!.revisionId,
      revisionSource: "user",
      patch: { [nameId]: "周遥" },
    });
    const updated = await setup.service.find(
      spaceId,
      characterTableId,
      "record-2" as MemoryRecordId,
    );
    expect(updated?.payload).toEqual({ [nameId]: "周遥", [locationId]: "record-1" });
  });

  it("更新路径严格性保留：未知键仍拒绝、清空必填字段仍拒绝", async () => {
    const setup = createService();
    const created = await setup.service.create(spaceId, characterTableId, {
      payload: { [nameId]: "林夏" },
    });

    await expect(
      setup.service.update(spaceId, characterTableId, created!.id, {
        expectedRevisionId: created!.revisionId,
        revisionSource: "user",
        patch: { ghost: "x" },
      }),
    ).rejects.toThrowError(expect.objectContaining({ type: "memory_record_unknown_field" }));

    await expect(
      setup.service.update(spaceId, characterTableId, created!.id, {
        expectedRevisionId: created!.revisionId,
        revisionSource: "user",
        patch: { [nameId]: "" },
      }),
    ).rejects.toThrowError(expect.objectContaining({ type: "memory_record_field_value_invalid" }));
  });
});

// ---------------------------------------------------------------------------
// 读时显示文本：list 搜索与返回值都用按当前目标记录重渲的显示文本
// ---------------------------------------------------------------------------

describe("MemoryRecordService list 读时显示文本", () => {
  it("搜索命中计算后的显示文本（目标改名即可搜到），返回值也是新文本", async () => {
    const timestamp = "2026-08-01T00:00:00.000Z";
    const locTable = "locs" as MemoryTableId;
    const relTable = "rels" as MemoryTableId;
    const locName = "loc-name" as MemoryFieldId;
    const relFrom = "rel-from" as MemoryFieldId;
    const tables: MemoryTable[] = [
      {
        id: locTable,
        memorySpaceId: spaceId,
        key: locTable,
        kind: "custom",
        name: locTable,
        description: "",
        prompt: "",
        enabled: true,
        displayStrategy: { type: "field", fieldId: locName },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: relTable,
        memorySpaceId: spaceId,
        key: relTable,
        kind: "custom",
        name: relTable,
        description: "",
        prompt: "",
        enabled: true,
        displayStrategy: { type: "template", template: `{${relFrom}}` },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ];
    const fields: MemoryField[] = [
      field(locName, locTable, "short_text", true),
      field(relFrom, relTable, "single_reference", false, [], locTable),
    ];
    const stored: MemoryRecord[] = [
      {
        id: "loc-1" as MemoryRecordId,
        memorySpaceId: spaceId,
        tableId: locTable,
        payload: { [locName]: "雾都" },
        fieldEvidence: {},
        displayText: "雾都",
        source: { type: "manual" },
        revisionId: "rev-1" as MemoryRevisionId,
        revisionSource: "user",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "rel-1" as MemoryRecordId,
        memorySpaceId: spaceId,
        tableId: relTable,
        payload: { [relFrom]: "loc-1" },
        fieldEvidence: {},
        // 过期快照：地点还叫旧名时渲染的
        displayText: "旧都",
        source: { type: "manual" },
        revisionId: "rev-2" as MemoryRevisionId,
        revisionSource: "user",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ];
    const tableRepository: MemoryTableRepository = {
      async create() {},
      delete: async () => false,
      find: async (_spaceId, id) => tables.find((item) => item.id === id),
      findByKey: async () => undefined,
      list: async () => tables,
      update: async () => false,
    };
    const fieldRepository: MemoryFieldRepository = {
      async create() {},
      delete: async () => false,
      find: async (_spaceId, tableId, id) =>
        fields.find((item) => item.tableId === tableId && item.id === id),
      findByKey: async () => undefined,
      list: async (_spaceId, tableId) => fields.filter((item) => item.tableId === tableId),
      update: async () => false,
    };
    const recordRepository: MemoryRecordRepository = {
      async create() {},
      find: async (_spaceId, tableId, id) =>
        stored.find((item) => item.tableId === tableId && item.id === id),
      list: async (_spaceId, tableId) => stored.filter((item) => item.tableId === tableId),
      commit: async () => false,
      listHistory: async () => [],
    };
    const service = new MemoryRecordService(
      tableRepository,
      fieldRepository,
      recordRepository,
      () => "record-new" as MemoryRecordId,
      () => "history-new" as MemoryRecordHistoryId,
      () => "revision-new" as MemoryRevisionId,
      () => timestamp,
    );

    const byNewName = await service.list(spaceId, relTable, {
      page: 1,
      pageSize: 10,
      search: "雾都",
    });
    expect(byNewName?.records.map((record) => record.id)).toEqual(["rel-1"]);
    expect(byNewName?.records[0]!.displayText).toBe("雾都");

    const byOldName = await service.list(spaceId, relTable, {
      page: 1,
      pageSize: 10,
      search: "旧都",
    });
    expect(byOldName?.records).toEqual([]);
  });
});
