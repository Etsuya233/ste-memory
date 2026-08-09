/**
 * 记录创建/编辑表单（ticket 11）的纯逻辑 seam：草稿构造 / 逐类型前置校验 /
 * 草稿→payload 转换 / 编辑补丁差异。校验规则与 core
 * validatedMemoryRecordPayload / validateMemoryFieldValue 同语义（core 抛错式
 * API 无法直接复用，UI 侧需要逐字段即时文案，双保险——core 仍经 service 调用
 * 兜底，错误 humanMsg 走 toastr）。
 */
import type {
  MemoryField,
  MemoryFieldValue,
  MemoryRecord,
  MemoryRecordPayload,
} from "@ste-memory/core/memory";

/** 表单值：文本/数字/日期/下拉/引用用字符串，布尔用布尔，列表类用数组 */
export type RecordFormValue = string | boolean | readonly string[];

export interface RecordFormDraft {
  readonly values: Readonly<Record<string, RecordFormValue>>;
}

/** 表单值展示文本（停用字段只读行用；null/undefined/空串/空数组 → —） */
export function formDisplayValueText(value: RecordFormValue | undefined): string {
  if (Array.isArray(value)) return value.length > 0 ? value.join("、") : "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string" && value.length === 0) return "—";
  return String(value ?? "—");
}

/** 列表值输入（短文本列表）的分隔符：中文/英文逗号、顿号、换行 */
const LIST_SEPARATOR = /[，,、\n]/;

export function splitListText(text: string): readonly string[] {
  return text
    .split(LIST_SEPARATOR)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function joinListText(items: readonly string[]): string {
  return items.join("、");
}

/** 空草稿：可选值一律空（boolean=false，列表类=[]，其余=""） */
export function emptyRecordFormDraft(fields: readonly MemoryField[]): RecordFormDraft {
  const values: Record<string, RecordFormValue> = {};
  for (const field of fields) {
    values[field.id] = formValueForEmpty(field.type);
  }
  return { values };
}

/** 从现有记录 payload 构造草稿（编辑回填；datetime 转 datetime-local 形态） */
export function recordFormDraftFromPayload(
  fields: readonly MemoryField[],
  payload: MemoryRecordPayload,
): RecordFormDraft {
  const values: Record<string, RecordFormValue> = {};
  for (const field of fields) {
    const value = payload[field.id] ?? null;
    values[field.id] = formValueFromPayload(field, value);
  }
  return { values };
}

/** 校验草稿：返回 fieldId → 中文错误文案；空对象 = 通过（语义与 core 一致） */
export function validateRecordFormDraft(
  fields: readonly MemoryField[],
  draft: RecordFormDraft,
): Readonly<Record<string, string>> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const error = validateFieldValue(field, draft.values[field.id]);
    if (error) errors[field.id] = error;
  }
  return errors;
}

/** 草稿 → core payload（调用方须先通过校验；空值按类型落 null/[]） */
export function recordPayloadFromDraft(
  fields: readonly MemoryField[],
  draft: RecordFormDraft,
): MemoryRecordPayload {
  const payload: Record<string, MemoryFieldValue> = {};
  for (const field of fields) {
    payload[field.id] = payloadValueFromForm(field, draft.values[field.id]);
  }
  return payload;
}

export interface RecordFormPatch {
  /** 仅「值有变化」的字段（避免手动编辑覆盖 Agent 记录未改动字段的证据） */
  readonly patch: Readonly<Record<string, unknown>>;
  readonly changed: boolean;
}

/** 编辑补丁：与当前 payload 逐字段比较，只带变化的字段（core update 按 patch 键合并证据） */
export function recordFormPatchFromDraft(
  fields: readonly MemoryField[],
  record: MemoryRecord,
  draft: RecordFormDraft,
): RecordFormPatch {
  const payload = recordPayloadFromDraft(fields, draft);
  const patch: Record<string, unknown> = {};
  for (const field of fields) {
    const left = record.payload[field.id] ?? null;
    const right = payload[field.id] ?? null;
    // datetime 表单只能编辑到分钟精度：未编辑的秒级差异不算变化，避免无关编辑
    // 把存量记录的秒静默清零（草稿回填即截秒，见 formValueFromPayload）
    const comparableLeft = field.type === "datetime" ? normalizeDatetime(left) : left;
    const comparableRight = field.type === "datetime" ? normalizeDatetime(right) : right;
    if (!sameFieldValue(comparableLeft, comparableRight)) {
      patch[field.id] = payload[field.id];
    }
  }
  return { patch, changed: Object.keys(patch).length > 0 };
}

/** datetime 比较归一化：统一到分钟精度（“YYYY-MM-DD HH:mm”） */
function normalizeDatetime(value: MemoryFieldValue): MemoryFieldValue {
  if (typeof value !== "string" || value.length === 0) return value;
  return value.replace("T", " ").slice(0, 16);
}

/** 详情字段值展示文本（null=—、数组=顿号连接、布尔=是/否） */
export function recordFieldValueText(
  field: MemoryField,
  value: MemoryFieldValue | undefined,
): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return value.length > 0 ? value.join("、") : "—";
  return String(value);
}

function formValueForEmpty(type: MemoryField["type"]): RecordFormValue {
  if (type === "boolean") return false;
  if (type === "short_text_list" || type === "multi_select" || type === "multi_reference") {
    return [];
  }
  return "";
}

