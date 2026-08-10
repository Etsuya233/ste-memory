import { describe, expect, it } from "vitest";
import type {
  MemoryField,
  MemoryRecord,
  MemoryRecordId,
  MemoryTableId,
} from "@ste-memory/core/memory";
import {
  clampGridWidth,
  defaultGridColumnWidths,
  emptyGridRow,
  GRID_COLUMN_MAX_WIDTH,
  GRID_FIELD_MIN_WIDTH,
  GRID_FIELD_WIDTH,
  GRID_ROW_NUMBER_MIN_WIDTH,
  GRID_ROW_NUMBER_WIDTH,
  gridColumnWidth,
  gridRowIsEmpty,
  gridRowsFromRecords,
  gridWidthsStorageKey,
  hasUnsavedGridChanges,
  loadGridColumnWidths,
  planGridSave,
  saveGridColumnWidths,
  validateGridRows,
  type GridRowState,
  type GridWidthStorage,
} from "./grid-editor-model.ts";
import type { RecordFormValue } from "./record-form-model.ts";

const TABLE_ID = "table-1" as MemoryTableId;

function field(
  overrides: Partial<Omit<MemoryField, "id" | "key">> & { readonly key?: string },
): MemoryField {
  return {
    id: `field-${overrides.key ?? "x"}` as MemoryField["id"],
    memorySpaceId: "space-1" as MemoryField["memorySpaceId"],
    tableId: TABLE_ID,
    key: (overrides.key ?? "name") as MemoryField["key"],
    name: "名称",
    type: "short_text",
    required: false,
    prompt: "",
    enabled: true,
    position: 0,
    options: [],
    referenceTableId: null,
    maxChars: null,
    valuePattern: null,
    valuePatternMessage: null,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    // spread 用 object 类型：避免 TS2783（展开类型与显式字段重叠警告），
    // 运行时仍正常覆盖；id/key 已在上面固定（测试不传 id）
    ...(overrides as object),
  };
}

const fields: readonly MemoryField[] = [
  field({ key: "name", name: "名字", required: true }),
  field({ key: "count", name: "数量", type: "integer" }),
  field({ key: "tags", name: "标签", type: "short_text_list" }),
];

function record(
  overrides: Partial<Omit<MemoryRecord, "id" | "revisionId">> & {
    readonly id?: string;
    readonly revisionId?: string;
  } = {},
): MemoryRecord {
  return {
    id: (overrides.id ?? "record-1") as MemoryRecord["id"],
    memorySpaceId: "space-1" as MemoryRecord["memorySpaceId"],
    tableId: TABLE_ID,
    payload: {},
    fieldEvidence: {},
    displayText: "显示文本",
    source: { type: "manual" },
    revisionId: (overrides.revisionId ?? "rev-1") as MemoryRecord["revisionId"],
    revisionSource: "user",
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    // spread 用 object 类型：避免 TS2783（同 field helper）
    ...(overrides as object),
  };
}

const nameId = fields[0]!.id;
const countId = fields[1]!.id;
const tagsId = fields[2]!.id;

/** 复制行并写入一个值（values 是 Readonly，测试用新对象模拟输入） */
function withValue(row: GridRowState, fieldId: string, value: RecordFormValue): GridRowState {
  return {
    ...row,
    draft: {
      ...row.draft,
      values: { ...row.draft.values, [fieldId]: value },
    },
  };
}


describe("列宽：默认 / clamp / 读取", () => {
  it("默认宽度：行号列 48、字段未列出时用 168", () => {
    const widths = defaultGridColumnWidths(fields);
    expect(widths.rowNumber).toBe(GRID_ROW_NUMBER_WIDTH);
    expect(gridColumnWidth(fields[0]!.id, widths)).toBe(GRID_FIELD_WIDTH);
  });

  it("clamp 到 [min, 480] 并取整", () => {
    expect(clampGridWidth(10, GRID_FIELD_MIN_WIDTH)).toBe(GRID_FIELD_MIN_WIDTH);
    expect(clampGridWidth(200.4, GRID_FIELD_MIN_WIDTH)).toBe(200);
    expect(clampGridWidth(9999, GRID_FIELD_MIN_WIDTH)).toBe(GRID_COLUMN_MAX_WIDTH);
    expect(clampGridWidth(Number.NaN, GRID_FIELD_MIN_WIDTH)).toBe(GRID_FIELD_MIN_WIDTH);
  });

  it("存储 key 按表独立", () => {
    expect(gridWidthsStorageKey(TABLE_ID)).toBe(
      "ste-memory:grid-widths:table-1",
    );
  });
});

