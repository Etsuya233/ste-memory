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
  type RegexCleaningRule,
  type TagCleaningRule,
} from "./cleaning-rule-lists.ts";

/** 判别字段固定的规则补丁（避免 Partial<联合> 的分布类型把判别放宽）。 */
type RegexPatch = Partial<Omit<RegexCleaningRule, "id">> & { readonly id?: string };
type TagPatch = Partial<Omit<TagCleaningRule, "id">> & { readonly id?: string };

function rule(overrides: RegexPatch = {}): CleaningRule {
  return {
    id: "r1",
    name: "去粗体",
    mode: "discard",
    type: "regex",
    pattern: "\\*\\*(.+?)\\*\\*",
    flags: "g",
    enabled: true,
    ...overrides,
  };
}

/** 标签规则工厂（ADR 0014）：默认去标签块 */
function tagRule(overrides: TagPatch = {}): CleaningRule {
  return {
    id: "rt",
    name: "去标签块",
    mode: "discard",
    type: "tag",
    pre: "【",
    post: "】",
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
          {
            id: "r1",
            name: "保留",
            mode: "keep",
            type: "regex",
            pattern: "a",
            flags: "g",
            enabled: true,
          },
          {
            id: "r2",
            name: "去掉",
            mode: "discard",
            type: "regex",
            pattern: "b",
            flags: "gi",
            enabled: false,
          },
          {
            id: "r3",
            name: "替换",
            mode: "replace",
            type: "regex",
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
          {
            id: "r-bad2",
            name: "flags 非法",
            mode: "discard",
            pattern: "x",
            flags: "x",
            enabled: true,
          },
          {
            id: "r-bad3",
            name: "正则非法",
            mode: "discard",
            pattern: "(",
            flags: "g",
            enabled: true,
          },
          {
            id: "r-bad4",
            name: "replace 缺替换串",
            mode: "replace",
            pattern: "x",
            flags: "g",
            enabled: true,
          },
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
    expect(
      validateCleaningRule({ name: "保留", mode: "keep", pattern: "a", flags: "g" }),
    ).toBeUndefined();
    expect(
      validateCleaningRule({ name: "去掉", mode: "discard", pattern: "a", flags: "" }),
    ).toBeUndefined();
    expect(
      validateCleaningRule({
        name: "替换",
        mode: "replace",
        pattern: "a",
        flags: "gi",
        replacement: "$1",
      }),
    ).toBeUndefined();
  });

  it("名称/模式/正则/flags/替换串非法时返回中文错误", () => {
    expect(validateCleaningRule({ name: "  ", mode: "keep", pattern: "a", flags: "g" })).toMatch(
      /名称/,
    );
    expect(
      validateCleaningRule({ name: "x".repeat(121), mode: "keep", pattern: "a", flags: "g" }),
    ).toMatch(/名称/);
    expect(
      validateCleaningRule({
        name: "x",
        mode: "erase" as CleaningRule["mode"],
        pattern: "a",
        flags: "g",
      }),
    ).toMatch(/模式/);
    expect(validateCleaningRule({ name: "x", mode: "keep", pattern: "", flags: "g" })).toMatch(
      /正则/,
    );
    expect(validateCleaningRule({ name: "x", mode: "keep", pattern: "(", flags: "g" })).toMatch(
      /正则/,
    );
    expect(validateCleaningRule({ name: "x", mode: "keep", pattern: "a", flags: "gg" })).toMatch(
      /flags/,
    );
    expect(validateCleaningRule({ name: "x", mode: "keep", pattern: "a", flags: "x" })).toMatch(
      /flags/,
    );
    expect(
      validateCleaningRule({
        name: "x",
        mode: "replace",
        pattern: "a",
        flags: "g",
        replacement: "",
      }),
    ).toMatch(/替换/);
    expect(
      validateCleaningRule({
        name: "x",
        mode: "replace",
        pattern: "a",
        flags: "g",
        replacement: undefined,
      }),
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
      {
        ...rule({ id: "a", mode: "discard" as const, pattern: "\\*\\*", flags: "g" }),
        enabled: false,
      },
      { ...rule({ id: "b", mode: "discard" as const, pattern: "\\*", flags: "g" }) },
      { ...rule({ id: "c", mode: "discard" as const, pattern: "x", flags: "g" }) },
    ];
    expect(applyCleaningRules("**加粗**", rules)).toBe("加粗");
  });

  it("keep：全局拼接捕获组 1（无组用整段匹配）；无匹配原样不动", () => {
    const keepGroup = {
      ...rule({ mode: "keep" as const, pattern: "\\*\\*(.+?)\\*\\*", flags: "g" }),
    };
    expect(applyCleaningRule("a **b** c **d**", keepGroup)).toBe("bd");
    const keepFull = { ...rule({ mode: "keep" as const, pattern: "\\*\\*.*?\\*\\*", flags: "g" }) };
    expect(applyCleaningRule("a **b** c", keepFull)).toBe("**b**");
    expect(applyCleaningRule("没有匹配", keepGroup)).toBe("没有匹配");
  });

  it("keep：flags 不含 g 时只取第一处匹配", () => {
    const keepFirst = {
      ...rule({ mode: "keep" as const, pattern: "\\*\\*(.+?)\\*\\*", flags: "" }),
    };
    expect(applyCleaningRule("**b** c **d**", keepFirst)).toBe("b");
  });

  it("discard：删除所有匹配段；非全局只删第一处；无匹配原样不动", () => {
    const discard = {
      ...rule({ mode: "discard" as const, pattern: "\\*\\*.*?\\*\\*", flags: "g" }),
    };
    expect(applyCleaningRule("a **b** c **d**", discard)).toBe("a  c ");
    const discardFirst = { ...discard, flags: "" };
    expect(applyCleaningRule("a **b** c **d**", discardFirst)).toBe("a  c **d**");
    expect(applyCleaningRule("没有匹配", discard)).toBe("没有匹配");
  });

  it("replace：JS 替换串语义（$1 / $<name> / 全局与单次）", () => {
    const replace = {
      ...rule({
        mode: "replace" as const,
        pattern: "(\\w+)@(\\w+)",
        flags: "g",
        replacement: "$2 的 $1",
      }),
    };
    expect(applyCleaningRule("a@x 和 b@y", replace)).toBe("x 的 a 和 y 的 b");
    const replaceNamed = {
      ...rule({
        mode: "replace" as const,
        pattern: "(?<k>\\w+)=(?<v>\\w+)",
        flags: "g",
        replacement: "$<v>←$<k>",
      }),
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

describe("标签规则（ADR 0014）：变换", () => {
  it("discard：删除 pre 与 post 夹住的整段（含标签），多处全局，无匹配原样", () => {
    const discard = tagRule({ pre: "【内心】", post: "【/内心】" });
    expect(applyCleaningRule("进来【内心】她心想【/内心】离开", discard)).toBe("进来离开");
    expect(applyCleaningRule("a【内心】1【/内心】b【内心】2【/内心】c", discard)).toBe("abc");
    expect(applyCleaningRule("没有标签", discard)).toBe("没有标签");
  });

  it("keep：只输出中间内容（剥掉标签），多处拼接", () => {
    const keep = tagRule({ mode: "keep", pre: "【内心】", post: "【/内心】" });
    expect(applyCleaningRule("进来【内心】她心想【/内心】离开", keep)).toBe("她心想");
    expect(applyCleaningRule("a【内心】1【/内心】b【内心】2【/内心】c", keep)).toBe("12");
    expect(applyCleaningRule("没有标签", keep)).toBe("没有标签");
  });

  it("replace：整段换成纯文本替换串（$1 不是刻意语义）", () => {
    const replace = tagRule({
      mode: "replace",
      pre: "【内心】",
      post: "【/内心】",
      replacement: "（内心）",
    });
    expect(applyCleaningRule("进来【内心】她心想【/内心】离开", replace)).toBe("进来（内心）离开");
  });

  it("replace：替换串中的 $ 按字面输出（不解释为 JS 替换模式）", () => {
    const replace = tagRule({
      mode: "replace",
      pre: "【x】",
      post: "【/x】",
      replacement: "$5 元",
    });
    expect(applyCleaningRule("a【x】b【/x】c", replace)).toBe("a$5 元c");
    const dollars = tagRule({
      mode: "replace",
      pre: "【x】",
      post: "【/x】",
      replacement: "$& 与 $$ 与 $1",
    });
    expect(applyCleaningRule("【x】v【/x】", dollars)).toBe("$& 与 $$ 与 $1");
  });

  it("内容跨行也能匹配（非贪婪、跨行）", () => {
    const discard = tagRule({ pre: "【x】", post: "【/x】" });
    expect(applyCleaningRule("a【x】第一行\n第二行【/x】b", discard)).toBe("ab");
  });

  it("非贪婪：取最短区间而不是首尾截断", () => {
    const discard = tagRule({ pre: "【", post: "】" });
    expect(applyCleaningRule("a【x】b【y】c", discard)).toBe("abc");
  });

  it("pre/post 是正则元字符时按字面匹配（自动转义）", () => {
    const paren = tagRule({ pre: "(", post: ")" });
    expect(applyCleaningRule("a(OOC: 别管)b", paren)).toBe("ab");
  });

  it("pre===post（如 ** ）按最短区间配对", () => {
    const stars = tagRule({ mode: "keep", pre: "**", post: "**" });
    expect(applyCleaningRule("a **粗体** b **斜体** c", stars)).toBe("粗体斜体");
  });

  it("嵌套标签：非贪婪固定行为（不绑定配对），首对闭合即结束", () => {
    const discard = tagRule({ pre: "【", post: "】" });
    expect(applyCleaningRule("【a【b】c】", discard)).toBe("c】");
  });
});

describe("validateCleaningRule（标签类型，ADR 0014）", () => {
  it("tag 合法输入通过；type 缺省按 regex（旧形状兼容）", () => {
    expect(
      validateCleaningRule({
        name: "去标签",
        mode: "discard",
        type: "tag",
        pattern: "",
        flags: "",
        pre: "【",
        post: "】",
      }),
    ).toBeUndefined();
    expect(
      validateCleaningRule({
        name: "替换标签",
        mode: "replace",
        type: "tag",
        pattern: "",
        flags: "",
        pre: "(",
        post: ")",
        replacement: "x",
      }),
    ).toBeUndefined();
    expect(
      validateCleaningRule({ name: "旧形状", mode: "discard", pattern: "a", flags: "g" }),
    ).toBeUndefined();
  });

  it("tag 的 pre/post 空白或 type 非法时报中文错误", () => {
    expect(
      validateCleaningRule({
        name: "x",
        mode: "discard",
        type: "bogus" as CleaningRule["type"],
        pattern: "a",
        flags: "",
      }),
    ).toMatch(/类型/);
    expect(
      validateCleaningRule({
        name: "x",
        mode: "discard",
        type: "tag",
        pattern: "a",
        flags: "",
        pre: "  ",
        post: "】",
      }),
    ).toMatch(/开始标签/);
    expect(
      validateCleaningRule({
        name: "x",
        mode: "discard",
        type: "tag",
        pattern: "a",
        flags: "",
        pre: "【",
        post: undefined,
      }),
    ).toMatch(/结束标签/);
    expect(
      validateCleaningRule({
        name: "x",
        mode: "replace",
        type: "tag",
        pattern: "a",
        flags: "",
        pre: "【",
        post: "】",
        replacement: "",
      }),
    ).toMatch(/替换/);
  });
});

describe("mergeCleaningRuleLists（标签规则，ADR 0014）", () => {
  it("旧形状（无 type）合并为 regex；tag 规则按 pre/post 合并并 trim 标签", () => {
    const merged = mergeCleaningRuleLists([
      {
        id: "l1",
        name: "列表",
        rules: [
          { id: "r-old", name: "旧规则", mode: "discard", pattern: "x", flags: "g", enabled: true },
          {
            id: "r-tag",
            name: "标签",
            type: "tag",
            mode: "keep",
            pre: " 【 ",
            post: "】 ",
            enabled: true,
          },
        ],
      },
    ]);
    expect(merged[0]!.rules).toEqual([
      {
        id: "r-old",
        name: "旧规则",
        mode: "discard",
        type: "regex",
        pattern: "x",
        flags: "g",
        enabled: true,
      },
      {
        id: "r-tag",
        name: "标签",
        type: "tag",
        mode: "keep",
        pre: "【",
        post: "】",
        enabled: true,
      },
    ]);
  });

  it("type 非法 / tag 缺 pre 或 post 丢弃；tag 规则的多余键（pattern/flags 等）不进入结果", () => {
    const merged = mergeCleaningRuleLists([
      {
        id: "l1",
        name: "列表",
        rules: [
          {
            id: "a",
            name: "类型非法",
            type: "bogus",
            mode: "discard",
            pattern: "x",
            flags: "g",
            enabled: true,
          },
          { id: "b", name: "缺 post", type: "tag", mode: "discard", pre: "【", enabled: true },
          { id: "c", name: "缺 pre", type: "tag", mode: "discard", post: "】", enabled: true },
          {
            id: "d",
            name: "合法 tag",
            type: "tag",
            mode: "discard",
            pre: "【",
            post: "】",
            pattern: "y",
            flags: "i",
            extra: 1,
            enabled: true,
          },
        ],
      },
    ]);
    expect(merged[0]!.rules).toEqual([
      {
        id: "d",
        name: "合法 tag",
        type: "tag",
        mode: "discard",
        pre: "【",
        post: "】",
        enabled: true,
      },
    ]);
  });
});
