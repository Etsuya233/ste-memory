import {
  commitMemoryProposalBatch,
  memoryProposalSubmission,
  type MemoryEvidence,
  type MemoryEvidenceId,
  type MemoryField,
  type MemoryFieldId,
  type MemoryMessageRange,
  type MemoryProposalSubmission,
  type MemoryRecord,
  type MemoryRecordHistory,
  type MemoryRecordId,
  type MemoryRevisionId,
  type MemorySpaceId,
  type MemoryTable,
  type MemoryTableId,
  type MemoryRecordMutationContext,
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
  const context: MemoryRecordMutationContext = {
    tables: tableRepository,
    fields: fieldRepository,
    records,
    createId: () => `record-${++recordNumber}` as MemoryRecordId,
    createHistoryId: () => `history-${++historyNumber}`,
    createRevisionId: () => "revision-batch" as MemoryRevisionId,
    now: () => "2026-07-28T02:00:00.000Z",
    displayText: async (_table, _fields, payload, _resolveReference) =>
      String(payload[nameId] ?? ""),
  };
  return { records, context };
}

function submission(
  operations: MemoryProposalSubmission["batch"],
  range: MemoryMessageRange = { from: 1, to: 2 },
): MemoryProposalSubmission {
  return memoryProposalSubmission(range, evidence(range), [], operations);
}

function evidence(range: MemoryMessageRange): readonly MemoryEvidence[] {
  const result: MemoryEvidence[] = [];
  for (let sourceId = range.from; sourceId <= range.to; sourceId += 1) {
    result.push({
      evidence_id: `evidence-${sourceId}` as MemoryEvidenceId,
      source_type: "sillytavern_jsonl",
      source_id: sourceId,
      storage_mode: "reference",
      extraProps: {},
    });
  }
  return result;
}

describe("commitMemoryProposalBatch", () => {
  it("原子提交冻结提案：create/update/delete 共享修订、临时 ID 改写、证据随批次保存", async () => {
    const { records, context } = setup();
    const linxia: MemoryRecord = {
      id: "record-0" as MemoryRecordId,
      memorySpaceId: spaceId,
      tableId: peopleId,
      payload: { [nameId]: "林夏" },
      fieldEvidence: {},
      displayText: "林夏",
      source: { type: "manual" },
      revisionId: "revision-0" as MemoryRevisionId,
      revisionSource: "user",
      createdAt: "2026-07-28T01:00:00.000Z",
      updatedAt: "2026-07-28T01:00:00.000Z",
    };
    records.values.push(linxia);

    const result = await commitMemoryProposalBatch(
      context,
      spaceId,
      submission({
        create: [
          { type: "create", tableId: placesId, tempId: "tmp:r1", patch: { [nameId]: "港口" } },
          {
            type: "create",
            tableId: peopleId,
            tempId: "tmp:r2",
            patch: { [nameId]: "周遥", [homeId]: "tmp:r1" },
          },
        ],
        update: [
          {
            type: "update",
            tableId: peopleId,
            recordId: linxia.id,
            expectedRevisionId: linxia.revisionId,
            patch: { [homeId]: "tmp:r1" },
          },
        ],
        delete: [],
      }),
      "agent",
    );

    expect(result).toMatchObject({ revisionId: "revision-batch", changed: 3 });
    const port = records.values.find((record) => record.payload[nameId] === "港口")!;
    const zhouyao = records.values.find((record) => record.payload[nameId] === "周遥")!;
    expect(port).toMatchObject({
      id: "record-1",
      source: { type: "source", sourceTime: null, sourceLocation: null },
      revisionSource: "agent",
    });
    expect(zhouyao.payload[homeId]).toBe(port.id);
    const updated = records.values.find((record) => record.id === linxia.id)!;
    expect(updated.payload[homeId]).toBe(port.id);
    expect(records.history).toEqual([
      expect.objectContaining({ recordId: linxia.id, revisionId: "revision-batch" }),
    ]);
    expect(records.committedEvidence).toEqual([
      [
        {
          evidence_id: "evidence-1",
          source_type: "sillytavern_jsonl",
          source_id: 1,
          storage_mode: "reference",
          extraProps: {},
        },
        {
          evidence_id: "evidence-2",
          source_type: "sillytavern_jsonl",
          source_id: 2,
          storage_mode: "reference",
          extraProps: {},
        },
      ],
    ]);
  });

  it("空批次不写库、不写证据，只返回新修订身份", async () => {
    const { records, context } = setup();

    const result = await commitMemoryProposalBatch(
      context,
      spaceId,
      submission({ create: [], update: [], delete: [] }),
      "agent",
    );

    expect(result).toMatchObject({ changed: 0 });
    expect(records.values).toHaveLength(0);
    expect(records.history).toHaveLength(0);
    expect(records.committedEvidence).toHaveLength(0);
  });
});
