import { describe, expect, it } from "vitest";
import {
  applyCleaningRules,
  type CleaningRule,
} from "../../features/cleaning/cleaning-rule-lists.ts";
import { runCleaningTest, ruleDraftFromRule, draftToRule } from "./cleaning-rules-manager-model.ts";
const rule: CleaningRule = {
  id: "r1",
  name: "正文",
  enabled: true,
  keepTags: [{ pre: "<a>", post: "</a>" }],
  excludeTags: [],
};
describe("清洗测试与草稿", () => {
  it("逐消息清洗与真实流水线一致，保留名字和原文", () => {
    const messages = [
      { name: "角色<a>名字</a>", content: "外<a>甲</a>" },
      { name: "用户", content: "未命中" },
    ];
    const result = runCleaningTest([rule], new Map(), messages);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("测试未执行");
    result.messages.forEach((message, i) => {
      expect(message.output).toBe(applyCleaningRules(messages[i]!.content, [rule]));
      expect(message.input).toBe(messages[i]!.content);
      expect(message.name).toBe(messages[i]!.name);
    });
  });
  it("未保存草稿覆盖已有规则，新规则草稿追加", () => {
    const draft = {
      ...ruleDraftFromRule(rule),
      keepTags: [],
      excludeTags: [{ pre: "<a>", post: "</a>" }],
    };
    const result = runCleaningTest(
      [rule],
      new Map([
        [rule.id, draft],
        ["r2", { ...draft, enabled: false }],
      ]),
      [{ name: "", content: "外<a>甲</a>" }],
    );
    expect(result).toMatchObject({
      kind: "ok",
      messages: [
        {
          output: "外",
          steps: [
            { fromDraft: true, active: true },
            { fromDraft: true, active: false },
          ],
        },
      ],
    });
  });
  it("不完整的启用草稿报告错误，停用草稿跳过", () => {
    const draft = { ...ruleDraftFromRule(rule), keepTags: [{ pre: "", post: "" }] };
    expect(runCleaningTest([rule], new Map([[rule.id, draft]]), [])).toMatchObject({
      kind: "error",
    });
    expect(
      runCleaningTest([rule], new Map([[rule.id, { ...draft, enabled: false }]]), [
        { name: "", content: "原文" },
      ]),
    ).toMatchObject({ kind: "ok", anyActiveRule: false, messages: [{ output: "原文" }] });
  });
  it("保存时规范化标签，草稿保留输入", () => {
    const draft = { ...ruleDraftFromRule(rule), keepTags: [{ pre: " <a> ", post: " </a> " }] };
    expect(draftToRule(draft, "r1").keepTags).toEqual(rule.keepTags);
    expect(draft.keepTags[0]!.pre).toBe(" <a> ");
  });
});
