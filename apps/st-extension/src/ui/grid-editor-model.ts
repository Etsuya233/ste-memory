/**
 * 记录网格（表格填写视图，ticket 11 改造）的纯逻辑 seam：
 * 列宽（默认值/clamp/持久化）、网格行草稿（从记录构造/空行）、逐行校验、
 * 批量保存计划（新增 create / 改动 update patch）、未保存改动检测。
 *
 * 校验与 patch 语义复用 record-form-model（与 core 同语义的双保险），本模块只
 * 负责「多行」这一层：行集合 → 错误表 / 保存计划。组件只做「状态 → DOM」投影。
 */
import type {
  MemoryField,
  MemoryRecord,
  MemoryRecordId,
  MemoryRecordPayload,
  MemoryTableId,
} from "@ste-memory/core/memory";
import {
  emptyRecordFormDraft,
  formDisplayValueText,
  recordFormDraftFromPayload,
  recordFormPatchFromDraft,
  recordPayloadFromDraft,
  validateRecordFormDraft,
  type RecordFormDraft,
  type RecordFormValue,
} from "./record-form-model.ts";

// ---- 列宽 ----

export interface GridColumnWidths {
  /** 行号列宽（px） */
  readonly rowNumber: number;
  /** 字段列宽（px），key = fieldId；未列出的字段用默认宽 */
  readonly fields: Readonly<Record<string, number>>;
}

/** 行号列默认宽 / 字段列默认宽（紧凑：移动端一屏可见更多列） */
export const GRID_ROW_NUMBER_WIDTH = 48;
export const GRID_FIELD_WIDTH = 120;
/** 列宽可调范围 */
export const GRID_ROW_NUMBER_MIN_WIDTH = 32;
export const GRID_FIELD_MIN_WIDTH = 72;
export const GRID_COLUMN_MAX_WIDTH = 480;

export function defaultGridColumnWidths(_fields: readonly MemoryField[]): GridColumnWidths {
  return { rowNumber: GRID_ROW_NUMBER_WIDTH, fields: {} };
}

/** 列宽 clamp 到可调范围（行号列 / 字段列共用上限） */
export function clampGridWidth(px: number, min: number): number {
  if (!Number.isFinite(px)) return min;
  return Math.min(GRID_COLUMN_MAX_WIDTH, Math.max(min, Math.round(px)));
}

export function gridColumnWidth(fieldId: string, widths: GridColumnWidths): number {
  return widths.fields[fieldId] ?? GRID_FIELD_WIDTH;
}

/** 列宽持久化 key（按表独立记住；表删除后孤儿 key 由浏览器自清，不额外处理） */
export function gridWidthsStorageKey(tableId: MemoryTableId): string {
  return `ste-memory:grid-widths:${tableId}`;
}

export interface GridWidthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): GridWidthStorage | undefined {
  // SSR 冒烟（react-dom/server）无 window：读取失败按默认值处理
  try {
    if (typeof localStorage === "undefined") return undefined;
    return localStorage;
  } catch {
    return undefined;
  }
}

/** 读取持久化列宽：只保留当前仍存在的字段、数值 clamp；损坏数据回退默认 */
export function loadGridColumnWidths(
  fields: readonly MemoryField[],
  tableId: MemoryTableId,
  storage?: GridWidthStorage,
): GridColumnWidths {
  const store = storage ?? defaultStorage();
  if (!store) return defaultGridColumnWidths(fields);
  let raw: unknown;
  try {
    raw = JSON.parse(store.getItem(gridWidthsStorageKey(tableId)) ?? "null");
  } catch {
    return defaultGridColumnWidths(fields);
  }
  if (typeof raw !== "object" || raw === null) return defaultGridColumnWidths(fields);
  const obj = raw as { rowNumber?: unknown; fields?: unknown };
  const fieldsOut: Record<string, number> = {};
  if (typeof obj.fields === "object" && obj.fields !== null) {
    for (const field of fields) {
      const value = (obj.fields as Record<string, unknown>)[field.id];
      if (typeof value === "number")
        fieldsOut[field.id] = clampGridWidth(value, GRID_FIELD_MIN_WIDTH);
    }
  }
  const rowNumber =
    typeof obj.rowNumber === "number"
      ? clampGridWidth(obj.rowNumber, GRID_ROW_NUMBER_MIN_WIDTH)
      : GRID_ROW_NUMBER_WIDTH;
  return { rowNumber, fields: fieldsOut };
}

/** 持久化列宽（无可用存储时 no-op，SSR 安全） */
export function saveGridColumnWidths(
  tableId: MemoryTableId,
  widths: GridColumnWidths,
  storage?: GridWidthStorage,
): void {
  const store = storage ?? defaultStorage();
  if (!store) return;
  try {
    store.setItem(gridWidthsStorageKey(tableId), JSON.stringify(widths));
  } catch {
    // 存储满/隐私模式等写入失败：列宽不持久化不影响填写功能
  }
}

// ---- 行高 ----

