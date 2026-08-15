/**
 * 清洗规则设置区块（ticket 22 / ADR 0011）的纯逻辑 seam：区块视图模型、
 * 导入目标解析、导入应用（永远追加）、规则行编辑草稿。
 * 组件只做「模型 → DOM」投影与事件接线（同 task-panel-model 惯例）。
 */
import { describe, expect, it } from "vitest";
import type { CleaningRule, CleaningRuleList } from "../settings/cleaning-rule-lists.ts";
import type { StRegexImportItem } from "../settings/st-regex-import.ts";
import {
  applyImportedRules,
  buildStRegexImportReport,
  resolveImportTarget,
  ruleDraftFromRule,
  validateRuleDraft,
} from "./cleaning-rules-manager-model.ts";

function rule(overrides: Partial<CleaningRule> = {}): CleaningRule {
  return {
    id: "r1",
    name: "去粗体",
    mode: "discard",
    pattern: "\\*\\*",
    flags: "g",
    enabled: true,
    ...overrides,
  };
}

function list(overrides: Partial<CleaningRuleList> = {}): CleaningRuleList {
  return { id: "l1", name: "我的清洗", rules: [rule()], ...overrides };
}

function importedRule(overrides: Partial<CleaningRule> = {}): StRegexImportItem {
  return {
    kind: "rule",
    rule: rule({ id: "imported-1", name: "导入条目", ...overrides }),
    notes: [],
  };
}

describe("resolveImportTarget（导入目标解析）", () => {
  it("已有列表透传；新建列表名称去空白、空名回退默认名", () => {
    expect(resolveImportTarget({ kind: "existing", listId: "l1" })).toEqual({
      kind: "existing",
      listId: "l1",
    });
    expect(resolveImportTarget({ kind: "new", name: "  从 ST 导入  " })).toEqual({
      kind: "new",
      name: "从 ST 导入",
    });
    expect(resolveImportTarget({ kind: "new", name: "  " })).toEqual({
      kind: "new",
      name: "从 ST 导入",
    });
  });
});

describe("applyImportedRules（导入应用：永远追加，Q6）", () => {
  it("追加到已有列表末尾；跳过条目不产生规则；未选列表原样", () => {
    const items: readonly StRegexImportItem[] = [
      importedRule(),
      importedRule({ id: "imported-2", name: "第二条" }),
      { kind: "skipped", scriptName: "坏条目", reason: "作用范围不含用户输入/AI 输出" },
    ];
    const result = applyImportedRules([list()], { kind: "existing", listId: "l1" }, items, () => "ignored");
    expect(result[0]!.rules.map((r) => r.id)).toEqual(["r1", "imported-1", "imported-2"]);
  });

  it("新建目标：创建列表（含名称）+ 追加规则；空条目不创建空列表", () => {
    const result = applyImportedRules([], { kind: "new", name: "从 ST 导入" }, [
      importedRule(),
      importedRule({ id: "imported-2" }),
    ], () => "new-list");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "new-list", name: "从 ST 导入" });
    expect(result[0]!.rules.map((r) => r.id)).toEqual(["imported-1", "imported-2"]);

    expect(applyImportedRules([], { kind: "new", name: "从 ST 导入" }, [
      { kind: "skipped", scriptName: "x", reason: "y" },
    ], () => "new-list")).toEqual([]);  });
});

describe("buildStRegexImportReport（导入报告）", () => {
  it("统计新建与跳过，跳过条目逐条说明", () => {
    const report = buildStRegexImportReport([
      importedRule(),
      { kind: "skipped", scriptName: "A", reason: "缺匹配式" },
      importedRule({ id: "imported-2" }),
      { kind: "skipped", scriptName: "B", reason: "正则无法编译" },
    ]);
    expect(report).toEqual({
      created: 2,
      skipped: [
        { scriptName: "A", reason: "缺匹配式" },
        { scriptName: "B", reason: "正则无法编译" },
      ],
    });
  });
});

describe("规则行编辑草稿", () => {
  it("ruleDraftFromRule 往返；validateRuleDraft 复用规则校验", () => {
    const draft = ruleDraftFromRule(rule({ mode: "replace", replacement: "$1" }));
    expect(draft).toEqual({
      name: "去粗体",
      mode: "replace",
      pattern: "\\*\\*",
      flags: "g",
      replacement: "$1",
      enabled: true,
    });
    expect(validateRuleDraft({ ...draft, name: "" })).toMatch(/名称/);
    expect(validateRuleDraft({ ...draft, pattern: "(" })).toMatch(/正则/);
    expect(validateRuleDraft(draft)).toBeUndefined();
  });
});
