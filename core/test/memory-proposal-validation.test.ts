import { describe, expect, it } from "vitest";
import {
  validateProposalOperation,
  validateProposalOperations,
  type MemoryField,
  type MemoryFieldId,
  type MemoryFieldValue,
  type MemoryProposalOperation,
  type MemoryRecord,
  type MemoryRecordId,
  type MemoryRevisionId,
  type MemorySpaceId,
  type MemoryTable,
  type MemoryTableId,
  type MemoryFieldRepository,
  type MemoryRecordRepository,
  type MemoryTableRepository,
} from "../src/memory/index.ts";

const spaceId = "space-1" as MemorySpaceId;
const peopleId = "people" as MemoryTableId;
const placesId = "places" as MemoryTableId;
const archivesId = "archives" as MemoryTableId;
const notesId = "notes" as MemoryTableId;
const nameId = "name" as MemoryFieldId;
const statusId = "status" as MemoryFieldId;
const homeId = "home" as MemoryFieldId;
const bossId = "boss" as MemoryFieldId;

const timestamp = "2026-07-28T00:00:00.000Z";

function table(
  id: MemoryTableId,
  enabled: boolean,
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
    enabled,
    displayStrategy,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function field(
  id: MemoryFieldId,
  tableId: MemoryTableId,
  type: MemoryField["type"],
  options: Partial<MemoryField> = {},
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
    referenceTableId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...options,
  };
}

