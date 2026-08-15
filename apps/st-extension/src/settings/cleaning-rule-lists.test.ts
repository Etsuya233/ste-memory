/**
 * 清洗规则列表纯模型（ticket 22 / ADR 0011）：列表/规则 CRUD、持久化合并、
 * 聊天选择解析、读取时变换（keep/discard/replace 三模式）。
 */
import { describe, expect, it } from "vitest";
import {
  addCleaningRule,
  applyCleaningRule,
  applyCleaningRules,
  createCleaningRuleList,
  formatCleaningListSelection,
  mergeCleaningRuleLists,
  moveCleaningRule,
  parseCleaningListSelection,
  removeCleaningRule,
  removeCleaningRuleList,
  renameCleaningRuleList,
  resolveSelectedCleaningRules,
  updateCleaningRule,
  validateCleaningRule,
  type CleaningRule,
  type CleaningRuleList,
} from "./cleaning-rule-lists.ts";

function rule(overrides: Partial<CleaningRule> = {}): CleaningRule {
  return {
    id: "r1",
    name: "去粗体",
    mode: "discard",
    pattern: "\\*\\*(.+?)\\*\\*",
    flags: "g",
    enabled: true,
    ...overrides,
  };
}

function list(overrides: Partial<CleaningRuleList> = {}): CleaningRuleList {
  return { id: "l1", name: "我的清洗", rules: [rule()], ...overrides };
}

describe("mergeCleaningRuleLists（持久化合并）", () => {
  it("非数组/缺省 → 空列表", () => {
    expect(mergeCleaningRuleLists(undefined)).toEqual([]);
    expect(mergeCleaningRuleLists("junk")).toEqual([]);
    expect(mergeCleaningRuleLists({})).toEqual([]);
  });

  it("合法列表与规则原样保留（含 replace 模式的 replacement）", () => {
    const merged = mergeCleaningRuleLists([
      {
        id: "l1",
        name: "清洗A",
        rules: [
          { id: "r1", name: "保留", mode: "keep", pattern: "a", flags: "g", enabled: true },
          { id: "r2", name: "去掉", mode: "discard", pattern: "b", flags: "gi", enabled: false },
          {
            id: "r3",
            name: "替换",
            mode: "replace",
            pattern: "c",
            flags: "g",
            replacement: "$1",
            enabled: true,
          },
        ],
      },
    ]);
    expect(merged).toEqual([
      {
        id: "l1",
        name: "清洗A",
        rules: [
          { id: "r1", name: "保留", mode: "keep", pattern: "a", flags: "g", enabled: true },
          { id: "r2", name: "去掉", mode: "discard", pattern: "b", flags: "gi", enabled: false },
          {
            id: "r3",
            name: "替换",
            mode: "replace",
            pattern: "c",
            flags: "g",
            replacement: "$1",
            enabled: true,
          },
        ],
      },
    ]);
  });

  it("损坏的列表/规则逐项丢弃（保留其余），未知键不进入结果", () => {
    const merged = mergeCleaningRuleLists([
      { id: "l-ok", name: "好列表", rules: [rule()] },
      { id: "", name: "缺 id", rules: [] },
      { name: "缺 id 2", rules: [] },
      "junk",
      {
        id: "l-bad-rule",
        name: "坏规则列表",
        rules: [
          rule(),
          { id: "r-bad", name: "模式非法", mode: "erase", pattern: "x", flags: "g", enabled: true },
          { id: "r-bad2", name: "flags 非法", mode: "discard", pattern: "x", flags: "x", enabled: true },
          { id: "r-bad3", name: "正则非法", mode: "discard", pattern: "(", flags: "g", enabled: true },
          { id: "r-bad4", name: "replace 缺替换串", mode: "replace", pattern: "x", flags: "g", enabled: true },
        ],
      },
      { id: "l-extra", name: "多余键", rules: [rule()], extra: "被丢弃" },
    ]);
    expect(merged.map((l) => l.id)).toEqual(["l-ok", "l-bad-rule", "l-extra"]);
    expect(merged[1]!.rules).toEqual([rule()]);
    expect(merged[2]).toEqual({ id: "l-extra", name: "多余键", rules: [rule()] });
  });
});

