import type { MemorySpaceId } from "./memory-space.ts";
import type { MemoryTableId } from "./memory-table.ts";
import { DomainError } from "./domain-error.ts";

export type MemoryFieldId = string & { readonly __brand: "MemoryFieldId" };
export type MemoryFieldKey = string & { readonly __brand: "MemoryFieldKey" };
export type MemoryFieldType =
  | "short_text"
  | "long_text"
  | "short_text_list"
  | "integer"
  | "decimal"
  | "boolean"
  | "date"
  | "datetime"
  | "single_select"
  | "multi_select"
  | "single_reference"
  | "multi_reference";

export interface MemoryField {
  readonly id: MemoryFieldId;
  readonly memorySpaceId: MemorySpaceId;
  readonly tableId: MemoryTableId;
  readonly key: MemoryFieldKey;
  readonly name: string;
  readonly type: MemoryFieldType;
  readonly required: boolean;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly position: number;
  readonly options: readonly string[];
  readonly referenceTableId: MemoryTableId | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function memoryFieldKey(value: string): MemoryFieldKey {
  const key = value.trim();
  if (key.length === 0) {
    throw new DomainError({
      type: "memory_field_key_required",
      humanMsg: "字段 Key 不能为空",
    });
  }
  if (key.length > 120) {
    throw new DomainError({
      type: "memory_field_key_too_long",
      param: { maxLength: 120 },
      humanMsg: "字段 Key 不能超过 120 个字符",
    });
  }
  return key as MemoryFieldKey;
}

export interface MemoryFieldConfiguration {
  readonly options: readonly string[];
  readonly referenceTableId: MemoryTableId | null;
}

export function memoryFieldConfiguration(
  type: MemoryFieldType,
  options: readonly string[],
  referenceTableId: MemoryTableId | null,
): MemoryFieldConfiguration {
  const isSelect = type === "single_select" || type === "multi_select";
  const normalizedOptions = isSelect ? options.map((option) => option.trim()) : [];
  if (
    isSelect &&
    (normalizedOptions.length === 0 ||
      normalizedOptions.some((option) => option.length === 0) ||
      new Set(normalizedOptions).size !== normalizedOptions.length)
  ) {
    throw new DomainError({
      type: "memory_field_options_invalid",
      humanMsg: "单选和多选字段需要互不重复的非空固定选项",
    });
  }
  const isReference = type === "single_reference" || type === "multi_reference";
  if (isReference && !referenceTableId) {
    throw new DomainError({
      type: "memory_field_reference_table_invalid",
      humanMsg: "引用字段的目标表必须属于当前记忆空间",
    });
  }
  return {
    options: normalizedOptions,
    referenceTableId: isReference ? referenceTableId : null,
  };
}

export function memoryFieldName(value: string): string {
  const name = value.trim();
  if (name.length === 0) {
    throw new DomainError({
      type: "memory_field_name_required",
      humanMsg: "字段名称不能为空",
    });
  }
  if (name.length > 120) {
    throw new DomainError({
      type: "memory_field_name_too_long",
      param: { maxLength: 120 },
      humanMsg: "字段名称不能超过 120 个字符",
    });
  }
  return name;
}

export function memoryFieldPosition(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new DomainError({
      type: "memory_field_position_invalid",
      humanMsg: "字段顺序必须是大于或等于 0 的整数",
    });
  }
  return value;
}
