import { describe, expect, it } from "vitest";
import { applyCleaningRule, type CleaningRule } from "../../../features/cleaning/cleaning-rules.ts";
import { runCleaningTest, ruleDraftFromRule, draftToRule } from "./cleaning-rules-manager-model.ts";
const rule: CleaningRule = {
  id: "r1",
  name: "正文",
  enabled: true,
  keepTags: [{ pre: "<a>", post: "</a>" }],
  excludeTags: [{ pre: "<think>", post: "</think>" }],
};
describe("单规则清洗测试与草稿", () => {
  it("每条消息只执行当前规则，与真实执行一致，保留名字和原文", () => {
    const messages = [
      { name: "角色<a>名字</a>", content: "<think><a>草稿</a></think><a>正式</a>" },
      { name: "用户", content: "未命中" },
    ];
    const result = runCleaningTest(rule, messages);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("测试未执行");
    result.messages.forEach((message, i) => {
      expect(message.output).toBe(applyCleaningRule(messages[i]!.content, rule));
      expect(message.input).toBe(messages[i]!.content);
      expect(message.name).toBe(messages[i]!.name);
      expect(message).not.toHaveProperty("steps");
    });
    expect(result.messages[0]!.output).toBe("正式");
  });
  it("草稿可独立测试，不修改已保存规则", () => {
    const draft = {
      ...ruleDraftFromRule(rule),
      keepTags: [],
      excludeTags: [{ pre: "<a>", post: "</a>" }],
    };
    expect(
      runCleaningTest(draftToRule(draft, "r1"), [{ name: "", content: "外<a>正文</a>" }]),
    ).toMatchObject({ kind: "ok", messages: [{ output: "外" }] });
    expect(rule.keepTags).toEqual([{ pre: "<a>", post: "</a>" }]);
  });
  it("不完整启用规则报告错误；停用规则保留原文", () => {
    const invalid = { ...rule, keepTags: [{ pre: "", post: "" }] };
    expect(runCleaningTest(invalid, [])).toMatchObject({ kind: "error" });
    expect(
      runCleaningTest({ ...invalid, enabled: false }, [{ name: "", content: "原文" }]),
    ).toMatchObject({ kind: "ok", active: false, messages: [{ output: "原文" }] });
  });
  it("保存时规范化标签，草稿保留输入", () => {
    const draft = { ...ruleDraftFromRule(rule), keepTags: [{ pre: " <a> ", post: " </a> " }] };
    expect(draftToRule(draft, "r1").keepTags).toEqual(rule.keepTags);
    expect(draft.keepTags[0]!.pre).toBe(" <a> ");
  });
});
