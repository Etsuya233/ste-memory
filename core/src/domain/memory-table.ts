import { DomainError } from "./domain-error.ts";
import type { MemorySpaceId } from "./memory-space.ts";

export type MemoryTableId = string & { readonly __brand: "MemoryTableId" };
export type MemoryTableKind = "custom" | "system";

export interface MemoryTable {
  readonly id: MemoryTableId;
  readonly memorySpaceId: MemorySpaceId;
  readonly kind: MemoryTableKind;
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
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
