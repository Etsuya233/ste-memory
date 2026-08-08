import type {
  MemoryField,
  MemoryFieldId,
  MemoryFieldType,
  MemoryTable,
  MemoryTableId,
} from "@ste-memory/core/memory";
import { describe, expect, it } from "vitest";
import { FIELD_TYPE_LABELS, buildTableListViewModel } from "./table-list-model.ts";

let tableSeq = 0;
let fieldSeq = 0;

function table(overrides: Record<string, unknown> = {}): MemoryTable {
  return {
    id: `table-${++tableSeq}` as MemoryTableId,
    memorySpaceId: "space-1",
    key: `key-${tableSeq}`,
    kind: "custom",
    name: `表格 ${tableSeq}`,
    description: "",
    prompt: "",
    enabled: true,
    displayStrategy: null,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  } as unknown as MemoryTable;
}

function field(tableId: MemoryTableId, overrides: Record<string, unknown> = {}): MemoryField {
  return {
    id: `field-${++fieldSeq}` as MemoryFieldId,
    memorySpaceId: "space-1",
    tableId,
    key: `key-${fieldSeq}`,
    name: `字段 ${fieldSeq}`,
    type: "short_text",
    required: false,
    prompt: "",
    enabled: true,
    position: fieldSeq,
    options: [],
    referenceTableId: null,
    maxChars: null,
    valuePattern: null,
    valuePatternMessage: null,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  } as unknown as MemoryField;
}

describe("buildTableListViewModel（表格列表视图模型）", () => {
  it("空输入：空列表", () => {
    expect(buildTableListViewModel([], new Map())).toEqual([]);
  });

  it("按表分组字段，统计启用数与类型标签", () => {
    const characters = table({ key: "characters", kind: "system", name: "人物" });
    const locations = table({ key: "locations", kind: "system", name: "地点" });
    const fields = [
      field(characters.id, { key: "name", name: "姓名", type: "short_text", required: true, position: 1 }),
      field(characters.id, { key: "age", name: "年龄", type: "integer", enabled: false, position: 2 }),
      field(locations.id, { key: "where", name: "所在", type: "single_reference", position: 1 }),
    ];
    const model = buildTableListViewModel(
      [characters, locations],
      new Map([
        [characters.id, [fields[0]!, fields[1]!]],
        [locations.id, [fields[2]!]],
      ]),
    );

    expect(model).toHaveLength(2);
    expect(model[0]).toMatchObject({
      id: characters.id,
      key: "characters",
      name: "人物",
      kind: "system",
      enabled: true,
      enabledFieldCount: 1,
    });
    expect(model[0]!.fields.map((f) => f.key)).toEqual(["name", "age"]);
    expect(model[0]!.fields[0]).toMatchObject({
      name: "姓名",
      typeLabel: "短文本",
      required: true,
      enabled: true,
    });
    expect(model[0]!.fields[1]!.typeLabel).toBe("整数");
    expect(model[1]!.fields[0]!.typeLabel).toBe("单引用");
  });

  it("停用表格的 enabled 原样反映", () => {
    const model = buildTableListViewModel([table({ enabled: false })], new Map());
    expect(model[0]!.enabled).toBe(false);
  });

  it("fieldsByTable 缺表的表 = 无字段（防御空映射）", () => {
    const model = buildTableListViewModel([table()], new Map());
    expect(model[0]!.fields).toEqual([]);
    expect(model[0]!.enabledFieldCount).toBe(0);
  });

  it("FIELD_TYPE_LABELS 覆盖全部 12 种字段类型（契约：新增类型必须有显示名）", () => {
    const allTypes: readonly MemoryFieldType[] = [
      "short_text",
      "long_text",
      "short_text_list",
      "integer",
      "decimal",
      "boolean",
      "date",
      "datetime",
      "single_select",
      "multi_select",
      "single_reference",
      "multi_reference",
    ];
    expect(Object.keys(FIELD_TYPE_LABELS).sort()).toEqual([...allTypes].sort());
    for (const type of allTypes) expect(FIELD_TYPE_LABELS[type]).toBeTruthy();
  });
});
