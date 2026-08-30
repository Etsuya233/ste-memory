import { describe, expect, it } from "vitest";
import type { MemoryView } from "../settings/memory-views.ts";
import {
  BUILTIN_FULL_MACRO,
  BUILTIN_TABLE_MACRO_PREFIX,
  mergeChatScopeMacros,
  validateChatScopeMacroName,
  isBuiltinMacroName,
} from "./chat-scope-macros.ts";

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

describe("validateChatScopeMacroName（名称冲突校验）", () => {
  const globalNames = ["globalMacro", "另一个全局宏"];

  it("合法名无冲突", () => {
    expect(validateChatScopeMacroName("我的宏", globalNames)).toBeUndefined();
  });

  it("空名/非法字符拒绝", () => {
    expect(validateChatScopeMacroName("", globalNames)).toBeDefined();
    expect(validateChatScopeMacroName("非法 名", globalNames)).toBeDefined();
  });

  it("内置 memoryFull 冲突", () => {
    expect(validateChatScopeMacroName(BUILTIN_FULL_MACRO, globalNames)).toContain("memoryFull");
  });

  it("内置 memory_ 前缀冲突", () => {
    expect(validateChatScopeMacroName("memory_角色", globalNames)).toContain("memory_");
    expect(validateChatScopeMacroName("memory_事件", globalNames)).toContain("memory_");
  });

  it("全局宏冲突", () => {
    expect(validateChatScopeMacroName("globalMacro", globalNames)).toContain("globalMacro");
    expect(validateChatScopeMacroName("另一个全局宏", globalNames)).toContain("另一个全局宏");
  });
});

describe("isBuiltinMacroName（内置宏名检测）", () => {
  it("memoryFull 是内置宏", () => {
    expect(isBuiltinMacroName("memoryFull")).toBe(true);
  });

  it("memory_ 前缀是内置宏", () => {
    expect(isBuiltinMacroName("memory_角色")).toBe(true);
    expect(isBuiltinMacroName("memory_事件")).toBe(true);
  });

  it("其他名字不是内置宏", () => {
    expect(isBuiltinMacroName("globalMacro")).toBe(false);
    expect(isBuiltinMacroName("我的宏")).toBe(false);
    expect(isBuiltinMacroName("memoryContext")).toBe(false);
  });
});
