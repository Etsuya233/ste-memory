import { describe, expect, it, vi } from "vitest";
import {
  ENTRY_PLACEMENT_OPTIONS,
  actualPlacementNote,
  createEntryPlanStore,
  entryGroupSummary,
  entryPlacementLabel,
  planEntryMount,
} from "./entry-placement.ts";

describe("planEntryMount（挂载目标决策）", () => {
  it("顶部：只挂顶部，与魔法棒就绪与否无关，无回退", () => {
    expect(planEntryMount("top", true)).toEqual({ top: true, wand: false, fallback: false });
    expect(planEntryMount("top", false)).toEqual({ top: true, wand: false, fallback: false });
  });

  it("魔法棒：菜单就绪挂魔法棒；未就绪回退顶部并标记 fallback", () => {
    expect(planEntryMount("wand", true)).toEqual({ top: false, wand: true, fallback: false });
    expect(planEntryMount("wand", false)).toEqual({ top: true, wand: false, fallback: true });
  });

  it("两者：就绪双挂；未就绪顶部保留 + 标记 fallback（顶部永不消失）", () => {
    expect(planEntryMount("both", true)).toEqual({ top: true, wand: true, fallback: false });
    expect(planEntryMount("both", false)).toEqual({ top: true, wand: false, fallback: true });
  });
});

describe("入口位置文案", () => {
  it("选项集与选项标签", () => {
    expect(ENTRY_PLACEMENT_OPTIONS).toEqual(["top", "wand", "both"]);
    expect(entryPlacementLabel("top")).toBe("顶部导航栏");
    expect(entryPlacementLabel("wand")).toBe("底部魔法棒");
    expect(entryPlacementLabel("both")).toBe("两者都显示");
  });

  it("分组折叠摘要：正常显示当前选择；回退时附加标记", () => {
    expect(entryGroupSummary("wand", { top: false, wand: true, fallback: false })).toBe(
      "底部魔法棒",
    );
    expect(entryGroupSummary("both", { top: true, wand: true, fallback: false })).toBe(
      "两者都显示",
    );
    expect(entryGroupSummary("wand", { top: true, wand: false, fallback: true })).toBe(
      "底部魔法棒（已回退顶部）",
    );
  });

  it("实际位置提示：仅回退时给出说明，正常态不显示", () => {
    expect(actualPlacementNote({ top: true, wand: false, fallback: true })).toBe(
      "实际位置：顶部导航栏（魔法棒不可用）",
    );
    expect(actualPlacementNote({ top: false, wand: true, fallback: false })).toBeNull();
    expect(actualPlacementNote({ top: true, wand: false, fallback: false })).toBeNull();
  });
});

describe("createEntryPlanStore（挂载计划存储，面板壳/挂载控制器共享）", () => {
  it("初始为默认计划（顶部，无回退）；setPlan 通知订阅者并可见新值", () => {
    const store = createEntryPlanStore();
    expect(store.getPlan()).toEqual({ top: true, wand: false, fallback: false });
    const listener = vi.fn();
    const off = store.onPlanChange(listener);
    store.setPlan({ top: false, wand: true, fallback: false });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getPlan()).toEqual({ top: false, wand: true, fallback: false });
    off();
  });

  it("退订后不再通知；再次 setPlan 不影响已退订监听者", () => {
    const store = createEntryPlanStore();
    const listener = vi.fn();
    store.onPlanChange(listener)();
    store.setPlan({ top: true, wand: false, fallback: true });
    expect(listener).not.toHaveBeenCalled();
  });
});