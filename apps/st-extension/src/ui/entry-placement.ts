/**
 * 面板入口挂载规划（纯逻辑层 seam）：入口位置设置 → 挂载目标计划 + 文案。
 * DOM 映射（ST DOM 不测的既有决策）在 st-panel-host 的挂载控制器里做，
 * 本模块只做决策与展示文本，vitest 直接覆盖。
 */

import type { EntryPlacement } from "../settings/plugin-settings.ts";

/** 挂载计划：每个表面是否挂载 + 是否发生了魔法棒回退 */
export interface EntryMountPlan {
  readonly top: boolean;
  readonly wand: boolean;
  /** 选魔法棒/两者但魔法棒菜单不可用 → 回退顶部；入口永不静默消失 */
  readonly fallback: boolean;
}

/** 设置选项固定顺序（设置分组三选一按钮顺序） */
export const ENTRY_PLACEMENT_OPTIONS: readonly EntryPlacement[] = ["top", "wand", "both"];

/** 选项中文标签 */
export const ENTRY_PLACEMENT_LABELS: Readonly<Record<EntryPlacement, string>> = {
  top: "顶部导航栏",
  wand: "底部魔法棒",
  both: "两者都显示",
};

/** 默认计划（与默认设置一致：顶部，无回退）；测试与无 entryMount 端口的运行时共用 */
export const DEFAULT_ENTRY_PLAN: EntryMountPlan = { top: true, wand: false, fallback: false };

/** 魔法棒不可用时的回退计划（顶部保留；wand/both 未就绪共用同一形状） */
const FALLBACK_ENTRY_PLAN: EntryMountPlan = { top: true, wand: false, fallback: true };

/**
 * 挂载目标决策：placement × 魔法棒菜单就绪度 → 计划。
 * wand/both 在菜单不可用时统一回退顶部（both 本就保留顶部）；
 * top 与魔法棒就绪度无关。
 */
export function planEntryMount(placement: EntryPlacement, wandReady: boolean): EntryMountPlan {
  switch (placement) {
    case "top":
      return DEFAULT_ENTRY_PLAN;
    case "wand":
      return wandReady
        ? { top: false, wand: true, fallback: false }
        : FALLBACK_ENTRY_PLAN;
    case "both":
      return wandReady
        ? { top: true, wand: true, fallback: false }
        : FALLBACK_ENTRY_PLAN;
  }
}

export function entryPlacementLabel(placement: EntryPlacement): string {
  return ENTRY_PLACEMENT_LABELS[placement];
}

/** 设置分组折叠摘要：正常 = 当前选择；回退时附加标记（折叠态也如实） */
export function entryGroupSummary(placement: EntryPlacement, plan: EntryMountPlan): string {
  return plan.fallback
    ? `${entryPlacementLabel(placement)}（已回退顶部）`
    : entryPlacementLabel(placement);
}

/** 组内实际位置提示：仅回退时返回说明，正常态返回 null（不渲染该行） */
export function actualPlacementNote(plan: EntryMountPlan): string | null {
  return plan.fallback ? "实际位置：顶部导航栏（魔法棒不可用）" : null;
}

/**
 * 挂载计划存储：挂载控制器写、设置分组 UI 读（useSyncExternalStore 端口）。
 * 生产由 st-panel-host 创建并注入 PanelRuntime.entryMount；测试可用 fake 或本工厂。
 */
export interface EntryPlanStore {
  getPlan(): EntryMountPlan;
  onPlanChange(listener: () => void): () => void;
}

export interface EntryMountControllerPort extends EntryPlanStore {
  /** 设置变更后通知挂载控制器重解析（热切换，无需重启） */
  replan(): void;
}

export function createEntryPlanStore(): EntryPlanStore & { setPlan(plan: EntryMountPlan): void } {
  let plan: EntryMountPlan = DEFAULT_ENTRY_PLAN;
  const listeners = new Set<() => void>();
  return {
    getPlan: () => plan,
    onPlanChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setPlan: (next) => {
      plan = next;
      for (const listener of listeners) listener();
    },
  };
}