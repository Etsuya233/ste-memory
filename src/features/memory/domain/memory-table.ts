import { DomainError } from "./domain-error.ts";
import type { MemorySpaceId } from "./memory-space.ts";
import type { MemoryFieldId } from "./memory-field.ts";

export type MemoryTableId = string & { readonly __brand: "MemoryTableId" };
export type MemoryTableKey = string & { readonly __brand: "MemoryTableKey" };
export type MemoryTableKind = "custom" | "system";
export type MemoryTableDisplayStrategy =
  | { readonly type: "field"; readonly fieldId: MemoryFieldId }
  | { readonly type: "template"; readonly template: string };

export interface DerivedDisplayTemplate {
  readonly template: string;
  readonly fieldIds: readonly MemoryFieldId[];
}

export function derivedDisplayTemplate(value: string): DerivedDisplayTemplate {
  const fieldIds = [...value.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1] as MemoryFieldId);
  if (fieldIds.length === 0) {
    throw new DomainError({
      type: "memory_table_display_strategy_invalid",
      humanMsg: "显示模板只能引用当前表中的字段",
    });
  }
  return { template: value, fieldIds };
}

export function memoryTableDisplayFieldIds(
  strategy: MemoryTableDisplayStrategy,
): readonly MemoryFieldId[] {
  return strategy.type === "field"
    ? [strategy.fieldId]
    : derivedDisplayTemplate(strategy.template).fieldIds;
}

/**
 * 按字段 ID 映射表重映射显示策略（克隆/导入时字段重生成全新 ID，策略必须跟着映射，
 * 否则策略会指向不存在的旧字段——field 策略显示为空、template 策略渲染崩溃）。
 * 映射表中不存在的字段 ID 保持原样（不丢信息，渲染层按漂移兜底为空）。
 */
export function remapMemoryTableDisplayStrategy(
  strategy: MemoryTableDisplayStrategy | null,
  fieldIdMap: ReadonlyMap<string, MemoryFieldId>,
): MemoryTableDisplayStrategy | null {
  if (!strategy) return null;
  if (strategy.type === "field") {
    return { type: "field", fieldId: fieldIdMap.get(strategy.fieldId) ?? strategy.fieldId };
  }
  return {
    type: "template",
    template: strategy.template.replace(/\{([^{}]+)\}/g, (placeholder, oldFieldId: string) => {
      const newFieldId = fieldIdMap.get(oldFieldId);
      return newFieldId ? `{${newFieldId}}` : placeholder;
    }),
  };
}

export interface MemoryTable {
  readonly id: MemoryTableId;
  readonly memorySpaceId: MemorySpaceId;
  readonly key: MemoryTableKey;
  readonly kind: MemoryTableKind;
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly displayStrategy: MemoryTableDisplayStrategy | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function memoryTableKey(value: string): MemoryTableKey {
  const key = value.trim();
  if (key.length === 0) {
    throw new DomainError({
      type: "memory_table_key_required",
      humanMsg: "记忆表格 Key 不能为空",
    });
  }
  if (key.length > 120) {
    throw new DomainError({
      type: "memory_table_key_too_long",
      param: { maxLength: 120 },
      humanMsg: "记忆表格 Key 不能超过 120 个字符",
    });
  }
  return key as MemoryTableKey;
}

export function memoryTableName(value: string): string {
  const name = value.trim();
  if (name.length === 0) {
    throw new DomainError({
      type: "memory_table_name_required",
      humanMsg: "记忆表格名称不能为空",
    });
  }
  if (name.length > 120) {
    throw new DomainError({
      type: "memory_table_name_too_long",
      param: { maxLength: 120 },
      humanMsg: "记忆表格名称不能超过 120 个字符",
    });
  }
  return name;
}
