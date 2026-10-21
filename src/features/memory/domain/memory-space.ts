import { DomainError } from "./domain-error.ts";

export type MemorySpaceId = string & { readonly __brand: "MemorySpaceId" };

/** 表格预设中的总结归组约定；Key 改名时须同步修改规则。 */
export interface MemorySummaryRule {
  readonly sourceTableKey: string;
  readonly targetTableKey: string;
  readonly referenceFieldKey: string;
  readonly groupSize: number;
  readonly retainCount: number;
  readonly timeRange?: {
    readonly sourceStartFieldKey: string;
    readonly sourceEndFieldKey: string;
    readonly targetStartFieldKey: string;
    readonly targetEndFieldKey: string;
  };
}

export function memorySummaryRules(value: unknown): readonly MemorySummaryRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("总结规则必须是数组");
  const sources = new Set<string>();
  return value.map((rule: unknown) => {
    if (
      typeof rule !== "object" ||
      rule === null ||
      !("sourceTableKey" in rule) ||
      typeof rule.sourceTableKey !== "string" ||
      !rule.sourceTableKey ||
      !("targetTableKey" in rule) ||
      typeof rule.targetTableKey !== "string" ||
      !rule.targetTableKey ||
      !("referenceFieldKey" in rule) ||
      typeof rule.referenceFieldKey !== "string" ||
      !rule.referenceFieldKey ||
      !("groupSize" in rule) ||
      typeof rule.groupSize !== "number" ||
      !Number.isInteger(rule.groupSize) ||
      rule.groupSize < 1 ||
      !("retainCount" in rule) ||
      typeof rule.retainCount !== "number" ||
      !Number.isInteger(rule.retainCount) ||
      rule.retainCount < 0 ||
      rule.sourceTableKey === rule.targetTableKey ||
      sources.has(rule.sourceTableKey)
    ) {
      throw new Error("总结规则的表/字段 Key、组大小或保留条数无效，来源表不可重复");
    }
    sources.add(rule.sourceTableKey);
    let timeRange: MemorySummaryRule["timeRange"];
    if ("timeRange" in rule) {
      const range = rule.timeRange;
      if (
        typeof range !== "object" ||
        range === null ||
        !("sourceStartFieldKey" in range) ||
        typeof range.sourceStartFieldKey !== "string" ||
        !range.sourceStartFieldKey ||
        !("sourceEndFieldKey" in range) ||
        typeof range.sourceEndFieldKey !== "string" ||
        !range.sourceEndFieldKey ||
        !("targetStartFieldKey" in range) ||
        typeof range.targetStartFieldKey !== "string" ||
        !range.targetStartFieldKey ||
        !("targetEndFieldKey" in range) ||
        typeof range.targetEndFieldKey !== "string" ||
        !range.targetEndFieldKey
      )
        throw new Error("总结时间范围须指定来源与总结的起止字段 Key");
      timeRange = {
        sourceStartFieldKey: range.sourceStartFieldKey,
        sourceEndFieldKey: range.sourceEndFieldKey,
        targetStartFieldKey: range.targetStartFieldKey,
        targetEndFieldKey: range.targetEndFieldKey,
      };
    }
    return {
      sourceTableKey: rule.sourceTableKey,
      targetTableKey: rule.targetTableKey,
      referenceFieldKey: rule.referenceFieldKey,
      groupSize: rule.groupSize,
      retainCount: rule.retainCount,
      ...(timeRange ? { timeRange } : {}),
    };
  });
}

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
  readonly summaryRules?: readonly MemorySummaryRule[];
  /** 复制自表格预设的通用填写规则；旧空间缺省为空。 */
  readonly prompt?: string;
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
