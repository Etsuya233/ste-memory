import {
  MemoryRecordService,
  type MemoryField,
  type MemoryFieldId,
  type MemoryFieldRepository,
  type MemoryRecord,
  type MemoryRecordHistory,
  type MemoryRecordId,
  type MemoryRecordMutation,
  type MemoryRecordRepository,
  type MemoryRevisionId,
  type MemorySpaceId,
  type MemoryTable,
  type MemoryTableId,
  type MemoryTableRepository,
} from "../src/index.ts";
import { describe, expect, it } from "vitest";

const spaceId = "space-1" as MemorySpaceId;
const peopleId = "people" as MemoryTableId;
const placesId = "places" as MemoryTableId;
const nameId = "name" as MemoryFieldId;
const noteId = "note" as MemoryFieldId;

function table(id: MemoryTableId): MemoryTable {
  return {
    id,
    memorySpaceId: spaceId,
    kind: "custom",
    systemKey: null,
    name: id,
    description: "",
    prompt: "",
    enabled: true,
    displayStrategy: { type: "field", fieldId: nameId },
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

function field(id: MemoryFieldId, tableId: MemoryTableId, required: boolean): MemoryField {
  return {
    id,
    memorySpaceId: spaceId,
    tableId,
    name: id,
    type: "short_text",
    required,
    prompt: "",
    enabled: true,
    position: 0,
    options: [],
    referenceTableId: null,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

class Records implements MemoryRecordRepository {
  readonly values: MemoryRecord[] = [];
  readonly history: MemoryRecordHistory[] = [];

  create(record: MemoryRecord): void {
    this.values.push(record);
  }

  find(memorySpaceId: MemorySpaceId, tableId: MemoryTableId, id: MemoryRecordId) {
    return this.values.find(
      (record) =>
        record.memorySpaceId === memorySpaceId && record.tableId === tableId && record.id === id,
    );
  }

  list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId) {
    return this.values.filter(
      (record) => record.memorySpaceId === memorySpaceId && record.tableId === tableId,
    );
  }

  commit(mutations: readonly MemoryRecordMutation[]): boolean {
    if (
      mutations.some(
        (mutation) =>
          this.find(
            mutation.previous.memorySpaceId,
            mutation.previous.tableId,
            mutation.previous.id,
          )?.revisionId !== mutation.previous.revisionId,
      )
    ) {
      return false;
    }
    for (const mutation of mutations) {
      const index = this.values.findIndex((record) => record.id === mutation.previous.id);
      this.history.push(mutation.history);
      if (mutation.current) this.values[index] = mutation.current;
      else this.values.splice(index, 1);
    }
    return true;
  }

  listHistory(query: Parameters<MemoryRecordRepository["listHistory"]>[0]) {
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
    field(nameId, peopleId, true),
    field(noteId, peopleId, false),
    field(nameId, placesId, true),
  ];
  const records = new Records();
  let recordNumber = 0;
  let historyNumber = 0;
  const tableRepository: MemoryTableRepository = {
    create() {},
    delete: () => false,
    find: (candidateSpaceId, id) =>
      tables.find((item) => item.memorySpaceId === candidateSpaceId && item.id === id),
    list: (candidateSpaceId) => tables.filter((item) => item.memorySpaceId === candidateSpaceId),
    update: () => false,
  };
  const fieldRepository: MemoryFieldRepository = {
    create() {},
    delete: () => false,
    find: (candidateSpaceId, tableId, id) =>
      fields.find(
        (item) =>
          item.memorySpaceId === candidateSpaceId && item.tableId === tableId && item.id === id,
      ),
    list: (candidateSpaceId, tableId) =>
      fields.filter((item) => item.memorySpaceId === candidateSpaceId && item.tableId === tableId),
    update: () => false,
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

describe("MemoryRecordService mutations", () => {
  it("patches and deletes records atomically with one revision and complete snapshots", () => {
    const { records, service } = setup();
    const person = service.create(spaceId, peopleId, {
      payload: { [nameId]: "林夏", [noteId]: "旧备注" },
    })!;
    const place = service.create(spaceId, placesId, { payload: { [nameId]: "港口" } })!;

    const result = service.mutate(spaceId, {
      revisionSource: "agent",
      operations: [
        {
          type: "update",
          tableId: peopleId,
          recordId: person.id,
          expectedRevisionId: person.revisionId,
          patch: { [noteId]: null },
        },
        {
          type: "delete",
          tableId: placesId,
          recordId: place.id,
          expectedRevisionId: place.revisionId,
        },
      ],
    });

    expect(result).toMatchObject({ revisionId: "revision-batch", changed: 2 });
    expect(records.find(spaceId, peopleId, person.id)).toMatchObject({
      payload: { [nameId]: "林夏", [noteId]: null },
      revisionId: "revision-batch",
      revisionSource: "agent",
      createdAt: person.createdAt,
      updatedAt: "2026-07-28T02:00:00.000Z",
    });
    expect(records.find(spaceId, placesId, place.id)).toBeUndefined();
    expect(records.history).toEqual([
      expect.objectContaining({
        id: "history-1",
        recordId: person.id,
        payload: person.payload,
        previousRevisionId: person.revisionId,
        revisionId: "revision-batch",
        revisionSource: "agent",
      }),
      expect.objectContaining({
        id: "history-2",
        recordId: place.id,
        payload: place.payload,
        previousRevisionId: place.revisionId,
        revisionId: "revision-batch",
      }),
    ]);
  });

  it("rejects a stale expected revision without applying any operation", () => {
    const { records, service } = setup();
    const person = service.create(spaceId, peopleId, { payload: { [nameId]: "林夏" } })!;
    const place = service.create(spaceId, placesId, { payload: { [nameId]: "港口" } })!;

    expect(() =>
      service.mutate(spaceId, {
        revisionSource: "user",
        operations: [
          {
            type: "update",
            tableId: peopleId,
            recordId: person.id,
            expectedRevisionId: "stale" as MemoryRevisionId,
            patch: { [nameId]: "周遥" },
          },
          {
            type: "delete",
            tableId: placesId,
            recordId: place.id,
            expectedRevisionId: place.revisionId,
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ type: "memory_record_revision_conflict" }));
    expect(records.values).toHaveLength(2);
    expect(records.history).toHaveLength(0);
  });

  it("lists immutable history by record, revision, and archive time", () => {
    const { service } = setup();
    const person = service.create(spaceId, peopleId, { payload: { [nameId]: "林夏" } })!;
    service.update(spaceId, peopleId, person.id, {
      expectedRevisionId: person.revisionId,
      patch: { [nameId]: "林夏（化名）" },
      revisionSource: "user",
    });

    expect(
      service.listHistory(spaceId, {
        tableId: peopleId,
        recordId: person.id,
        revisionId: "revision-batch" as MemoryRevisionId,
        archivedFrom: "2026-07-28T01:00:00.000Z",
        archivedTo: "2026-07-28T03:00:00.000Z",
      }),
    ).toEqual([expect.objectContaining({ payload: { [nameId]: "林夏" } })]);
  });
});
