import { DomainError } from "./domain-error.ts";

export type MemorySpaceId = string & { readonly __brand: "MemorySpaceId" };

/**
 * 初始化来源：最近一次创建或应用预设时使用的预设来源快照（spec 表格预设）。
 * 名称是执行当时的快照，来源预设之后被改名或删除不影响展示，也不建立实时关联。
 */
export interface MemorySpaceInitializationSource {
  /** 当时使用预设的稳定 ID（系统自带预设或用户预设） */
  readonly presetId: string;
  /** 当时使用预设的名称快照 */
  readonly presetName: string;
  /** 创建或应用的时间 */
  readonly appliedAt: string;
}

export interface MemorySpace {
  readonly id: MemorySpaceId;
  readonly name: string;
  /** 初始化来源；未记录（升级前创建的空间）为 null */
  readonly initializationSource: MemorySpaceInitializationSource | null;
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
