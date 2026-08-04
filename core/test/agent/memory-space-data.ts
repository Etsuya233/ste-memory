import type {
  MemoryField,
  MemoryFieldId,
  MemoryFieldValue,
  MemoryRecord,
  MemoryRecordId,
  MemoryRevisionId,
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
  MemoryTableKey,
  MemoryFieldKey,
} from "../../src/memory/index.ts";

/** 测试记忆空间 id 与表/字段 id 常量。 */
export const SPACE_ID = "space-1" as MemorySpaceId;

export const TABLE_CHARACTERS = "table-characters" as MemoryTableId;
export const TABLE_LOCATIONS = "table-locations" as MemoryTableId;
export const TABLE_ARCHIVES = "table-archives" as MemoryTableId;

export const FIELD_NAME = "field-name" as MemoryFieldId;
export const FIELD_CURRENT_STATUS = "field-current-status" as MemoryFieldId;
export const FIELD_LOCATION = "field-location" as MemoryFieldId;
export const FIELD_ALIASES = "field-aliases" as MemoryFieldId;
export const FIELD_SECRET_NOTES = "field-secret-notes" as MemoryFieldId;

const timestamp = "2026-07-30T00:00:00.000Z";

/**
 * 内存记忆空间数据：三张表（两张启用、一张停用），
 * characters 含启用/停用字段、引用字段（→ locations）、多值字段与多选字段。
 */
export const TABLES: readonly MemoryTable[] = [
  table(TABLE_CHARACTERS, "characters", "人物", true),
  table(TABLE_LOCATIONS, "locations", "地点", true),
  table(TABLE_ARCHIVES, "archives", "归档", false),
];

export const FIELDS_BY_TABLE_ID = new Map<MemoryTableId, readonly MemoryField[]>([
  [
    TABLE_CHARACTERS,
    [
      field(FIELD_NAME, "name", "名称", "short_text", { required: true }, TABLE_CHARACTERS, 0),
      field(
        FIELD_CURRENT_STATUS,
        "current_status",
        "当前状态",
        "single_select",
        { options: ["正常", "受伤", "死亡"] },
        TABLE_CHARACTERS,
        1,
      ),
      field(
        FIELD_LOCATION,
        "location",
        "所在地",
        "single_reference",
        { referenceTableId: TABLE_LOCATIONS },
        TABLE_CHARACTERS,
        2,
      ),
      field(FIELD_ALIASES, "aliases", "别名", "short_text_list", {}, TABLE_CHARACTERS, 3),
      field(
        FIELD_SECRET_NOTES,
        "secret_notes",
        "秘闻",
        "long_text",
        { enabled: false },
        TABLE_CHARACTERS,
        4,
      ),
    ],
  ],
  [
    TABLE_LOCATIONS,
    [
      field(
        "field-loc-name" as MemoryFieldId,
        "name",
        "名称",
        "short_text",
        {},
        TABLE_LOCATIONS,
        0,
      ),
    ],
  ],
  [
    TABLE_ARCHIVES,
    [
      field(
        "field-arch-name" as MemoryFieldId,
        "name",
        "名称",
        "short_text",
        {},
        TABLE_ARCHIVES,
        0,
      ),
    ],
  ],
]);

export const RECORDS_BY_TABLE_ID = new Map<MemoryTableId, readonly MemoryRecord[]>([
  [
    TABLE_CHARACTERS,
    [
      record("record-1", "云烬", TABLE_CHARACTERS, {
        [FIELD_NAME]: "云烬",
        [FIELD_CURRENT_STATUS]: "受伤",
        [FIELD_LOCATION]: "loc-1",
        [FIELD_ALIASES]: ["云烬", "烬"],
      }),
      record("record-2", "顾川", TABLE_CHARACTERS, {
        [FIELD_NAME]: "顾川",
        [FIELD_CURRENT_STATUS]: "正常",
        [FIELD_LOCATION]: "loc-2",
        [FIELD_ALIASES]: ["顾川"],
      }),
      record("record-3", "周遥", TABLE_CHARACTERS, {
        [FIELD_NAME]: "周遥",
        [FIELD_CURRENT_STATUS]: "受伤",
        [FIELD_LOCATION]: "loc-2",
        [FIELD_ALIASES]: ["阿遥"],
      }),
    ],
  ],
  [
    TABLE_LOCATIONS,
    [
      record("loc-1", "临渊城", TABLE_LOCATIONS, { [FIELD_NAME]: "临渊城" }),
      record("loc-2", "白帝城", TABLE_LOCATIONS, { [FIELD_NAME]: "白帝城" }),
    ],
  ],
]);

export function listFieldsOf(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): MemoryField[] {
  return memorySpaceId === SPACE_ID ? [...(FIELDS_BY_TABLE_ID.get(tableId) ?? [])] : [];
}

export function listRecordsOf(
  memorySpaceId: MemorySpaceId,
  tableId: MemoryTableId,
): MemoryRecord[] {
  return memorySpaceId === SPACE_ID ? [...(RECORDS_BY_TABLE_ID.get(tableId) ?? [])] : [];
}

function table(id: MemoryTableId, key: string, name: string, enabled: boolean): MemoryTable {
  return {
    id,
    memorySpaceId: SPACE_ID,
    key: key as MemoryTableKey,
    kind: "custom",
    name,
    description: "",
    prompt: "",
    enabled,
    displayStrategy: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function field(
  id: MemoryFieldId,
  key: string,
  name: string,
  type: MemoryField["type"],
  options: {
    readonly required?: boolean;
    readonly enabled?: boolean;
    readonly options?: readonly string[];
    readonly referenceTableId?: MemoryTableId;
  } = {},
  tableId: MemoryTableId = TABLE_CHARACTERS,
  position: number = 0,
): MemoryField {
  return {
    id,
    memorySpaceId: SPACE_ID,
    tableId,
    key: key as MemoryFieldKey,
    name,
    type,
    required: options.required ?? false,
    prompt: "",
    enabled: options.enabled ?? true,
    position,
    options: options.options ?? [],
    referenceTableId: options.referenceTableId ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function record(
  id: string,
  displayText: string,
  tableId: MemoryTableId,
  payload: Record<string, MemoryFieldValue>,
): MemoryRecord {
  return {
    id: id as MemoryRecordId,
    memorySpaceId: SPACE_ID,
    tableId,
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
