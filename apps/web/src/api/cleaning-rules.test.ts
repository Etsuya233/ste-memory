import { describe, expect, it } from "vitest";
import {
  applyCleaningRule,
  applyCleaningRules,
  validateCleaningRule,
  type CleaningRule,
} from "./cleaning-rules.ts";

function rule(overrides: Partial<CleaningRule> = {}): CleaningRule {
  return {
    id: "rule-1",
    memorySpaceId: "space",
    position: 0,
    enabled: true,
    name: "测试规则",
    mode: "discard",
    pattern: "\\*",
    flags: "g",
    ...overrides,
  };
}

describe("前端清洗规则变换（预览复刻，语义与 API 一致）", () => {
  it("去掉：删除所有匹配段，无匹配原样不动", () => {
    expect(applyCleaningRule("*a*b*", rule())).toBe("ab");
    expect(applyCleaningRule("无符号", rule())).toBe("无符号");
  });

  it("去掉：无 g flag 时只删第一处匹配", () => {
    expect(applyCleaningRule("*a*b*", rule({ flags: "" }))).toBe("a*b*");
  });

  it("保留：捕获组 1 优先，多个匹配按顺序拼接，无匹配原样不动", () => {
    const keep = rule({ mode: "keep", pattern: "【([^】]+)】", flags: "g" });
    expect(applyCleaningRule("【甲】和【乙】", keep)).toBe("甲乙");
    expect(applyCleaningRule("没有括号", keep)).toBe("没有括号");
  });

  it("按顺序执行且停用规则跳过", () => {
    const rules: readonly CleaningRule[] = [
      rule({ id: "1", position: 0, pattern: "\\*", flags: "g" }),
      rule({ id: "2", position: 1, mode: "keep", pattern: "【([^】]+)】", flags: "g" }),
    ];
    expect(applyCleaningRules("*【重要】*", rules)).toBe("重要");
    expect(applyCleaningRules("*a*", [rule({ ...rules[0], enabled: false })])).toBe("*a*");
  });

  it("校验：语法错误/空名称/重复 flags 拒绝，空匹配正则放行", () => {
    expect(validateCleaningRule(rule())).toBeUndefined();
    expect(validateCleaningRule(rule({ pattern: "([" }))).toContain("语法错误");
    expect(validateCleaningRule(rule({ name: "  " }))).toContain("名称");
    expect(validateCleaningRule(rule({ flags: "gg" }))).toContain("flags");
    expect(validateCleaningRule(rule({ mode: "keep", pattern: "x*" }))).toBeUndefined();
  });
});
