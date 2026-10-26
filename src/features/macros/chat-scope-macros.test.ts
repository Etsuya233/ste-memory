import { describe, expect, it } from "vitest";
import type { MemoryView } from "./memory-views.ts";
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
  it("无旧存储为空，损坏及未知版本报错保留原始数据", () => {
    expect(mergeChatScopeMacros(undefined)).toEqual([]);
    for (const raw of [null, "oops", {}, { version: 2, macros: [] }])
      expect(() => mergeChatScopeMacros(raw)).toThrow("原始数据已保留");
  });

  it("合法数据原样合并", () => {
    const store = { version: 1 as const, macros: [view()] };
    const merged = mergeChatScopeMacros(store);
    expect(merged).toEqual([view()]);
  });

  it("合法旧定义的省略字段在严格校验后补齐", () => {
    expect(
      mergeChatScopeMacros({ version: 1, macros: [{ name: "旧宏", tableKey: "notes" }] }),
    ).toEqual([{ name: "旧宏", tableKey: "notes", condition: null, limit: null, projection: [] }]);
  });

  it("损坏的同级视图不能被迁移静默丢弃", () => {
    const store = {
      version: 1 as const,
      macros: [view({ name: "非法 名" }), view({ name: "有效" })],
    };
    expect(() => mergeChatScopeMacros(store)).toThrow();
    expect(store.macros).toHaveLength(2);
  });

  it("重复名称必须显式修复", () => {
    const store = {
      version: 1 as const,
      macros: [view({ name: "重复" }), view({ name: "重复" })],
    };
    expect(() => mergeChatScopeMacros(store)).toThrow("重复");
  });
});
