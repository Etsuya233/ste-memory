import { describe, expect, it } from "vitest";
import {
  commitMemoryProposalBatch,
  computeMemoryRecordDisplayText,
  memoryProposalSubmission,
  previewProposal,
  type MemoryEvidence,
  type MemoryEvidenceId,
  type MemoryField,
  type MemoryFieldId,
  type MemoryMessageRange,
  type MemoryProposalCreateOperation,
  type MemoryProposalOperation,
  type MemoryRecord,
  type MemoryRecordHistory,
  type MemoryRecordId,
  type MemoryRecordMutationContext,
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

/**
 * 回归测试（批内引用显示文本）：填表 Agent 一次提交里先 create 人物/地点、
 * 再 create 引用它们的关系记录（tmp: 临时 ID）。修复前 displayText 只查仓库——
 * 同批新建尚未落库，引用解析为空（如关系显示成 " <-> "）；修复后按批内待落库
 * 记录解析，预览与提交的显示文本一致且正确。
 */

const spaceId = "space-1" as MemorySpaceId;
const peopleId = "people" as MemoryTableId;
const placesId = "places" as MemoryTableId;
const nameId = "name" as MemoryFieldId;
const homeId = "home" as MemoryFieldId;

/** people 表模板显示策略：`{name}（住在{home}）`，home 引用 places 表。 */
function displayStrategy() {
  return { type: "template" as const, template: `{${nameId}}（住在{${homeId}}）` };
}

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
    displayStrategy: id === peopleId ? displayStrategy() : { type: "field", fieldId: nameId },
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
          this.values.find((record) => record.id === mutation.previous.id)?.revisionId !==
            mutation.previous.revisionId,
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

  async listHistory() {
    return this.history;
  }
}

interface TestRepos {
  readonly records: Records;
  readonly ports: {
    tables: MemoryTableRepository;
    fields: MemoryFieldRepository;
    records: Records;
  };
  readonly context: MemoryRecordMutationContext;
}

function setup(
  tables: readonly MemoryTable[] = [table(peopleId), table(placesId)],
  fieldList: readonly MemoryField[] = [
    field(nameId, peopleId),
    field(homeId, peopleId, placesId),
    field(nameId, placesId),
  ],
): TestRepos {
  const fields = [...fieldList];
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
    find: async (candidateSpaceId, candidateTableId, id) =>
      fields.find(
        (item) =>
          item.memorySpaceId === candidateSpaceId &&
          item.tableId === candidateTableId &&
          item.id === id,
      ),
    findByKey: async () => undefined,
    list: async (candidateSpaceId, candidateTableId) =>
      fields.filter(
        (item) => item.memorySpaceId === candidateSpaceId && item.tableId === candidateTableId,
      ),
    update: async () => false,
  };
  const context: MemoryRecordMutationContext = {
    tables: tableRepository,
    fields: fieldRepository,
    records,
    createId: () => `record-${++recordNumber}` as MemoryRecordId,
    createHistoryId: () => `history-${++historyNumber}`,
    createRevisionId: () => "revision-batch" as MemoryRevisionId,
    now: () => "2026-07-28T02:00:00.000Z",
    displayText: (table, fieldList, payload, resolveReference) =>
      computeMemoryRecordDisplayText(
        records,
        table.memorySpaceId,
        table,
        fieldList,
        payload,
        resolveReference,
      ),
  };
  const ports = { tables: tableRepository, fields: fieldRepository, records };
  return { records, ports, context };
}

function evidence(range: MemoryMessageRange): readonly MemoryEvidence[] {
  return [
    {
      evidence_id: "evidence-1" as MemoryEvidenceId,
      source_type: "sillytavern_jsonl",
      source_id: range.from,
      storage_mode: "reference",
      extraProps: {},
    },
  ];
}

/** 同一批：先 create 地点，再 create 引用它的人物（模板显示文本依赖批内解析）。 */
const batchCreates: readonly MemoryProposalCreateOperation[] = [
  { type: "create", tableId: placesId, tempId: "tmp:r1", patch: { [nameId]: "港口" } },
  {
    type: "create",
    tableId: peopleId,
    tempId: "tmp:r2",
    patch: { [nameId]: "周遥", [homeId]: "tmp:r1" },
  },
];

