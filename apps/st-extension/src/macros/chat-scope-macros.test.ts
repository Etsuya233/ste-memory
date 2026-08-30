import { describe, expect, it } from "vitest";
import type { MemoryView } from "../settings/memory-views.ts";
import { mergeChatScopeMacros } from "./chat-scope-macros.ts";

/** 合法视图工厂 */
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

describe("mergeChatScopeMacros（聊天 Scope 宏合并）", () => {
  it("非对象/版本不匹配：空列表", () => {
    expect(mergeChatScopeMacros(undefined)).toEqual([]);
    expect(mergeChatScopeMacros(null)).toEqual([]);
    expect(mergeChatScopeMacros("oops")).toEqual([]);
    expect(mergeChatScopeMacros({})).toEqual([]);
    expect(mergeChatScopeMacros({ version: 2, macros: [] })).toEqual([]);
  });

  it("合法数据原样合并", () => {
    const store = { version: 1 as const, macros: [view()] };
    const merged = mergeChatScopeMacros(store);
    expect(merged).toEqual([view()]);
  });

  it("损坏的视图逐项丢弃，保留其余", () => {
    const store = {
      version: 1 as const,
      macros: [view({ name: "非法 名" }), view({ name: "有效" })],
    };
    const merged = mergeChatScopeMacros(store);
    expect(merged.map((v) => v.name)).toEqual(["有效"]);
  });

  it("重复名称：后出现的丢弃", () => {
    const store = {
      version: 1 as const,
      macros: [view({ name: "重复" }), view({ name: "重复" })],
    };
    const merged = mergeChatScopeMacros(store);
    expect(merged).toHaveLength(1);
  });
});