function memoryStorage(initial: Record<string, string> = {}): GridWidthStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  };
}

describe("列宽：持久化", () => {
  it("无存储（SSR）→ 默认宽度", () => {
    expect(loadGridColumnWidths(fields, TABLE_ID)).toEqual(defaultGridColumnWidths(fields));
  });

  it("损坏 JSON / 非对象 → 默认宽度", () => {
    const storage = memoryStorage({ [gridWidthsStorageKey(TABLE_ID)]: "{oops" });
    expect(loadGridColumnWidths(fields, TABLE_ID, storage)).toEqual(
      defaultGridColumnWidths(fields),
    );
  });

  it("读取合并：只保留仍存在的字段、数值 clamp、缺失字段用默认宽", () => {
    const storage = memoryStorage({
      [gridWidthsStorageKey(TABLE_ID)]: JSON.stringify({
        rowNumber: 10,
        fields: { [nameId]: 300, [countId]: "bad", ghost: 200 },
      }),
    });
    const widths = loadGridColumnWidths(fields, TABLE_ID, storage);
    expect(widths.rowNumber).toBe(GRID_ROW_NUMBER_MIN_WIDTH); // 10 → clamp 36
    expect(widths.fields[nameId]).toBe(300);
    expect(widths.fields[countId]).toBeUndefined(); // 非法值丢弃 → 默认宽
    expect(widths.fields.ghost).toBeUndefined(); // 已删除字段丢弃
    expect(gridColumnWidth(tagsId, widths)).toBe(GRID_FIELD_WIDTH); // 未持久化 → 默认宽
  });

  it("保存 → 读取 roundtrip", () => {
    const storage = memoryStorage();
    saveGridColumnWidths(TABLE_ID, { rowNumber: 64, fields: { [nameId]: 220 } }, storage);
    const widths = loadGridColumnWidths(fields, TABLE_ID, storage);
    expect(widths).toEqual({ rowNumber: 64, fields: { [nameId]: 220 } });
  });
});