describe("批内引用显示文本（提交路径，commitMemoryProposalBatch）", () => {
  it("模板策略占位符不在字段集中：预览/提交回退显示文本，不崩溃（定义漂移兜底）", async () => {
    // 字段集缺 home（克隆后策略 drift 的等价场景）：曾以非空断言 TypeError 崩溃，
    // 导致 proposal_preview 连环失败与显示文本被洗白；现按路径语义回退。
    const driftedFields = [field(nameId, peopleId), field(nameId, placesId)];
    const { records, ports, context } = setup(undefined, driftedFields);
    const existing: MemoryRecord = {
      id: "record-9" as MemoryRecordId,
      memorySpaceId: spaceId,
      tableId: peopleId,
      payload: { [nameId]: "顾川" },
      fieldEvidence: {},
      displayText: "顾川（住在旧都）",
      source: { type: "manual" },
      revisionId: "revision-9" as MemoryRevisionId,
      revisionSource: "user",
      createdAt: "2026-07-28T01:00:00.000Z",
      updatedAt: "2026-07-28T01:00:00.000Z",
    };
    records.values.push(existing);

    // 预览：整批不抛错；update 回退存储显示文本，create 回退空串
    const preview = await previewProposal(ports, spaceId, [
      { type: "create", tableId: placesId, tempId: "tmp:r1", patch: { [nameId]: "港口" } },
      {
        type: "update",
        tableId: peopleId,
        recordId: existing.id,
        expectedRevisionId: existing.revisionId,
        patch: { [nameId]: "顾川" },
      },
    ]);
    const createOp = preview.operations.find((operation) => operation.op === "create")!;
    const updateOp = preview.operations.find((operation) => operation.op === "update")!;
    expect(createOp.display).toBe("港口"); // places 表 field 策略不受漂移影响
    expect(updateOp.display).toBe("顾川（住在旧都）");

    // 提交：同样不抛错，update 保留既有显示文本（不再把显示文本洗白为空）
    await commitMemoryProposalBatch(
      context,
      spaceId,
      memoryProposalSubmission({ from: 1, to: 1 }, evidence({ from: 1, to: 1 }), [], {
        create: [
          { type: "create", tableId: placesId, tempId: "tmp:r1", patch: { [nameId]: "港口" } },
        ],
        update: [
          {
            type: "update",
            tableId: peopleId,
            recordId: existing.id,
            expectedRevisionId: existing.revisionId,
            patch: { [nameId]: "顾川" },
          },
        ],
        delete: [],
      }),
      "agent",
    );
    const updated = records.values.find((record) => record.id === existing.id)!;
    expect(updated.displayText).toBe("顾川（住在旧都）");
  });

  it("create 的模板显示文本解析同批 create 引用（临时 ID 改写为真实 ID）", async () => {
    const { records, context } = setup();

    await commitMemoryProposalBatch(
      context,
      spaceId,
      memoryProposalSubmission({ from: 1, to: 1 }, evidence({ from: 1, to: 1 }), [], {
        create: batchCreates,
        update: [],
        delete: [],
      }),
      "agent",
    );

    const port = records.values.find((record) => record.payload[nameId] === "港口")!;
    const zhouyao = records.values.find((record) => record.payload[nameId] === "周遥")!;
    // 修复前：people 显示文本渲染为「周遥（住在）」——同批地点尚未落库，引用解析为空
    expect(port.displayText).toBe("港口");
    expect(zhouyao.payload[homeId]).toBe(port.id);
    expect(zhouyao.displayText).toBe(`周遥（住在${port.displayText}）`);
  });

  it("update 的显示文本解析同批 create 引用", async () => {
    const { records, context } = setup();
    const existing: MemoryRecord = {
      id: "record-0" as MemoryRecordId,
      memorySpaceId: spaceId,
      tableId: peopleId,
      payload: { [nameId]: "林夏", [homeId]: null },
      fieldEvidence: {},
      displayText: "林夏（住在）",
      source: { type: "manual" },
      revisionId: "revision-0" as MemoryRevisionId,
      revisionSource: "user",
      createdAt: "2026-07-28T01:00:00.000Z",
      updatedAt: "2026-07-28T01:00:00.000Z",
    };
    records.values.push(existing);

    await commitMemoryProposalBatch(
      context,
      spaceId,
      memoryProposalSubmission({ from: 1, to: 1 }, evidence({ from: 1, to: 1 }), [], {
        create: [
          { type: "create", tableId: placesId, tempId: "tmp:r1", patch: { [nameId]: "港口" } },
        ],
        update: [
          {
            type: "update",
            tableId: peopleId,
            recordId: existing.id,
            expectedRevisionId: existing.revisionId,
            patch: { [homeId]: "tmp:r1" },
          },
        ],
        delete: [],
      }),
      "agent",
    );

    const port = records.values.find((record) => record.payload[nameId] === "港口")!;
    const updated = records.values.find((record) => record.id === existing.id)!;
    expect(updated.payload[homeId]).toBe(port.id);
    expect(updated.displayText).toBe(`林夏（住在${port.displayText}）`);
  });
});

