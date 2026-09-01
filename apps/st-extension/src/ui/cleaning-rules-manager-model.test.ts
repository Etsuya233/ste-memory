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
  runCleaningTest,
  validateRuleDraft,
  type CleaningRuleDraft,
  type CleaningTestMessage,
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

describe("runCleaningTest（清洗测试运行，ticket 27）", () => {
  function draft(overrides: Partial<CleaningRuleDraft> = {}): CleaningRuleDraft {
    return {
      name: "草稿规则",
      mode: "discard",
      pattern: "a",
      flags: "g",
      replacement: "",
      enabled: true,
      ...overrides,
    };
  }

  function message(overrides: Partial<CleaningTestMessage> = {}): CleaningTestMessage {
    return { name: "爱丽丝", content: "**a**", ...overrides };
  }

  it("启用规则按序执行并收集每步中间态；停用规则标注跳过且内容不变", () => {
    const lists = [
      list({
        rules: [
          rule({ id: "r1", name: "去粗体", pattern: "\\*\\*" }),
          rule({ id: "r2", name: "a换b", mode: "replace", pattern: "a", replacement: "b" }),
          rule({ id: "r3", name: "停用的保留", mode: "keep", pattern: "\\*(.+?)\\*", enabled: false }),
        ],
      }),
    ];
    const run = runCleaningTest(lists[0]!.rules, new Map(), [message()]);
    expect(run).toEqual({
      kind: "ok",
      anyActiveRule: true,
      messages: [
        {
          name: "爱丽丝",
          input: "**a**",
          steps: [
            { ruleId: "r1", ruleName: "去粗体", mode: "discard", active: true, fromDraft: false, output: "a" },
            { ruleId: "r2", ruleName: "a换b", mode: "replace", active: true, fromDraft: false, output: "b" },
            { ruleId: "r3", ruleName: "停用的保留", mode: "keep", active: false, fromDraft: false, output: "b" },
          ],
          output: "b",
        },
      ],
    });
  });

  it("未保存草稿覆盖同 id 规则并标注 fromDraft；草稿 id 不在列表时追加到末尾（新建未保存规则）", () => {
    const run = runCleaningTest(
      [rule({ id: "r1", name: "去粗体" })],
      new Map([
        ["r1", draft({ name: "草稿覆盖", mode: "replace", pattern: "a", replacement: "X" })],
        ["pending-1", draft({ name: "新规则草稿", mode: "replace", pattern: "b", replacement: "Y" })],
      ]),
      [message({ content: "**ab**" })],
    );
    expect(run.kind).toBe("ok");
    if (run.kind !== "ok") return;
    expect(run.messages[0]!.steps).toEqual([
      { ruleId: "r1", ruleName: "草稿覆盖", mode: "replace", active: true, fromDraft: true, output: "**Xb**" },
      { ruleId: "pending-1", ruleName: "新规则草稿", mode: "replace", active: true, fromDraft: true, output: "**XY**" },
    ]);
  });

  it("启用规则的草稿校验失败 → 错误集合（含规则名），不产生结果", () => {
    const run = runCleaningTest(
      [rule({ id: "r1", name: "去粗体" })],
      new Map([["r1", draft({ pattern: "(" })]]),
      [message()],
    );
    expect(run).toEqual({ kind: "error", errors: ["规则「草稿规则」：正则表达式语法错误"] });
  });

  it("停用规则的无效草稿不阻断（跳过，不校验）", () => {
    const run = runCleaningTest(
      [rule({ id: "r1", name: "去粗体", enabled: false })],
      new Map([["r1", draft({ pattern: "(", enabled: false })]]),
      [message()],
    );
    expect(run).toEqual({
      kind: "ok",
      anyActiveRule: false,
      messages: [
        {
          name: "爱丽丝",
          input: "**a**",
          steps: [{ ruleId: "r1", ruleName: "草稿规则", mode: "discard", active: false, fromDraft: true, output: "**a**" }],
          output: "**a**",
        },
      ],
    });
  });

  it("消息列表逐条执行且只清洗 content，名字原样保留", () => {
    const run = runCleaningTest(
      [rule({ id: "r1", name: "去粗体" })],
      new Map(),
      [message(), message({ name: "", content: "**b**" })],
    );
    expect(run.kind).toBe("ok");
    if (run.kind !== "ok") return;
    expect(run.messages.map((m) => [m.name, m.input, m.output])).toEqual([
      ["爱丽丝", "**a**", "a"],
      ["", "**b**", "b"],
    ]);
  });

  it("空消息列表 → ok + 空 messages", () => {
    expect(runCleaningTest([rule()], new Map(), [])).toEqual({
      kind: "ok",
      anyActiveRule: true,
      messages: [],
    });
  });

  it("无规则或全部停用 → anyActiveRule=false，步骤为空/全跳过，结果为原文", () => {
    const noRules = runCleaningTest([], new Map(), [message()]);
    expect(noRules).toEqual({
      kind: "ok",
      anyActiveRule: false,
      messages: [{ name: "爱丽丝", input: "**a**", steps: [], output: "**a**" }],
    });
    const allDisabled = runCleaningTest([rule({ id: "r1", enabled: false })], new Map(), [message()]);
    expect(allDisabled).toEqual({
      kind: "ok",
      anyActiveRule: false,
      messages: [
        {
          name: "爱丽丝",
          input: "**a**",
          steps: [{ ruleId: "r1", ruleName: "去粗体", mode: "discard", active: false, fromDraft: false, output: "**a**" }],
          output: "**a**",
        },
      ],
    });
  });
});