describe("网格行草稿", () => {
  it("从记录构造：payload 回填草稿（datetime 截秒语义走 record-form-model）", () => {
    const rows = gridRowsFromRecords(fields, [
      record({ id: "r1", payload: { [nameId]: "阿尔法", [countId]: 3, [tagsId]: ["a", "b"] } }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("r1");
    expect(rows[0]!.recordId).toBe("r1");
    expect(rows[0]!.draft.values[nameId]).toBe("阿尔法");
    expect(rows[0]!.draft.values[countId]).toBe("3");
    expect(rows[0]!.draft.values[tagsId]).toEqual(["a", "b"]);
  });

  it("空行：可选值空（boolean=false、列表=[]、其余=空串）", () => {
    const row = emptyGridRow(fields, "new-1");
    expect(row.recordId).toBeNull();
    expect(row.draft.values[nameId]).toBe("");
    expect(row.draft.values[countId]).toBe("");
    expect(row.draft.values[tagsId]).toEqual([]);
  });

  it("gridRowIsEmpty：全空为真，任一字段有值即假", () => {
    expect(gridRowIsEmpty(fields, emptyGridRow(fields, "new-1"))).toBe(true);
    const filled = withValue(emptyGridRow(fields, "new-2"), nameId, "x");
    expect(gridRowIsEmpty(fields, filled)).toBe(false);
  });
});

describe("逐行校验", () => {
  it("必填缺失 → 行级错误表；通过 → 空对象", () => {
    const empty = emptyGridRow(fields, "new-1");
    const errors = validateGridRows(fields, [empty]);
    expect(errors["new-1"]?.[nameId]).toContain("请填写");
    expect(errors["new-1"]?.[countId]).toBeUndefined();

    expect(validateGridRows(fields, [withValue(empty, nameId, "阿尔法")])).toEqual({});
  });

  it("多行独立报错，key 隔离", () => {
    const rows = [
      emptyGridRow(fields, "a"),
      withValue(emptyGridRow(fields, "b"), nameId, "已填"),
    ];
    const errors = validateGridRows(fields, rows);
    expect(errors.a?.[nameId]).toBeDefined();
    expect(errors.b).toBeUndefined();
  });
});

describe("未保存改动检测", () => {
  it("新行填了值 → true；全空新行 → false", () => {
    const emptyRow = emptyGridRow(fields, "new-1");
    expect(hasUnsavedGridChanges(fields, [emptyRow], new Map())).toBe(false);
    expect(hasUnsavedGridChanges(fields, [withValue(emptyRow, nameId, "x")], new Map())).toBe(true);
  });

  it("已有行值变化 → true；未动 → false", () => {
    const original = record({ id: "r1", payload: { [nameId]: "阿尔法" } });
    const row: GridRowState = {
      key: "r1",
      recordId: "r1" as MemoryRecordId,
      draft: { values: { [nameId]: "阿尔法", [countId]: "", [tagsId]: [] } },
    };
    const originals = new Map<MemoryRecordId, MemoryRecord>([[original.id, original]]);
    expect(hasUnsavedGridChanges(fields, [row], originals)).toBe(false);
    expect(hasUnsavedGridChanges(fields, [withValue(row, nameId, "贝塔")], originals)).toBe(true);
  });

  it("originals 缺行的记录（期间被删）→ 视为无改动", () => {
    const row: GridRowState = {
      key: "r1",
      recordId: "r1" as MemoryRecordId,
      draft: { values: { [nameId]: "x" } },
    };
    expect(hasUnsavedGridChanges(fields, [row], new Map())).toBe(false);
  });
});

describe("批量保存计划", () => {
  it("全空新行跳过；填了值的新行 create", () => {
    const rows = [
      emptyGridRow(fields, "new-1"),
      emptyGridRow(fields, "new-2"),
      emptyGridRow(fields, "new-3"),
    ];
    rows[2] = withValue(rows[2]!, nameId, "伽马");
    rows[2] = withValue(rows[2]!, countId, "7");
    const plan = planGridSave(fields, rows, new Map());
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]).toEqual({ [nameId]: "伽马", [countId]: 7, [tagsId]: [] });
    expect(plan.updates).toHaveLength(0);
    expect(plan.changed).toBe(true);
  });

  it("已有行补丁变化 → update（带 expectedRevisionId）；未动 → 不进计划", () => {
    const original = record({
      id: "r1",
      revisionId: "rev-9",
      payload: { [nameId]: "阿尔法", [countId]: 3, [tagsId]: ["a"] },
    });
    const rows: GridRowState[] = [
      {
        key: "r1",
        recordId: "r1" as MemoryRecordId,
        draft: {
          values: { [nameId]: "阿尔法", [countId]: "5", [tagsId]: ["a", "b"] },
        },
      },
      {
        key: "r2",
        recordId: "r2" as MemoryRecordId,
        draft: { values: { [nameId]: "原样", [countId]: "1", [tagsId]: [] } },
      },
    ];
    const originals = new Map<MemoryRecordId, MemoryRecord>([
      [original.id, original],
      [
        "r2" as MemoryRecordId,
        record({ id: "r2", revisionId: "rev-8", payload: { [nameId]: "原样", [countId]: 1 } }),
      ],
    ]);
    const plan = planGridSave(fields, rows, originals);
    expect(plan.creates).toHaveLength(0);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]).toEqual({
      recordId: "r1" as MemoryRecordId,
      expectedRevisionId: "rev-9",
      patch: { [countId]: 5, [tagsId]: ["a", "b"] },
    });
    expect(plan.changed).toBe(true);
  });

  it("无任何变化 → changed=false", () => {
    const original = record({ id: "r1", payload: { [nameId]: "阿尔法" } });
    const rows: GridRowState[] = [
      {
        key: "r1",
        recordId: "r1" as MemoryRecordId,
        draft: { values: { [nameId]: "阿尔法", [countId]: "", [tagsId]: [] } },
      },
      emptyGridRow(fields, "new-1"),
    ];
    const plan = planGridSave(fields, rows, new Map<MemoryRecordId, MemoryRecord>([["r1" as MemoryRecordId, original]]));
    expect(plan.changed).toBe(false);
    expect(plan.creates).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
  });

  it("originals 缺行的已有行（期间被删）跳过更新", () => {
    const rows: GridRowState[] = [
      {
        key: "r1",
        recordId: "r1" as MemoryRecordId,
        draft: { values: { [nameId]: "改过" } },
      },
    ];
    const plan = planGridSave(fields, rows, new Map());
    expect(plan.changed).toBe(false);
  });
});