function record(
  id: string,
  tableId: MemoryTableId,
  payload: Record<string, MemoryFieldValue>,
): MemoryRecord {
  return {
    id: id as MemoryRecordId,
    memorySpaceId: spaceId,
    tableId,
    payload,
    fieldEvidence: {},
    displayText: id,
    source: { type: "manual" },
    revisionId: `rev-${id}` as MemoryRevisionId,
    revisionSource: "user",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

interface FakeRepos {
  readonly tables: MemoryTableRepository;
  readonly fields: MemoryFieldRepository;
  readonly records: MemoryRecordRepository;
}

function createRepos(): FakeRepos {
  const tables: MemoryTable[] = [
    table(peopleId, true, { type: "field", fieldId: nameId }),
    table(placesId, true, { type: "field", fieldId: nameId }),
    table(archivesId, false, null),
    table(notesId, true, null),
  ];
  const fieldsByTable = new Map<MemoryTableId, MemoryField[]>([
    [
      peopleId,
      [
        field(nameId, peopleId, "short_text", { required: true }),
        field(statusId, peopleId, "single_select", { options: ["正常", "受伤"] }),
        field(homeId, peopleId, "single_reference", { referenceTableId: placesId }),
        field(bossId, peopleId, "single_reference", { referenceTableId: peopleId }),
      ],
    ],
    [placesId, [field(nameId, placesId, "short_text")]],
    [archivesId, [field(nameId, archivesId, "short_text")]],
    [notesId, [field(nameId, notesId, "short_text")]],
  ]);
  const recordsByTable = new Map<MemoryTableId, MemoryRecord[]>([
    [
      peopleId,
      [
        record("person-1", peopleId, { [nameId]: "张三", [homeId]: "place-1" }),
        record("person-2", peopleId, {
          [nameId]: "李四",
          [homeId]: "place-1",
          [bossId]: "person-1",
        }),
      ],
    ],
    [placesId, [record("place-1", placesId, { [nameId]: "临渊城" })]],
  ]);

  const listFields = (memorySpaceId: MemorySpaceId, tableId: MemoryTableId) =>
    memorySpaceId === spaceId ? [...(fieldsByTable.get(tableId) ?? [])] : [];
  const listRecords = (memorySpaceId: MemorySpaceId, tableId: MemoryTableId) =>
    memorySpaceId === spaceId ? [...(recordsByTable.get(tableId) ?? [])] : [];

  return {
    tables: {
      async create() {},
      async delete() {
        return false;
      },
      async find(memorySpaceId, id) {
        return memorySpaceId === spaceId
          ? tables.find((candidate) => candidate.id === id)
          : undefined;
      },
      async findByKey() {
        return undefined;
      },
      async list(memorySpaceId) {
        return memorySpaceId === spaceId ? [...tables] : [];
      },
      async update() {
        return false;
      },
    },
    fields: {
      async create() {},
      async delete() {
        return false;
      },
      async find(memorySpaceId, tableId, id) {
        return listFields(memorySpaceId, tableId).find((candidate) => candidate.id === id);
      },
      async findByKey() {
        return undefined;
      },
      async list(memorySpaceId, tableId) {
        return listFields(memorySpaceId, tableId);
      },
      async update() {
        return false;
      },
    },
    records: {
      async create() {},
      async find(memorySpaceId, tableId, id) {
        return listRecords(memorySpaceId, tableId).find((candidate) => candidate.id === id);
      },
      async list(memorySpaceId, tableId) {
        return listRecords(memorySpaceId, tableId);
      },
      async commit() {
        return false;
      },
      async listHistory() {
        return [];
      },
    },
  };
}

function create(
  overrides: Partial<Extract<MemoryProposalOperation, { type: "create" }>> = {},
): MemoryProposalOperation {
  return {
    type: "create",
    tableId: peopleId,
    tempId: "tmp:1",
    patch: { [nameId]: "王五", [statusId]: "正常" },
    externalId: "M1",
    ...overrides,
  };
}

function update(
  overrides: Partial<Extract<MemoryProposalOperation, { type: "update" }>> = {},
): MemoryProposalOperation {
  return {
    type: "update",
    tableId: peopleId,
    recordId: "person-1" as MemoryRecordId,
    expectedRevisionId: "rev-person-1" as MemoryRevisionId,
    patch: { [statusId]: "受伤" },
    externalId: "M2",
    ...overrides,
  };
}

function remove(
  overrides: Partial<Extract<MemoryProposalOperation, { type: "delete" }>> = {},
): MemoryProposalOperation {
  return {
    type: "delete",
    tableId: peopleId,
    recordId: "person-1" as MemoryRecordId,
    expectedRevisionId: "rev-person-1" as MemoryRevisionId,
    externalId: "M3",
    ...overrides,
  };
}

describe("validateProposalOperation（单操作即时校验）", () => {
  it("合法 create/update/delete 无错误", async () => {
    const repos = createRepos();
    expect(await validateProposalOperation(repos, spaceId, create())).toEqual([]);
    expect(await validateProposalOperation(repos, spaceId, update())).toEqual([]);
    expect(await validateProposalOperation(repos, spaceId, remove())).toEqual([]);
  });

  it("create 缺少必填字段报错", async () => {
    const repos = createRepos();
    const errors = await validateProposalOperation(repos, spaceId, create({ patch: {} }));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.externalId).toBe("M1");
    expect(errors[0]!.message).toContain("必填");
  });

  it("create 字段值类型不符报错", async () => {
    const repos = createRepos();
    const errors = await validateProposalOperation(
      repos,
      spaceId,
      create({ patch: { [nameId]: 42 } }),
    );
    expect(errors[0]!.message).toContain("不符合");
  });

  it("create 表未配置显示策略报错；表未启用报错", async () => {
    const repos = createRepos();
    expect(
      (
        await validateProposalOperation(
          repos,
          spaceId,
          create({ tableId: notesId, patch: { [nameId]: "笔记" } }),
        )
      )[0]!.message,
    ).toContain("显示策略");
    expect(
      (await validateProposalOperation(repos, spaceId, create({ tableId: archivesId })))[0]!
        .message,
    ).toContain("未启用");
  });

  it("update/delete 目标记录不存在报错", async () => {
    const repos = createRepos();
    const errors = await validateProposalOperation(
      repos,
      spaceId,
      update({ recordId: "ghost" as MemoryRecordId }),
    );
    expect(errors[0]!.message).toContain("目标记录不存在");
  });

  it("update 把必填字段清空为 null 报错（合并后校验）", async () => {
    const repos = createRepos();
    const errors = await validateProposalOperation(
      repos,
      spaceId,
      update({ patch: { [nameId]: null } }),
    );
    expect(errors[0]!.message).toContain("必填");
  });

  it("单操作校验不查 revision（revision 匹配属跨操作校验）", async () => {
    const repos = createRepos();
    expect(
      await validateProposalOperation(
        repos,
        spaceId,
        update({ expectedRevisionId: "rev-stale" as MemoryRevisionId }),
      ),
    ).toEqual([]);
  });
});

describe("validateProposalOperations（完整校验）", () => {
  it("整批合法操作无错误", async () => {
    const repos = createRepos();
    const errors = await validateProposalOperations(repos, spaceId, [
      create(),
      update(),
      remove({
        recordId: "person-2" as MemoryRecordId,
        expectedRevisionId: "rev-person-2" as MemoryRevisionId,
      }),
    ]);
    expect(errors).toEqual([]);
  });

  it("update/delete 的 expectedRevision 不匹配报错", async () => {
    const repos = createRepos();
    const errors = await validateProposalOperations(repos, spaceId, [
      update({ expectedRevisionId: "rev-stale" as MemoryRevisionId }),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("期望修订与当前不一致");
    expect(errors[0]!.externalId).toBe("M2");
  });

  it("create 的引用字段指向后续 create 的 tempId 通过；指向不存在/错表的 tempId 报错", async () => {
    const repos = createRepos();
    const self = create({ tableId: placesId, tempId: "tmp:9", patch: { [nameId]: "新地点" } });
    const referencing = create({ patch: { [nameId]: "王五", [homeId]: "tmp:9" } });
    expect(await validateProposalOperations(repos, spaceId, [self, referencing])).toEqual([]);

    const dangling = create({ patch: { [nameId]: "王五", [homeId]: "tmp:9" } });
    const errors = await validateProposalOperations(repos, spaceId, [dangling]);
    expect(errors[0]!.message).toContain("临时 ID tmp:9");
  });

  it("引用字段指向不存在的真实记录报错；指向存在的真实记录通过", async () => {
    const repos = createRepos();
    const missing = create({ patch: { [nameId]: "王五", [homeId]: "place-ghost" } });
    expect((await validateProposalOperations(repos, spaceId, [missing]))[0]!.message).toContain(
      "引用的记录 place-ghost 不存在",
    );
    const ok = create({ patch: { [nameId]: "王五", [homeId]: "place-1" } });
    expect(await validateProposalOperations(repos, spaceId, [ok])).toEqual([]);
  });

  it("批次内 tempId 重复报错", async () => {
    const repos = createRepos();
    const errors = await validateProposalOperations(repos, spaceId, [
      create(),
      create({ externalId: "M9" }),
    ]);
    expect(errors[0]!.message).toContain("重复");
  });

  it("删除被引用记录报错（含批次内新增引用），同一批次解除引用后通过", async () => {
    const repos = createRepos();
    // person-1 被 person-2 的 boss 字段引用
    const errors = await validateProposalOperations(repos, spaceId, [remove()]);
    expect(errors[0]!.message).toContain("仍被引用");

    const detached = await validateProposalOperations(repos, spaceId, [
      update({
        recordId: "person-2" as MemoryRecordId,
        expectedRevisionId: "rev-person-2" as MemoryRevisionId,
        patch: { [bossId]: null },
      }),
      remove(),
    ]);
    expect(detached).toEqual([]);

    // 批次内新增记录引用被删记录同样报错
    const reattached = await validateProposalOperations(repos, spaceId, [
      create({ patch: { [nameId]: "赵六", [bossId]: "person-1" } }),
      remove(),
    ]);
    expect(reattached[0]!.message).toContain("仍被引用");
  });

  it("错误按操作收集（互不掩盖）", async () => {
    const repos = createRepos();
    const errors = await validateProposalOperations(repos, spaceId, [
      create({ patch: {} }),
      update({ expectedRevisionId: "rev-stale" as MemoryRevisionId }),
    ]);
    expect(errors).toHaveLength(2);
    expect(errors.map((error) => error.externalId)).toEqual(["M1", "M2"]);
  });
});