/**
 * 行高（px）：默认 ≈3 行文字（60px），拖拽可调范围 [40, 240]。
 * 按行记录（key = 行 key：已有记录 = recordId，新行 = 新行 key），
 * 持久化只保留已有记录的 recordId（新行不落库）。
 */
export const GRID_ROW_HEIGHT = 60;
export const GRID_ROW_MIN_HEIGHT = 40;
export const GRID_ROW_MAX_HEIGHT = 240;

/** 查看模式文本行高（px）：style.css `.stm-grid-view-text` 13px 字号 × 1.5 行高 */
export const GRID_VIEW_LINE_HEIGHT = 19.5;

/**
 * 查看模式可容纳的文本行数：按行高计算（最少 1 行、无上限）。
 * 默认行高 60px ≈ 3 行；拖高行后按实际可容纳的整行数显示更多文字
 * （grid-editor 以行内 -webkit-line-clamp 应用，见 style.css）。
 */
export function gridViewLineCount(rowHeight: number): number {
  if (!Number.isFinite(rowHeight)) return 1;
  return Math.max(1, Math.floor(rowHeight / GRID_VIEW_LINE_HEIGHT));
}

export type GridRowHeights = Readonly<Record<string, number>>;

/** 行高 clamp 到可调范围并取整 */
export function clampGridRowHeight(px: number): number {
  if (!Number.isFinite(px)) return GRID_ROW_MIN_HEIGHT;
  return Math.min(GRID_ROW_MAX_HEIGHT, Math.max(GRID_ROW_MIN_HEIGHT, Math.round(px)));
}

/** 行高（未列出的行用默认） */
export function gridRowHeight(rowKey: string, heights: GridRowHeights): number {
  return heights[rowKey] ?? GRID_ROW_HEIGHT;
}

/** 行高持久化 key（按表独立记住；孤儿 key 由浏览器自清，不额外处理） */
export function gridHeightsStorageKey(tableId: MemoryTableId): string {
  return `ste-memory:grid-heights:${tableId}`;
}

/** 读取持久化行高：只保留当前仍存在的记录行、数值 clamp；损坏数据回退空表 */
export function loadGridRowHeights(
  records: readonly MemoryRecord[],
  tableId: MemoryTableId,
  storage?: GridWidthStorage,
): GridRowHeights {
  const store = storage ?? defaultStorage();
  if (!store) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(store.getItem(gridHeightsStorageKey(tableId)) ?? "null");
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const heights: Record<string, number> = {};
  for (const record of records) {
    const value = (raw as Record<string, unknown>)[record.id];
    if (typeof value === "number") {
      heights[record.id] = clampGridRowHeight(value);
    }
  }
  return heights;
}

/** 持久化行高（无可用存储时 no-op，SSR 安全；调用方应只传 recordId 键） */
export function saveGridRowHeights(
  tableId: MemoryTableId,
  heights: GridRowHeights,
  storage?: GridWidthStorage,
): void {
  const store = storage ?? defaultStorage();
  if (!store) return;
  try {
    store.setItem(gridHeightsStorageKey(tableId), JSON.stringify(heights));
  } catch {
    // 存储满/隐私模式等写入失败：行高不持久化不影响填写功能
  }
}

// ---- 网格行草稿 ----

export interface GridRowState {
  /** 行唯一 key（已有记录 = recordId；新行 = "new-<n>"） */
  readonly key: string;
  /** 已有记录的 id；null = 新行 */
  readonly recordId: MemoryRecordId | null;
  readonly draft: RecordFormDraft;
}

/** 从记录列表构造网格行（编辑回填语义与 recordFormDraftFromPayload 一致） */
export function gridRowsFromRecords(
  fields: readonly MemoryField[],
  records: readonly MemoryRecord[],
): GridRowState[] {
  return records.map((record) => ({
    key: record.id,
    recordId: record.id,
    draft: recordFormDraftFromPayload(fields, record.payload),
  }));
}

/** 空行（新记录草稿） */
export function emptyGridRow(fields: readonly MemoryField[], key: string): GridRowState {
  return { key, recordId: null, draft: emptyRecordFormDraft(fields) };
}

/** 行值是否全空（新行未填任何值 → 保存时跳过） */
export function gridRowIsEmpty(fields: readonly MemoryField[], row: GridRowState): boolean {
  return fields.every((field) => {
    const value = row.draft.values[field.id];
    if (value === undefined || value === "" || value === false) return true;
    return Array.isArray(value) && value.length === 0;
  });
}

/** 校验全部行：rowKey → fieldId → 错误文案（空对象 = 该行通过） */
export type GridRowErrors = Readonly<Record<string, Readonly<Record<string, string>>>>;

export function validateGridRows(
  fields: readonly MemoryField[],
  rows: readonly GridRowState[],
): GridRowErrors {
  const errors: Record<string, Readonly<Record<string, string>>> = {};
  for (const row of rows) {
    const rowErrors = validateRecordFormDraft(fields, row.draft);
    if (Object.keys(rowErrors).length > 0) errors[row.key] = rowErrors;
  }
  return errors;
}

