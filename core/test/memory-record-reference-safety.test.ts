import {
  MemoryRecordService,
  type MemoryField,
  type MemoryFieldId,
  type MemoryRecord,
  type MemoryRecordHistory,
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
const foreignSpaceId = "space-2" as MemorySpaceId;
const peopleId = "people" as MemoryTableId;
const placesId = "places" as MemoryTableId;
const plotsId = "plots" as MemoryTableId;
const nameId = "name" as MemoryFieldId;
const locationId = "location" as MemoryFieldId;
const relatedPeopleId = "related-people" as MemoryFieldId;

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
  type: MemoryField["type"] = "short_text",
  referenceTableId: MemoryTableId | null = null,
): MemoryField {
  return {
    id,
    memorySpaceId: spaceId,
    tableId,
    name: id,
    type,
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
      const index = this.values.findIndex((record) => record.id === mutation.previous.id);
      this.history.push(mutation.history);
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
  const tables = [table(peopleId), table(placesId), table(plotsId)];
  const fields = [
    field(nameId, peopleId),
    field(locationId, peopleId, "single_reference", placesId),
    field(nameId, placesId),
    field(nameId, plotsId),
    field(relatedPeopleId, plotsId, "multi_reference", peopleId),
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
  return {
    records,
    service: new MemoryRecordService(
      tableRepository,
      fieldRepository,
      records,
      () => `record-${++recordNumber}` as MemoryRecordId,
      () => `history-${++historyNumber}`,
      () => `revision-${recordNumber}` as MemoryRevisionId,
      () => "2026-07-28T02:00:00.000Z",
    ),
  };
}

describe("memory record reference safety", () => {
  it("accepts stable IDs for single and multi references in their configured target tables", async () => {
    const { service } = setup();
    const place = (await service.create(spaceId, placesId, { payload: { [nameId]: "港口" } }))!;
    const person = (await service.create(spaceId, peopleId, {
      payload: { [nameId]: "林夏", [locationId]: place.id },
    }))!;
    const plot = (await service.create(spaceId, plotsId, {
      payload: { [nameId]: "追踪", [relatedPeopleId]: [person.id] },
    }))!;

    expect(person.payload[locationId]).toBe(place.id);
    expect(plot.payload[relatedPeopleId]).toEqual([person.id]);
  });

  it("rejects references to another table or memory space", async () => {
    const { records, service } = setup();
    const person = (await service.create(spaceId, peopleId, { payload: { [nameId]: "林夏" } }))!;
    records.values.push({
      ...person,
      id: "foreign-place" as MemoryRecordId,
      memorySpaceId: foreignSpaceId,
      tableId: placesId,
    });

    for (const targetId of [person.id, "foreign-place"]) {
      await expect(
        service.create(spaceId, peopleId, {
          payload: { [nameId]: "周遥", [locationId]: targetId },
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          type: "memory_record_reference_invalid",
          param: { fieldId: locationId },
        }),
      );
    }
    await expect(
      service.mutate(
        spaceId,
        {
          revisionSource: "agent",
          operations: [
            {
              type: "update",
              tableId: peopleId,
              recordId: person.id,
              expectedRevisionId: person.revisionId,
              patch: { [locationId]: person.id },
            },
          ],
        },
        [],
      ),
    ).rejects.toThrowError(
      expect.objectContaining({
        type: "memory_record_reference_invalid",
        param: { fieldId: locationId },
      }),
    );
  });

  it("blocks user and agent deletion with every current reference location", async () => {
    const { service } = setup();
    const place = (await service.create(spaceId, placesId, { payload: { [nameId]: "港口" } }))!;
    const person = (await service.create(spaceId, peopleId, {
      payload: { [nameId]: "林夏", [locationId]: place.id },
    }))!;
    const plot = (await service.create(spaceId, plotsId, {
      payload: { [nameId]: "追踪", [relatedPeopleId]: [person.id] },
    }))!;

    await expect(
      service.delete(spaceId, placesId, place.id, place.revisionId, "user"),
    ).rejects.toThrowError(
      expect.objectContaining({
        type: "memory_record_referenced",
        param: {
          recordId: place.id,
          references: [{ tableId: peopleId, recordId: person.id, fieldId: locationId }],
        },
      }),
    );
    await expect(
      service.mutate(
        spaceId,
        {
          revisionSource: "agent",
          operations: [
            {
              type: "delete",
              tableId: peopleId,
              recordId: person.id,
              expectedRevisionId: person.revisionId,
            },
          ],
        },
        [],
      ),
    ).rejects.toThrowError(
      expect.objectContaining({
        type: "memory_record_referenced",
        param: {
          recordId: person.id,
          references: [{ tableId: plotsId, recordId: plot.id, fieldId: relatedPeopleId }],
        },
      }),
    );
  });

  it("transfers a reference and deletes its old target in one atomic batch", async () => {
    const { records, service } = setup();
    const oldPlace = (await service.create(spaceId, placesId, { payload: { [nameId]: "旧港" } }))!;
    const newPlace = (await service.create(spaceId, placesId, { payload: { [nameId]: "新港" } }))!;
    const person = (await service.create(spaceId, peopleId, {
      payload: { [nameId]: "林夏", [locationId]: oldPlace.id },
    }))!;

    expect(
      await service.mutate(
        spaceId,
        {
          revisionSource: "agent",
          operations: [
            {
              type: "update",
              tableId: peopleId,
              recordId: person.id,
              expectedRevisionId: person.revisionId,
              patch: { [locationId]: newPlace.id },
            },
            {
              type: "delete",
              tableId: placesId,
              recordId: oldPlace.id,
              expectedRevisionId: oldPlace.revisionId,
            },
          ],
        },
        [],
      ),
    ).toMatchObject({ changed: 2 });
    expect((await records.find(spaceId, peopleId, person.id))?.payload[locationId]).toBe(
      newPlace.id,
    );
    expect(await records.find(spaceId, placesId, oldPlace.id)).toBeUndefined();
    expect(records.history[0]?.payload[locationId]).toBe(oldPlace.id);
  });
});
