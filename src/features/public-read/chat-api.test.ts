import { describe, expect, it } from "vitest";
import { createMemoryChatApi, type MemoryChatMessage } from "./chat-api.ts";
import type { CleaningRule } from "../cleaning/cleaning-rules.ts";

describe("public cleaned chat", () => {
  const rule: CleaningRule = {
    id: "story",
    name: "剧情正文",
    enabled: true,
    keepTags: [{ pre: "<story>", post: "</story>" }],
    excludeTags: [{ pre: "<status>", post: "</status>" }],
  };

  it("cleans only AI output inside the selected window and does not backfill empty output", async () => {
    const messages: MemoryChatMessage[] = [
      { floor: 0, name: "角色", role: "assistant", content: "<story>更早的正文</story>" },
      { floor: 1, name: "用户", role: "user", content: "用户 <status>原文</status>" },
      { floor: 2, name: "旁白", role: "narrator", content: "旁白 <status>原文</status>" },
      { floor: 3, name: "角色", role: "assistant", content: "只有面板，没有正文标签" },
      {
        floor: 4,
        name: "角色",
        role: "assistant",
        content: "<story>走进花园。<status>面板</status>看到了花。</story>",
      },
    ];
    const api = createMemoryChatApi({
      getChatIdentity: () => "chat",
      readRecentMessages: (count) => messages.slice(-count),
      readCleaningRule: () => rule,
    });
    const result = await api.readRecent({ chatIdentity: "chat", count: 4 });
    expect(result).toEqual({
      chatIdentity: "chat",
      messages: [messages[1], messages[2], { ...messages[4], content: "走进花园。看到了花。" }],
      cleaning: { enabled: true, ruleId: "story", ruleName: "剧情正文" },
    });
    expect(Object.isFrozen(result.messages)).toBe(true);
    expect(Object.isFrozen(result.messages[0])).toBe(true);
    expect(messages[4]!.content).toContain("<status>");
  });

  it("reports no selection and disabled selection without changing text", async () => {
    let selected: CleaningRule | undefined = undefined;
    const api = createMemoryChatApi({
      getChatIdentity: () => "chat",
      readRecentMessages: () => [
        { floor: 2, name: "角色", role: "assistant", content: "原文 <status>面板</status>" },
      ],
      readCleaningRule: () => selected,
    });
    expect((await api.readRecent({ chatIdentity: "chat", count: 20 })).cleaning).toEqual({
      enabled: false,
      ruleId: null,
      ruleName: null,
    });
    selected = { ...rule, enabled: false };
    const disabled = await api.readRecent({ chatIdentity: "chat", count: 20 });
    expect(disabled.cleaning).toEqual({
      enabled: false,
      ruleId: "story",
      ruleName: "剧情正文",
    });
    expect(disabled.messages[0]!.content).toBe("原文 <status>面板</status>");
  });

  it("rejects stale identities, invalid windows and selected-rule read errors", async () => {
    const api = createMemoryChatApi({
      getChatIdentity: () => "chat",
      readRecentMessages: () => [],
      readCleaningRule: () => {
        throw new Error("所选清洗规则已不存在");
      },
    });
    await expect(api.readRecent({ chatIdentity: "other", count: 20 })).rejects.toThrow("对话");
    await expect(api.readRecent({ chatIdentity: "chat", count: 0 })).rejects.toThrow("正整数");
    await expect(api.readRecent({ chatIdentity: "chat", count: 20 })).rejects.toThrow("已不存在");
  });
});