describe("批内引用显示文本（预览路径，previewProposal）", () => {
  it("create 的预览显示文本解析同批 create 引用（临时 ID 原样解析）", async () => {
    const { ports } = setup();

    const preview = await previewProposal(ports, spaceId, batchCreates);

    const portPreview = preview.operations.find((operation) => operation.tempId === "tmp:r1")!;
    const zhouyaoPreview = preview.operations.find((operation) => operation.tempId === "tmp:r2")!;
    expect(portPreview.display).toBe("港口");
    expect(zhouyaoPreview.display).toBe(`周遥（住在${portPreview.display}）`);
  });

  it("链式批内引用（关系→人物→地点）逐层解析", async () => {
    const relationshipTable: MemoryTable = {
      id: "relationships" as MemoryTableId,
      memorySpaceId: spaceId,
      key: "relationships",
      kind: "custom",
      name: "人际关系",
      description: "",
      prompt: "",
      enabled: true,
      displayStrategy: { type: "template", template: "{character_a} <-> {character_b}" },
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    };
    const characterA = "character_a" as MemoryFieldId;
    const characterB = "character_b" as MemoryFieldId;
    const relationshipFields: readonly MemoryField[] = [
      {
        id: characterA,
        memorySpaceId: spaceId,
        tableId: relationshipTable.id,
        name: "人物 A",
        type: "single_reference",
        required: true,
        prompt: "",
        enabled: true,
        position: 0,
        options: [],
        referenceTableId: peopleId,
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z",
      },
      {
        id: characterB,
        memorySpaceId: spaceId,
        tableId: relationshipTable.id,
        name: "人物 B",
        type: "single_reference",
        required: true,
        prompt: "",
        enabled: true,
        position: 1,
        options: [],
        referenceTableId: peopleId,
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z",
      },
    ];
    const { ports } = setup([table(peopleId), table(placesId), relationshipTable]);
    const relationshipFieldsRepo: MemoryFieldRepository = {
      ...ports.fields,
      list: async (candidateSpaceId, candidateTableId) => [
        ...relationshipFields,
        ...(await ports.fields.list(candidateSpaceId, candidateTableId)),
      ],
    };
    const operations: readonly MemoryProposalOperation[] = [
      { type: "create", tableId: placesId, tempId: "tmp:p", patch: { [nameId]: "港口" } },
      {
        type: "create",
        tableId: peopleId,
        tempId: "tmp:lin",
        patch: { [nameId]: "林夏", [homeId]: "tmp:p" },
      },
      {
        type: "create",
        tableId: peopleId,
        tempId: "tmp:zhou",
        patch: { [nameId]: "周遥", [homeId]: "tmp:p" },
      },
      {
        type: "create",
        tableId: relationshipTable.id,
        tempId: "tmp:rel",
        patch: { [characterA]: "tmp:lin", [characterB]: "tmp:zhou" },
      },
    ];

    const preview = await previewProposal(
      { tables: ports.tables, fields: relationshipFieldsRepo, records: ports.records },
      spaceId,
      operations,
    );

    const relationship = preview.operations.find((operation) => operation.tempId === "tmp:rel")!;
    expect(relationship.display).toBe("林夏（住在港口） <-> 周遥（住在港口）");
  });
});