describe("列表 CRUD", () => {
  it("create 追加空规则列表；rename/remove 按 id 命中，缺失时原样返回", () => {
    const created = createCleaningRuleList([], "l1", "我的清洗");
    expect(created).toEqual([{ id: "l1", name: "我的清洗", rules: [] }]);

    const renamed = renameCleaningRuleList(created, "l1", "新名字");
    expect(renamed[0]!.name).toBe("新名字");
    expect(renameCleaningRuleList(created, "missing", "x")).toEqual(created);

    const removed = removeCleaningRuleList(renamed, "l1");
    expect(removed).toEqual([]);
    expect(removeCleaningRuleList(created, "missing")).toEqual(created);
  });
});

describe("规则 CRUD", () => {
  it("add 追加到列表末尾（列表缺失原样返回）", () => {
    const withRule = addCleaningRule([list({ rules: [] })], "l1", rule());
    expect(withRule[0]!.rules).toEqual([rule()]);
    const again = addCleaningRule(withRule, "l1", rule({ id: "r2", name: "第二条" }));
    expect(again[0]!.rules.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(addCleaningRule(withRule, "missing", rule())).toEqual(withRule);
  });

  it("update 按规则 id 打补丁（列表/规则缺失原样返回）", () => {
    const updated = updateCleaningRule([list()], "l1", "r1", { enabled: false, pattern: "x" });
    expect(updated[0]!.rules[0]).toEqual({ ...rule(), enabled: false, pattern: "x" });
    expect(updateCleaningRule([list()], "l1", "missing", { enabled: false })).toEqual([list()]);
    expect(updateCleaningRule([list()], "missing", "r1", { enabled: false })).toEqual([list()]);
  });

  it("remove 按规则 id 删除（缺失原样返回）", () => {
    const removed = removeCleaningRule([list()], "l1", "r1");
    expect(removed[0]!.rules).toEqual([]);
    expect(removeCleaningRule([list()], "l1", "missing")).toEqual([list()]);
  });

  it("move 按目标下标重排（越界钳制；缺失原样返回）", () => {
    const three = [
      list({
        rules: [rule({ id: "a" }), rule({ id: "b" }), rule({ id: "c" })],
      }),
    ];
    const moved = moveCleaningRule(three, "l1", "c", 0);
    expect(moved[0]!.rules.map((r) => r.id)).toEqual(["c", "a", "b"]);
    const clamped = moveCleaningRule(three, "l1", "a", 99);
    expect(clamped[0]!.rules.map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(moveCleaningRule(three, "l1", "missing", 1)).toEqual(three);
    expect(moveCleaningRule(three, "missing", "a", 1)).toEqual(three);
  });
});

describe("validateCleaningRule（编辑/导入校验）", () => {
  it("三种模式的合法输入通过", () => {
    expect(validateCleaningRule({ name: "保留", mode: "keep", pattern: "a", flags: "g" })).toBeUndefined();
    expect(validateCleaningRule({ name: "去掉", mode: "discard", pattern: "a", flags: "" })).toBeUndefined();
    expect(
      validateCleaningRule({ name: "替换", mode: "replace", pattern: "a", flags: "gi", replacement: "$1" }),
    ).toBeUndefined();
  });

  it("名称/模式/正则/flags/替换串非法时返回中文错误", () => {
    expect(validateCleaningRule({ name: "  ", mode: "keep", pattern: "a", flags: "g" })).toMatch(/名称/);
    expect(validateCleaningRule({ name: "x".repeat(121), mode: "keep", pattern: "a", flags: "g" })).toMatch(/名称/);
    expect(validateCleaningRule({ name: "x", mode: "erase" as CleaningRule["mode"], pattern: "a", flags: "g" })).toMatch(/模式/);
    expect(validateCleaningRule({ name: "x", mode: "keep", pattern: "", flags: "g" })).toMatch(/正则/);
    expect(validateCleaningRule({ name: "x", mode: "keep", pattern: "(", flags: "g" })).toMatch(/正则/);
    expect(validateCleaningRule({ name: "x", mode: "keep", pattern: "a", flags: "gg" })).toMatch(/flags/);
    expect(validateCleaningRule({ name: "x", mode: "keep", pattern: "a", flags: "x" })).toMatch(/flags/);
    expect(
      validateCleaningRule({ name: "x", mode: "replace", pattern: "a", flags: "g", replacement: "" }),
    ).toMatch(/替换/);
    expect(
      validateCleaningRule({ name: "x", mode: "replace", pattern: "a", flags: "g", replacement: undefined }),
    ).toMatch(/替换/);
  });
});

describe("聊天选择（chatMetadata 小指针）", () => {
  it("parse：{version:1, listId} → listId；其余（缺失/版本不符/垃圾）→ undefined", () => {
    expect(parseCleaningListSelection({ version: 1, listId: "l1" })).toBe("l1");
    expect(parseCleaningListSelection(undefined)).toBeUndefined();
    expect(parseCleaningListSelection({ version: 2, listId: "l1" })).toBeUndefined();
    expect(parseCleaningListSelection({ version: 1, listId: "" })).toBeUndefined();
    expect(parseCleaningListSelection({ listId: "l1" })).toBeUndefined();
    expect(parseCleaningListSelection("l1")).toBeUndefined();
  });

  it("format：写回 chatMetadata 的形态", () => {
    expect(formatCleaningListSelection("l1")).toEqual({ version: 1, listId: "l1" });
  });

  it("resolve：未选择或列表已删除 → []；命中返回该列表规则", () => {
    expect(resolveSelectedCleaningRules([list()], undefined)).toEqual([]);
    expect(resolveSelectedCleaningRules([list()], "deleted")).toEqual([]);
    expect(resolveSelectedCleaningRules([list()], "l1")).toEqual([rule()]);
  });
});

describe("applyCleaningRules（读取时变换，apps ADR 0001 + replace）", () => {
  it("只应用启用规则，按传入顺序链式执行", () => {
    const rules = [
      { ...rule({ id: "a", mode: "discard" as const, pattern: "\\*\\*", flags: "g" }), enabled: false },
      { ...rule({ id: "b", mode: "discard" as const, pattern: "\\*", flags: "g" }) },
      { ...rule({ id: "c", mode: "discard" as const, pattern: "x", flags: "g" }) },
    ];
    expect(applyCleaningRules("**加粗**", rules)).toBe("加粗");
  });

  it("keep：全局拼接捕获组 1（无组用整段匹配）；无匹配原样不动", () => {
    const keepGroup = { ...rule({ mode: "keep" as const, pattern: "\\*\\*(.+?)\\*\\*", flags: "g" }) };
    expect(applyCleaningRule("a **b** c **d**", keepGroup)).toBe("bd");
    const keepFull = { ...rule({ mode: "keep" as const, pattern: "\\*\\*.*?\\*\\*", flags: "g" }) };
    expect(applyCleaningRule("a **b** c", keepFull)).toBe("**b**");
    expect(applyCleaningRule("没有匹配", keepGroup)).toBe("没有匹配");
  });

  it("keep：flags 不含 g 时只取第一处匹配", () => {
    const keepFirst = { ...rule({ mode: "keep" as const, pattern: "\\*\\*(.+?)\\*\\*", flags: "" }) };
    expect(applyCleaningRule("**b** c **d**", keepFirst)).toBe("b");
  });

  it("discard：删除所有匹配段；非全局只删第一处；无匹配原样不动", () => {
    const discard = { ...rule({ mode: "discard" as const, pattern: "\\*\\*.*?\\*\\*", flags: "g" }) };
    expect(applyCleaningRule("a **b** c **d**", discard)).toBe("a  c ");
    const discardFirst = { ...discard, flags: "" };
    expect(applyCleaningRule("a **b** c **d**", discardFirst)).toBe("a  c **d**");
    expect(applyCleaningRule("没有匹配", discard)).toBe("没有匹配");
  });

  it("replace：JS 替换串语义（$1 / $<name> / 全局与单次）", () => {
    const replace = {
      ...rule({ mode: "replace" as const, pattern: "(\\w+)@(\\w+)", flags: "g", replacement: "$2 的 $1" }),
    };
    expect(applyCleaningRule("a@x 和 b@y", replace)).toBe("x 的 a 和 y 的 b");
    const replaceNamed = {
      ...rule({ mode: "replace" as const, pattern: "(?<k>\\w+)=(?<v>\\w+)", flags: "g", replacement: "$<v>←$<k>" }),
    };
    expect(applyCleaningRule("a=1, b=2", replaceNamed)).toBe("1←a, 2←b");
    const replaceFirst = { ...replace, flags: "" };
    expect(applyCleaningRule("a@x 和 b@y", replaceFirst)).toBe("x 的 a 和 b@y");
  });

  it("能匹配空串的正则不卡死（零长匹配自动推进，替换为空串）", () => {
    const emptyMatch = { ...rule({ mode: "discard" as const, pattern: "a*", flags: "g" }) };
    // 零长匹配段替换为空串 = 无变化；关键是不死循环（JS 引擎自动推进 lastIndex）
    expect(applyCleaningRule("bbb", emptyMatch)).toBe("bbb");
    expect(applyCleaningRule("aaa", emptyMatch)).toBe("");
  });
});
