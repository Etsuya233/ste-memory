import {
  DomainError,
  type MemoryField,
  type MemoryFieldValue,
  type MemoryRecordPayload,
} from "../domain/index.ts";

function invalid(field: MemoryField): never {
  throw new DomainError({
    type: "memory_record_field_value_invalid",
    param: { fieldId: field.id },
    humanMsg: `字段“${field.name}”的值不符合 ${field.type} 类型`,
  });
}

function tooLong(field: MemoryField, maxChars: number, valueLength: number): never {
  throw new DomainError({
    type: "memory_record_field_value_too_long",
    param: { fieldId: field.id, maxChars, actualLength: valueLength },
    humanMsg: `字段“${field.name}”的值长度 ${valueLength} 超过上限 ${maxChars} 字；请压缩、合并或删除旧内容后再提交`,
  });
}

function patternMismatch(field: MemoryField, value: string): never {
  const snippet = value.length > 40 ? `${value.slice(0, 40)}…` : value;
  const guidance = field.valuePatternMessage
    ? field.valuePatternMessage
    : `必须匹配格式 ${field.valuePattern}`;
  throw new DomainError({
    type: "memory_record_field_value_pattern_mismatch",
    param: { fieldId: field.id },
    humanMsg: `字段“${field.name}”的值「${snippet}」不符合格式要求：${guidance}；请修正后重新提交`,
  });
}

/** 对字符串或字符串数组的每个非空元素执行检查（字符串与数组两条校验路径共用）。 */
function visitStrings(value: unknown, check: (item: string) => void): void {
  if (typeof value === "string") {
    if (value.length > 0) check(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.length > 0) check(item);
    }
  }
}

/** 文本类字段长度校验：有 maxChars 上限时对字符串（含数组元素）逐项检查。 */
function checkLength(field: MemoryField, value: unknown): void {
  if (field.maxChars === null) return;
  const maxChars = field.maxChars;
  visitStrings(value, (item) => {
    if (item.length > maxChars) tooLong(field, maxChars, item.length);
  });
}

/** 文本类字段格式校验：有 valuePattern 时非空字符串（含数组元素）必须匹配。 */
function checkPattern(field: MemoryField, value: unknown): void {
  if (field.valuePattern === null) return;
  const pattern = new RegExp(field.valuePattern);
  visitStrings(value, (item) => {
    if (!pattern.test(item)) patternMismatch(field, item);
  });
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value);
}

function isDateTime(value: string): boolean {
  // 统一契约：YYYY-MM-DD HH:mm:ss（无时区、固定宽度，字典序比较即时间序比较）
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return false;
  if (!isDate(value.slice(0, 10))) return false;
  const [hours = 0, minutes = 0, seconds = 0] = value.slice(11).split(":").map(Number);
  return hours < 24 && minutes < 60 && seconds < 60;
}

function isDistinctStrings(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string") &&
    new Set(value).size === value.length
  );
}

export function validateMemoryFieldValue(field: MemoryField, value: unknown): MemoryFieldValue {
  if (value === null) {
    if (field.required) invalid(field);
    return null;
  }
  switch (field.type) {
    case "short_text":
    case "long_text":
      if (typeof value !== "string" || (field.required && value.trim().length === 0))
        invalid(field);
      checkLength(field, value);
      checkPattern(field, value);
      return value;
    case "short_text_list":
      if (!isDistinctStrings(value) || (field.required && value.length === 0)) invalid(field);
      checkLength(field, value);
      checkPattern(field, value);
      return value;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) invalid(field);
      return value;
    case "decimal":
      if (typeof value !== "number" || !Number.isFinite(value)) invalid(field);
      return value;
    case "boolean":
      if (typeof value !== "boolean") invalid(field);
      return value;
    case "date":
      if (typeof value !== "string" || !isDate(value)) invalid(field);
      return value;
    case "datetime":
      if (typeof value !== "string" || !isDateTime(value)) invalid(field);
      return value;
    case "single_select":
      if (typeof value !== "string" || !field.options.includes(value)) invalid(field);
      return value;
    case "multi_select":
      if (
        !isDistinctStrings(value) ||
        (field.required && value.length === 0) ||
        value.some((item) => !field.options.includes(item))
      ) {
        invalid(field);
      }
      return value;
    case "single_reference":
      if (typeof value !== "string" || value.length === 0) invalid(field);
      return value;
    case "multi_reference":
      if (
        !isDistinctStrings(value) ||
        (field.required && value.length === 0) ||
        value.some((item) => item.length === 0)
      ) {
        invalid(field);
      }
      return value;
  }
}

export function validatedMemoryRecordPayload(
  fields: readonly MemoryField[],
  input: Readonly<Record<string, unknown>>,
): MemoryRecordPayload {
  const fieldsById = new Map(fields.map((field) => [field.id as string, field]));
  const unknownFieldId = Object.keys(input).find((fieldId) => !fieldsById.has(fieldId));
  if (unknownFieldId) {
    throw new DomainError({
      type: "memory_record_unknown_field",
      param: { fieldId: unknownFieldId },
      humanMsg: "记录包含不属于当前表格的字段",
    });
  }
  const missing = fields.find(
    (field) => field.required && (input[field.id] === undefined || input[field.id] === null),
  );
  if (missing) {
    throw new DomainError({
      type: "memory_record_required_field_missing",
      param: { fieldId: missing.id },
      humanMsg: `必填字段“${missing.name}”不能为空`,
    });
  }
  return Object.fromEntries(
    Object.entries(input).map(([fieldId, value]) => [
      fieldId,
      validateMemoryFieldValue(fieldsById.get(fieldId)!, value),
    ]),
  );
}
