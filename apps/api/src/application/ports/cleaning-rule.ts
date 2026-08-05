import type { MemorySpaceId } from "@ste-memory/core/memory";

/** 清洗规则模式：保留 = 只留匹配段；去掉 = 删除匹配段。 */
export const CLEANING_RULE_MODES = ["keep", "discard"] as const;
export type CleaningRuleMode = (typeof CLEANING_RULE_MODES)[number];

/** 允许的正则 flags（与 SillyTavern 对齐，默认 g 且允许取消勾选）。 */
export const CLEANING_RULE_FLAGS = ["g", "i", "m", "s", "u", "y"] as const;

export interface CleaningRule {
  readonly id: string;
  readonly memorySpaceId: MemorySpaceId;
  /** 执行顺序（0 起，按升序执行；上一条输出是下一条输入）。 */
  readonly position: number;
  readonly enabled: boolean;
  readonly name: string;
  readonly mode: CleaningRuleMode;
  readonly pattern: string;
  /** 组合后的 flags 字符串，如 "g" / "gi"。 */
  readonly flags: string;
}

export interface CleaningRuleInput {
  readonly name: string;
  readonly mode: CleaningRuleMode;
  readonly pattern: string;
  readonly flags: string;
  /** 创建时可选（默认 true）；更新时由仓库端合并当前值。 */
  readonly enabled?: boolean;
}

export interface CleaningRuleRepository {
  list(memorySpaceId: MemorySpaceId): Promise<readonly CleaningRule[]>;
  find(memorySpaceId: MemorySpaceId, ruleId: string): Promise<CleaningRule | undefined>;
  /** 追加到列表末尾（position = 当前最大 position + 1）。 */
  create(memorySpaceId: MemorySpaceId, input: CleaningRuleInput): Promise<CleaningRule>;
  update(
    memorySpaceId: MemorySpaceId,
    ruleId: string,
    patch: Partial<CleaningRuleInput> & { readonly enabled?: boolean },
  ): Promise<CleaningRule | undefined>;
  remove(memorySpaceId: MemorySpaceId, ruleId: string): Promise<boolean>;
  /** 按给定 id 顺序重排（position = 数组下标）；返回重排后的完整列表。 */
  reorder(
    memorySpaceId: MemorySpaceId,
    ruleIds: readonly string[],
  ): Promise<readonly CleaningRule[] | undefined>;
}

export interface CleaningRuleManager {
  list(memorySpaceId: MemorySpaceId): Promise<readonly CleaningRule[] | undefined>;
  create(memorySpaceId: MemorySpaceId, input: CleaningRuleInput): Promise<CleaningRule | undefined>;
  update(
    memorySpaceId: MemorySpaceId,
    ruleId: string,
    patch: Partial<CleaningRuleInput> & { readonly enabled?: boolean },
  ): Promise<CleaningRule | undefined>;
  remove(memorySpaceId: MemorySpaceId, ruleId: string): Promise<boolean>;
  reorder(
    memorySpaceId: MemorySpaceId,
    ruleIds: readonly string[],
  ): Promise<readonly CleaningRule[] | undefined>;
}
