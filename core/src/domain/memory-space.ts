import { DomainError } from "./domain-error.ts";

export type MemorySpaceId = string & { readonly __brand: "MemorySpaceId" };

export interface MemorySpace {
  readonly id: MemorySpaceId;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function memorySpaceName(value: string): string {
  const name = value.trim();
  if (name.length === 0) {
    throw new DomainError({
      type: "memory_space_name_required",
      humanMsg: "记忆空间名称不能为空",
    });
  }
  if (name.length > 120) {
    throw new DomainError({
      type: "memory_space_name_too_long",
      param: { maxLength: 120 },
      humanMsg: "记忆空间名称不能超过 120 个字符",
    });
  }
  return name;
}