/** 单行是否脏（新行：填了值即脏；已有行：草稿与当前记录有差异；缺原记录视为不脏） */
export function gridRowIsDirty(
  fields: readonly MemoryField[],
  row: GridRowState,
  originals: ReadonlyMap<MemoryRecordId, MemoryRecord>,
): boolean {
  if (row.recordId === null) return !gridRowIsEmpty(fields, row);
  const original = originals.get(row.recordId);
  if (!original) return false;
  return recordFormPatchFromDraft(fields, original, row.draft).changed;
}

/** 是否存在未保存改动（新行填了值 / 已有行补丁有变化；originals 缺行的记录视为无改动） */
export function hasUnsavedGridChanges(
  fields: readonly MemoryField[],
  rows: readonly GridRowState[],
  originals: ReadonlyMap<MemoryRecordId, MemoryRecord>,
): boolean {
  return rows.some((row) => gridRowIsDirty(fields, row, originals));
}

/**
 * 查看模式单元格文本：引用字段解析为目标记录显示文本（未知 id 显示原 id），
 * 空值统一「未填写」占位；其余类型复用 formDisplayValueText 语义（顿号/是否）。
 */
export function gridDisplayValueText(
  field: MemoryField,
  value: RecordFormValue | undefined,
  referenceLabels: ReadonlyMap<string, string>,
): string {
  if (field.type === "single_reference") {
    const id = typeof value === "string" ? value : "";
    if (id.length === 0) return "未填写";
    return referenceLabels.get(id) ?? id;
  }
  if (field.type === "multi_reference") {
    const ids = Array.isArray(value) ? value : [];
    if (ids.length === 0) return "未填写";
    return ids.map((id) => referenceLabels.get(id) ?? id).join("、");
  }
  const text = formDisplayValueText(value);
  return text === "—" ? "未填写" : text;
}

/** 引用字段选项标签：跨表收集目标记录 id → 显示文本（读时计算，防策略变更后过期） */
export function buildReferenceLabelMap(
  referenceRecords: ReadonlyMap<MemoryTableId, readonly MemoryRecord[]>,
): ReadonlyMap<MemoryRecordId, string> {
  const labels = new Map<MemoryRecordId, string>();
  for (const records of referenceRecords.values()) {
    for (const record of records) {
      labels.set(record.id, record.displayText);
    }
  }
  return labels;
}

/** 行底错误条文案：提交错误置顶，校验错误按字段顺序逐行（文案已含字段名） */
export function gridRowErrorLines(
  fieldErrors: Readonly<Record<string, string>> | undefined,
  commitError: string | undefined,
  fields: readonly MemoryField[],
): readonly string[] {
  const lines: string[] = [];
  if (commitError) lines.push(commitError);
  if (fieldErrors) {
    for (const field of fields) {
      const message = fieldErrors[field.id];
      if (message) lines.push(message);
    }
  }
  return lines;
}

// ---- 批量保存计划 ----

export interface GridSaveCreate {
  /** 网格行 key（部分失败时就地重建该行用） */
  readonly rowKey: string;
  readonly payload: MemoryRecordPayload;
}

export interface GridSaveUpdate {
  /** 网格行 key（部分失败时就地重建该行用） */
  readonly rowKey: string;
  readonly recordId: MemoryRecordId;
  readonly expectedRevisionId: MemoryRecord["revisionId"];
  readonly patch: Readonly<Record<string, unknown>>;
}

export interface GridSavePlan {
  readonly creates: readonly GridSaveCreate[];
  readonly updates: readonly GridSaveUpdate[];
  readonly changed: boolean;
}

/**
 * 批量保存计划：新行填了值 → create（全空新行跳过）；已有行补丁有变化 →
 * update（expectedRevisionId 取当前记录，保证乐观并发校验）。originals 缺行的
 * 记录（期间被删）跳过更新，由 core 刷新兜底。
 */
export function planGridSave(
  fields: readonly MemoryField[],
  rows: readonly GridRowState[],
  originals: ReadonlyMap<MemoryRecordId, MemoryRecord>,
): GridSavePlan {
  const creates: GridSaveCreate[] = [];
  const updates: GridSaveUpdate[] = [];
  for (const row of rows) {
    if (row.recordId === null) {
      if (!gridRowIsEmpty(fields, row)) {
        creates.push({ rowKey: row.key, payload: recordPayloadFromDraft(fields, row.draft) });
      }
      continue;
    }
    const original = originals.get(row.recordId);
    if (!original) continue;
    const patch = recordFormPatchFromDraft(fields, original, row.draft);
    if (patch.changed) {
      updates.push({
        rowKey: row.key,
        recordId: row.recordId,
        expectedRevisionId: original.revisionId,
        patch: patch.patch,
      });
    }
  }
  return { creates, updates, changed: creates.length > 0 || updates.length > 0 };
}
