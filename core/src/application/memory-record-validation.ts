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

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value);
}

function isDateTime(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    isDate(value.slice(0, 10)) &&
    !Number.isNaN(Date.parse(value))
  );
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
      return value;
    case "short_text_list":
      if (!isDistinctStrings(value) || (field.required && value.length === 0)) invalid(field);
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
