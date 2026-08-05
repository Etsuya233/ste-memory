import { describe, expect, it } from "vitest";
import type { CleaningRule } from "../src/application/ports/cleaning-rule.ts";
import {
  applyCleaningRule,
  applyCleaningRules,
} from "../src/application/cleaning-rules/transform.ts";

function rule(overrides: Partial<CleaningRule> = {}): CleaningRule {
  return {
    id: "rule-1",
    memorySpaceId: "space" as CleaningRule["memorySpaceId"],
    position: 0,
    enabled: true,
    name: "测试规则",
    mode: "discard",
    pattern: "\\*",
    flags: "g",
    ...overrides,
  };
}

describe("清洗规则纯变换", () => {
  it("去掉：删除所有匹配段，无匹配原样不动", () => {
    expect(applyCleaningRule("*a*b*", rule({ pattern: "\\*", flags: "g" }))).toBe("ab");
    expect(applyCleaningRule("无符号", rule({ pattern: "\\*", flags: "g" }))).toBe("无符号");
  });

  it("去掉：无 g flag 时只删第一处匹配", () => {
    expect(applyCleaningRule("*a*b*", rule({ pattern: "\\*", flags: "" }))).toBe("a*b*");
  });

  it("保留：输出捕获组 1（若有），否则整段匹配；多个匹配按出现顺序拼接", () => {
    const keepGroup = rule({
      mode: "keep",
      pattern: "【([^】]+)】",
      flags: "g",
    });
    expect(applyCleaningRule("【甲】和【乙】", keepGroup)).toBe("甲乙");
    expect(applyCleaningRule("没有括号", keepGroup)).toBe("没有括号");

    const keepWhole = rule({ mode: "keep", pattern: "[A-Z]+", flags: "g" });
    expect(applyCleaningRule("abCDefGH", keepWhole)).toBe("CDGH");
  });

  it("保留：捕获组捕获到空串时输出空串（组存在优先于整段匹配）", () => {
    const keepGroup = rule({ mode: "keep", pattern: "x(\\d*)", flags: "g" });
    expect(applyCleaningRule("x12 x x3", keepGroup)).toBe("123");
  });

  it("保留：无 g flag 时只取第一处匹配", () => {
    expect(
      applyCleaningRule("abCDefGH", rule({ mode: "keep", pattern: "[A-Z]+", flags: "" })),
    ).toBe("CD");
  });

  it("按顺序执行，上一条输出是下一条输入", () => {
    const rules: readonly CleaningRule[] = [
      rule({ id: "1", position: 0, mode: "discard", pattern: "\\*", flags: "g" }),
      rule({ id: "2", position: 1, mode: "keep", pattern: "【([^】]+)】", flags: "g" }),
    ];
    // 先去星号再保留括号内容：*【重要】* → 【重要】 → 重要
    expect(applyCleaningRules("*【重要】*", rules)).toBe("重要");
  });

  it("停用的规则不参与变换", () => {
    const rules: readonly CleaningRule[] = [
      rule({ id: "1", position: 0, mode: "discard", pattern: "\\*", flags: "g", enabled: false }),
    ];
    expect(applyCleaningRules("*a*", rules)).toBe("*a*");
  });

  it("能匹配空串的正则不产生死循环（零长匹配自动推进）", () => {
    expect(applyCleaningRule("abc", rule({ mode: "keep", pattern: "x*", flags: "g" }))).toBe("");
    expect(applyCleaningRule("abc", rule({ mode: "discard", pattern: "x*", flags: "g" }))).toBe(
      "abc",
    );
  });

  it("多行与忽略大小写 flag 生效", () => {
    const multi = rule({ mode: "discard", pattern: "^\\d+\\. ", flags: "gm" });
    expect(applyCleaningRule("1. 第一行\n2. 第二行", multi)).toBe("第一行\n第二行");
    expect(applyCleaningRule("ABC", rule({ mode: "discard", pattern: "abc", flags: "gi" }))).toBe(
      "",
    );
  });
});