function formValueFromPayload(field: MemoryField, value: MemoryFieldValue | null): RecordFormValue {
  if (field.type === "boolean") return value === true;
  if (
    field.type === "short_text_list" ||
    field.type === "multi_select" ||
    field.type === "multi_reference"
  ) {
    return Array.isArray(value) ? [...value] : [];
  }
  if (field.type === "datetime" && typeof value === "string" && value.length > 0) {
    // "YYYY-MM-DD HH:mm:ss" → datetime-local 输入 "YYYY-MM-DDTHH:mm"
    return value.replace(" ", "T").slice(0, 16);
  }
  if (value === null || value === undefined) return "";
  return String(value);
}

function validateFieldValue(field: MemoryField, value: RecordFormValue | undefined): string | null {
  const name = `「${field.name}」`;
  switch (field.type) {
    case "short_text":
    case "long_text": {
      const text = typeof value === "string" ? value.trim() : "";
      if (field.required && text.length === 0) return `请填写${name}`;
      return null;
    }
    case "short_text_list": {
      const items = Array.isArray(value) ? value : splitListText(String(value ?? ""));
      if (field.required && items.length === 0) return `请填写${name}`;
      if (new Set(items).size !== items.length) return `${name}的选项不能重复`;
      return null;
    }
    case "integer": {
      if (value === "" || value === undefined) return field.required ? `请填写${name}` : null;
      const parsed = Number(value);
      if (value === null || Number.isNaN(parsed) || !Number.isInteger(parsed)) {
        return `${name}必须是整数`;
      }
      return null;
    }
    case "decimal": {
      if (value === "" || value === undefined) return field.required ? `请填写${name}` : null;
      const parsed = Number(value);
      if (value === null || Number.isNaN(parsed) || !Number.isFinite(parsed)) {
        return `${name}必须是数字`;
      }
      return null;
    }
    case "boolean":
      return null;
    case "date": {
      const text = typeof value === "string" ? value : "";
      if (text.length === 0) return field.required ? `请填写${name}` : null;
      return isDateText(text) ? null : `${name}的日期格式应为 YYYY-MM-DD`;
    }
    case "datetime": {
      const text = typeof value === "string" ? value : "";
      if (text.length === 0) return field.required ? `请填写${name}` : null;
      return isDateTimeText(text) ? null : `${name}的日期时间格式应为 YYYY-MM-DD HH:mm`;
    }
    case "single_select": {
      const text = typeof value === "string" ? value : "";
      if (text.length === 0) return field.required ? `请选择${name}` : null;
      return field.options.includes(text) ? null : `${name}的选项无效`;
    }
    case "multi_select": {
      const items = Array.isArray(value) ? value : [];
      if (field.required && items.length === 0) return `请选择${name}`;
      return items.some((item) => !field.options.includes(item)) ? `${name}包含无效选项` : null;
    }
    case "single_reference": {
      const text = typeof value === "string" ? value : "";
      if (text.length === 0) return field.required ? `请选择${name}` : null;
      return null;
    }
    case "multi_reference": {
      const items = Array.isArray(value) ? value : [];
      if (field.required && items.length === 0) return `请选择${name}`;
      return null;
    }
  }
}

function payloadValueFromForm(
  field: MemoryField,
  value: RecordFormValue | undefined,
): MemoryFieldValue {
  switch (field.type) {
    case "short_text":
    case "long_text": {
      const text = typeof value === "string" ? value : "";
      return text.length === 0 ? null : text;
    }
    case "short_text_list":
      // 草稿值可能是数组（编辑回填）或文本（用户输入），两种都归一为数组
      return Array.isArray(value)
        ? [...value]
        : splitListText(typeof value === "string" ? value : "");
    case "integer": {
      if (value === "" || value === undefined || value === null) return null;
      return Number(value);
    }
    case "decimal": {
      if (value === "" || value === undefined || value === null) return null;
      return Number(value);
    }
    case "boolean":
      return value === true;
    case "date": {
      const text = typeof value === "string" ? value : "";
      return text.length === 0 ? null : text;
    }
    case "datetime": {
      const text = typeof value === "string" ? value.trim() : "";
      if (text.length === 0) return null;
      // datetime-local 输入（YYYY-MM-DDTHH:mm 或带秒）→ 统一契约 YYYY-MM-DD HH:mm:ss
      const normalized = text.replace("T", " ");
      return normalized.length === 16 ? `${normalized}:00` : normalized;
    }
    case "single_select": {
      const text = typeof value === "string" ? value : "";
      return text.length === 0 ? null : text;
    }
    case "multi_select":
      return Array.isArray(value) ? [...value] : [];
    case "single_reference": {
      const text = typeof value === "string" ? value : "";
      return text.length === 0 ? null : text;
    }
    case "multi_reference":
      return Array.isArray(value) ? [...value] : [];
  }
}

function sameFieldValue(left: MemoryFieldValue, right: MemoryFieldValue): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    const a = Array.isArray(left) ? left : [];
    const b = Array.isArray(right) ? right : [];
    return a.length === b.length && a.every((item, index) => item === b[index]);
  }
  return left === right;
}

function isDateText(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value);
}

function isDateTimeText(value: string): boolean {
  // 接受 datetime-local 输入（YYYY-MM-DDTHH:mm 或 YYYY-MM-DDTHH:mm:ss）与统一契约形态
  const normalized = value.replace("T", " ");
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(normalized)) return false;
  if (!isDateText(normalized.slice(0, 10))) return false;
  const [hours = 0, minutes = 0] = normalized.slice(11).split(":").map(Number);
  return hours < 24 && minutes < 60;
}

/** 表单输入的 data-stm-field 后缀（脚本契约用字段 Key，稳定可预测） */
export function recordValueFieldKey(field: MemoryField): string {
  return `record-value-${field.key}`;
}
