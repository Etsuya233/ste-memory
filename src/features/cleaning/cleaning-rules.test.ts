import { describe, expect, it } from "vitest";
import {
  applyCleaningRule,
  validateCleaningRule,
  mergeCleaningRules,
  saveCleaningRule,
  removeCleaningRule,
  formatCleaningRuleSelection,
  readCleaningRuleSelection,
  findSelectedCleaningRule,
  type CleaningRule,
} from "./cleaning-rules.ts";
const a = { pre: "<a>", post: "</a>" };
const b = { pre: "【正文】", post: "【/正文】" };
const hidden = { pre: "<think>", post: "</think>" };
const rule = (patch: Partial<CleaningRule> = {}): CleaningRule => ({
  id: "r1",
  name: "正文",
  enabled: true,
  keepTags: [a],
  excludeTags: [hidden],
  ...patch,
});

describe("标签清洗", () => {
  it("保留组为 OR，按原文顺序提取多次匹配，用换行连接", () => {
    expect(
      applyCleaningRule("前【正文】乙【/正文】中<a>甲</a><a>丙</a>后", rule({ keepTags: [a, b] })),
    ).toBe("乙\n甲\n丙");
  });
  it("先按 OR 删除多个排除标签，再提取内容", () => {
    expect(
      applyCleaningRule(
        "外<think>忽略</think><a>甲<think>推理</think>乙【注】注释【/注】丙</a>外",
        rule({ excludeTags: [hidden, { pre: "【注】", post: "【/注】" }] }),
      ),
    ).toBe("甲乙丙");
  });
  it("排除组顺序不影响不同标签嵌套的结果", () => {
    const content = "<a>正文<think>内【注】注【/注】容</think>尾</a>";
    const note = { pre: "【注】", post: "【/注】" };
    expect(applyCleaningRule(content, rule({ excludeTags: [note, hidden] }))).toBe("正文尾");
    expect(applyCleaningRule(content, rule({ excludeTags: [hidden, note] }))).toBe("正文尾");
  });
  it("相同标签同时在两组时，排除优先", () => {
    expect(
      applyCleaningRule(
        "<a>甲</a>【正文】乙【/正文】",
        rule({ keepTags: [a, b], excludeTags: [a] }),
      ),
    ).toBe("乙");
  });
  it("没有保留配置时，全文参与排除；未命中排除保持原文", () => {
    expect(applyCleaningRule("甲<think>思考</think>乙", rule({ keepTags: [] }))).toBe("甲乙");
    expect(applyCleaningRule("原文", rule({ keepTags: [] }))).toBe("原文");
  });
  it("保留配置未命中、只有不完整标签或空内容时输出空文本", () => {
    for (const content of ["原文", "<a>未闭合", "<a></a>", ""])
      expect(applyCleaningRule(content, rule())).toBe("");
  });
  it("不完整的排除标签原样保留", () => {
    expect(applyCleaningRule("甲<think>未闭合", rule({ keepTags: [] }))).toBe("甲<think>未闭合");
  });
  it("字面匹配、区分大小写、跨行；相同起止标签有效", () => {
    expect(applyCleaningRule("<A>大写</A><a>甲\n乙</a>", rule())).toBe("甲\n乙");
    expect(
      applyCleaningRule("前**甲$1\n乙**后", rule({ keepTags: [{ pre: "**", post: "**" }] })),
    ).toBe("甲$1\n乙");
  });
  it("重复配置不重复输出，同组不同标签嵌套只提取外层片段一次", () => {
    expect(applyCleaningRule("<a>甲【正文】乙【/正文】丙</a>", rule({ keepTags: [b, a, a] }))).toBe(
      "甲【正文】乙【/正文】丙",
    );
  });
  it("同一起点选择完整的外层片段，OR 结果不受标签顺序影响", () => {
    const short = { pre: "<a>", post: "</short>" };
    const long = { pre: "<a>", post: "</long>" };
    const content = "<a>甲</short>乙</long>";
    expect(applyCleaningRule(content, rule({ keepTags: [short, long] }))).toBe("甲</short>乙");
    expect(applyCleaningRule(content, rule({ keepTags: [long, short] }))).toBe("甲</short>乙");
  });
  it("停用规则跳过", () => {
    const content = "外<a>甲<think>思考</think>乙</a>";
    expect(applyCleaningRule(content, rule({ enabled: false }))).toBe(content);
  });
  it("先排除思考区域，再提取正文，思考中的正文不会泄漏", () => {
    expect(applyCleaningRule("<think><a>草稿</a></think><a>正式</a>", rule())).toBe("正式");
    expect(applyCleaningRule("<think><a>草稿</a></think>", rule())).toBe("");
  });
  it("排除后不再有保留标签时输出空，保留组为空时返回排除后的全文", () => {
    expect(applyCleaningRule("前<think><a>草稿</a></think>后", rule())).toBe("");
    expect(applyCleaningRule("前<think><a>草稿</a></think>后", rule({ keepTags: [] }))).toBe(
      "前后",
    );
  });
});

describe("独立命名清洗规则", () => {
  it("拒绝空名称、超长名称、空规则和不完整标签", () => {
    for (const patch of [
      { name: " " },
      { name: "a".repeat(121) },
      { keepTags: [], excludeTags: [] },
      { keepTags: [{ pre: " ", post: "</a>" }] },
      { excludeTags: [{ pre: "<a>", post: "" }] },
    ])
      expect(validateCleaningRule(rule(patch))).toBeDefined();
    expect(validateCleaningRule(rule())).toBeUndefined();
  });
  it("当前版本直接读取规则并规范化标签，没有子规则数组", () => {
    const result = mergeCleaningRules([rule({ keepTags: [{ pre: " <a> ", post: " </a> " }] })]);
    expect(result[0]!.keepTags).toEqual([a]);
    expect(result[0]).not.toHaveProperty("rules");
    expect(() => mergeCleaningRules([rule({ keepTags: [], excludeTags: [] })])).toThrow(
      "请至少添加",
    );
  });
  it("独立保存、修改和删除规则；对话只选择其中一份", () => {
    let rules = saveCleaningRule([], rule());
    rules = saveCleaningRule(rules, rule({ id: "r2", name: "另一份" }));
    rules = saveCleaningRule(rules, rule({ name: "修改", enabled: false }));
    expect(rules).toHaveLength(2);
    expect(findSelectedCleaningRule(rules, "r1")).toMatchObject({ name: "修改", enabled: false });
    expect(findSelectedCleaningRule(rules, "missing")).toBeUndefined();
    expect(removeCleaningRule(rules, "r1").map((r) => r.id)).toEqual(["r2"]);
  });
  it("对话选择使用 v3 的 ruleId，旧列表选择失效", () => {
    expect(formatCleaningRuleSelection("r1")).toEqual({ version: 3, ruleId: "r1" });
    expect(readCleaningRuleSelection(formatCleaningRuleSelection("r1"))).toBe("r1");
    expect(readCleaningRuleSelection({ version: 2, listId: "old" })).toBeUndefined();
  });
});
