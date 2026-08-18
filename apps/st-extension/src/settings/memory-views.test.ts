import { describe, expect, it } from "vitest";
import {
  MEMORY_VIEW_LIMIT_MAX,
  mergeMemoryViews,
  validateMemoryViewName,
  type MemoryView,
} from "./memory-views.ts";

/** 合法视图工厂（各测试只覆盖自己要变的字段） */
function view(overrides: Partial<MemoryView> = {}): MemoryView {
  return {
    name: "未完成伏笔",
    tableKey: "plots",
    condition: { fieldKey: "status", values: ["埋设中", "已触发"] },
    limit: 50,
    projection: ["name", "status"],
    ...overrides,
  };
}

describe("validateMemoryViewName（ST 宏参数语法约束 + 非空）", () => {
  it("合法名：中文/字母/数字/下划线/连字符", () => {
    expect(validateMemoryViewName("未完成伏笔")).toBeUndefined();
    expect(validateMemoryViewName("plots_v2")).toBeUndefined();
    expect(validateMemoryViewName("last-5")).toBeUndefined();
  });

  it("空名/全空白拒绝", () => {
    expect(validateMemoryViewName("")).toBeDefined();
    expect(validateMemoryViewName("   ")).toBeDefined();
  });

  it("含空白拒绝（ST 参数内空白为 SKIPPED）", () => {
    expect(validateMemoryViewName("未完成 伏笔")).toBeDefined();
    expect(validateMemoryViewName("a\tb")).toBeDefined();
  });

  it("含 :: / | / }} 拒绝（ST 参数分隔符/过滤器标志/宏结束）", () => {
    expect(validateMemoryViewName("a::b")).toBeDefined();
    expect(validateMemoryViewName("a|b")).toBeDefined();
    expect(validateMemoryViewName("a}}b")).toBeDefined();
  });
});

describe("mergeMemoryViews（损坏数据逐项丢弃，保留其余）", () => {
  it("非数组/缺失：空列表", () => {
    expect(mergeMemoryViews(undefined)).toEqual([]);
    expect(mergeMemoryViews(null)).toEqual([]);
    expect(mergeMemoryViews("oops")).toEqual([]);
    expect(mergeMemoryViews({})).toEqual([]);
  });

  it("合法视图原样合并（字段形状保留）", () => {
    const merged = mergeMemoryViews([view()]);
    expect(merged).toEqual([view()]);
  });

  it("名称非法/空表 Key 的视图丢弃，其余保留", () => {
    const merged = mergeMemoryViews([
      view({ name: "非法 名" }),
      view({ name: "合法", tableKey: "" }),
      view({ name: "有效视图" }),
    ]);
    expect(merged.map((v) => v.name)).toEqual(["有效视图"]);
  });

  it("重复名称：后出现的丢弃（全局唯一）", () => {
    const merged = mergeMemoryViews([view({ name: "重复" }), view({ name: "重复" })]);
    expect(merged).toHaveLength(1);
  });

  it("condition 形状损坏（非对象/缺字段 Key/值集合为空或含非字符串）丢弃", () => {
    expect(mergeMemoryViews([view({ condition: "oops" as never })])).toEqual([]);
    expect(mergeMemoryViews([view({ condition: { fieldKey: "", values: ["x"] } })])).toEqual([]);
    expect(mergeMemoryViews([view({ condition: { fieldKey: "status", values: [] } })])).toEqual([]);
    expect(
      mergeMemoryViews([view({ condition: { fieldKey: "status", values: ["x", 7 as never] } })]),
    ).toEqual([]);
    // 无筛选（null）合法
    expect(mergeMemoryViews([view({ condition: null })])).toEqual([view({ condition: null })]);
  });

  it("limit 非法（非整数/小于 1/非数）丢弃；超契约上限钳制到 100", () => {
    expect(mergeMemoryViews([view({ limit: 0 })])).toEqual([]);
    expect(mergeMemoryViews([view({ limit: -5 })])).toEqual([]);
    expect(mergeMemoryViews([view({ limit: 1.5 })])).toEqual([]);
    expect(mergeMemoryViews([view({ limit: "50" as never })])).toEqual([]);
    expect(mergeMemoryViews([view({ limit: 500 })])).toEqual([
      view({ limit: MEMORY_VIEW_LIMIT_MAX }),
    ]);
  });

  it("projection 非字符串数组丢弃；缺省 = 空（无投影）", () => {
    expect(mergeMemoryViews([view({ projection: [1, 2] as never })])).toEqual([]);
    expect(mergeMemoryViews([view({ projection: undefined as never })])).toEqual([
      view({ projection: [] }),
    ]);
  });
});
