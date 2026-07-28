import {
  MemoryRecordService,
  type MemoryField,
  type MemoryFieldId,
  type MemoryFieldRepository,
  type MemoryRecord,
  type MemoryRecordHistoryId,
  type MemoryRecordId,
  type MemoryRecordRepository,
  type MemoryRevisionId,
  type MemorySpaceId,
  type MemoryTable,
  type MemoryTableId,
  type MemoryTableRepository,
} from "../src/index.ts";
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
    kind: "custom",
    systemKey: null,
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
  commit(): boolean {
    return true;
  }
  listHistory() {
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
  it("creates a typed current record with stable identity, display text, and source details", () => {
    const { service } = createService();
    const location = service.create(spaceId, locationTableId, { payload: { [nameId]: "港口" } });

    const created = service.create(spaceId, characterTableId, {
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
  ])("rejects invalid typed field values and references", (payload, fieldId) => {
    const { service } = createService();

    expect(() => service.create(spaceId, characterTableId, { payload })).toThrowError(
      expect.objectContaining({ param: { fieldId } }),
    );
  });

  it("requires configured fields and marks source-free creation as manual", () => {
    const { service } = createService();

    expect(() => service.create(spaceId, characterTableId, { payload: {} })).toThrowError(
      expect.objectContaining({
        type: "memory_record_required_field_missing",
        param: { fieldId: nameId },
      }),
    );
    expect(
      service.create(spaceId, characterTableId, { payload: { [nameId]: "林夏" } }),
    ).toMatchObject({ source: { type: "manual" } });
  });

  it("searches display text and field values with stable pagination", () => {
    const { service } = createService();
    service.create(spaceId, characterTableId, {
      payload: { [nameId]: "林夏", [roleId]: "主角" },
    });
    service.create(spaceId, characterTableId, {
      payload: { [nameId]: "周遥", [roleId]: "配角" },
    });
    service.create(spaceId, characterTableId, {
      payload: { [nameId]: "顾川", [roleId]: "主角" },
    });

    expect(
      service.list(spaceId, characterTableId, { page: 2, pageSize: 1, search: "主角" }),
    ).toMatchObject({
      page: 2,
      pageSize: 1,
      total: 2,
      totalPages: 2,
      records: [{ id: "record-3", displayText: "顾川" }],
    });
  });

  it("validates persisted payload values when records are read", () => {
    const { records, service } = createService();
    records.values.push({
      id: "record-1" as MemoryRecordId,
      memorySpaceId: spaceId,
      tableId: characterTableId,
      payload: { [nameId]: "林夏", [ageId]: 27.5 },
      displayText: "林夏",
      source: { type: "manual" },
      revisionId: "revision-1" as MemoryRevisionId,
      revisionSource: "user",
      createdAt: "2026-07-28T01:02:03.000Z",
      updatedAt: "2026-07-28T01:02:03.000Z",
    });

    expect(() =>
      service.find(spaceId, characterTableId, "record-1" as MemoryRecordId),
    ).toThrowError(
      expect.objectContaining({
        type: "memory_record_field_value_invalid",
        param: { fieldId: ageId },
      }),
    );
  });

  it("rejects empty required collections and invalid calendar datetimes", () => {
    const setup = createService();
    const roleIndex = setup.fields.findIndex((item) => item.id === roleId);
    setup.fields[roleIndex] = {
      ...setup.fields[roleIndex]!,
      type: "multi_select",
      required: true,
    };
    expect(() =>
      setup.service.create(spaceId, characterTableId, {
        payload: { [nameId]: "林夏", [roleId]: [] },
      }),
    ).toThrowError(expect.objectContaining({ type: "memory_record_field_value_invalid" }));

    setup.fields[roleIndex] = { ...setup.fields[roleIndex]!, required: false };
    const birthdayIndex = setup.fields.findIndex((item) => item.id === birthdayId);
    setup.fields[birthdayIndex] = { ...setup.fields[birthdayIndex]!, type: "datetime" };
    expect(() =>
      setup.service.create(spaceId, characterTableId, {
        payload: { [nameId]: "林夏", [birthdayId]: "2026-02-30T10:00:00" },
      }),
    ).toThrowError(expect.objectContaining({ type: "memory_record_field_value_invalid" }));
  });
});
