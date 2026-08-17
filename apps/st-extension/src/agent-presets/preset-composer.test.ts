/**
 * Agent 提示词预设组合器（ticket 17 / ADR 0006 + 消息编排扩展）：预设消息列表 →
 * 编排消息（ComposedAgentMessage[]）。
 * 占位符**单遍**展开（正则一次扫描，替换结果不再被扫描——摘要/默认提示词里的
 * 同名 token 不会被二次替换）；未知占位符原样保留（用户决策）。
 */
import { describe, expect, it } from "vitest";
import type { MemoryFieldKey, MemoryFieldType, MemoryTableKey } from "@ste-memory/core/memory";
import type { MemorySpaceTableDigest } from "@ste-memory/core/memory/agent";
import {
  AGENT_PRESET_PLACEHOLDERS,
  composePresetMessages,
  expandAgentPresetPlaceholders,
  type AgentPromptSnapshot,
} from "./preset-composer.ts";
import type { AgentPromptPreset } from "./preset-model.ts";

const NAMES = { user: "小明", char: "爱丽丝" };

function snapshot(overrides: Partial<AgentPromptSnapshot> = {}): AgentPromptSnapshot {
  return {
    names: NAMES,
    charCard: "",
    userCard: "",
    worldbookText: "",
    msgText: "",
    ...overrides,
  };
}

/** 手写 digest：摘要格式契约 = core composeTableDigestSummary（表 key/name/字段行）。 */
function digest(): MemorySpaceTableDigest {
  return {
    memorySpaceId: "space-1" as MemorySpaceTableDigest["memorySpaceId"],
    tables: [
      {
        id: "t1" as MemorySpaceTableDigest["tables"][number]["id"],
        key: "person" as MemoryTableKey,
        name: "人物",
        description: "登场角色",
        fields: [
          {
            id: "f1" as MemorySpaceTableDigest["tables"][number]["fields"][number]["id"],
            key: "name" as MemoryFieldKey,
            name: "姓名",
            type: "short_text" as MemoryFieldType,
            required: true,
            options: [],
            referenceTableKey: null,
            maxChars: 50,
            valuePatternMessage: null,
          },
          {
            id: "f2" as MemorySpaceTableDigest["tables"][number]["fields"][number]["id"],
            key: "role" as MemoryFieldKey,
            name: "身份",
            type: "single_select" as MemoryFieldType,
            required: false,
            options: ["主角", "配角"],
            referenceTableKey: null,
            maxChars: null,
            valuePatternMessage: null,
          },
        ],
      },
    ],
  };
}

const DIGEST_SUMMARY =
  "可用表与字段（key 是工具参数取值，只能使用下列 key；\n填错会报错，错误信息会附带可用 key 列表）：\n【person｜人物】\n说明：登场角色\n- name｜姓名：short_text，必填，≤50字\n- role｜身份：single_select，选项：主角 / 配角";

/** 预设消息列表（内容/角色/开关，id 与 name 与组合器无关） */
function preset(
  messages: readonly {
    role: "system" | "user" | "assistant";
    content: string;
    enabled?: boolean;
  }[],
): AgentPromptPreset {
  return {
    id: "p1",
    name: "测试预设",
    messages: messages.map((m, i) => ({
      id: `m${i}`,
      name: "",
      role: m.role,
      content: m.content,
      enabled: m.enabled ?? true,
    })),
  };
}

describe("占位符展开", () => {
  it("{{user}} / {{char}} 展开为提交时快照的对话双方名字", () => {
    expect(expandAgentPresetPlaceholders("服务 {{user}} 与 {{char}}", snapshot(), digest())).toBe(
      "服务 小明 与 爱丽丝",
    );
  });

  it("{{char_card}} 展开为角色卡描述（单角色/群聊由适配器快照决定，此处原样插入）", () => {
    const text = expandAgentPresetPlaceholders(
      "角色设定：{{char_card}}",
      snapshot({ charCard: "爱丽丝是来自魔法学院的见习魔女。" }),
      digest(),
    );
    expect(text).toBe("角色设定：爱丽丝是来自魔法学院的见习魔女。");
  });

  it("{{user_card}} 展开为当前 Persona 描述", () => {
    const text = expandAgentPresetPlaceholders(
      "我的设定：{{user_card}}",
      snapshot({ userCard: "我是旅行商人。" }),
      digest(),
    );
    expect(text).toBe("我的设定：我是旅行商人。");
  });

  it("{{msg}} 展开为本块消息文本（{{msg}} 无值 = 空串）", () => {
    expect(
      expandAgentPresetPlaceholders(
        "请总结：{{msg}}",
        snapshot({ msgText: "[1] 爱丽丝：你好" }),
        digest(),
      ),
    ).toBe("请总结：[1] 爱丽丝：你好");
    expect(expandAgentPresetPlaceholders("请总结：{{msg}}", snapshot(), digest())).toBe("请总结：");
  });

  it("{{tablesDigest}} 展开为表/字段摘要（与默认提示词摘要同格式）", () => {
    const text = expandAgentPresetPlaceholders("请参考：\n{{tablesDigest}}", snapshot(), digest());
    expect(text).toBe(`请参考：\n${DIGEST_SUMMARY}`);
  });

  it("{{systemDefaultPrompt}} 展开为默认提示词全文（指令 + 摘要）", () => {
    const text = expandAgentPresetPlaceholders("{{systemDefaultPrompt}}", snapshot(), digest());
    expect(text).toContain("你是记忆表格填写助手");
    expect(text).toContain("工作流程：");
    expect(text).toContain(DIGEST_SUMMARY);
  });

  it("{{worldbook}} 展开为提交时快照的世界书文本（原样插入）", () => {
    const text = expandAgentPresetPlaceholders(
      "世界观：\n{{worldbook}}",
      snapshot({ worldbookText: "云烬是上古神族后裔。\n藤ノ森学园的地下隐藏着结界。" }),
      digest(),
    );
    expect(text).toBe("世界观：\n云烬是上古神族后裔。\n藤ノ森学园的地下隐藏着结界。");
  });

  it("{{worldbook}} 无世界书/无匹配（空文本）→ 空串，不留占位符原文", () => {
    expect(expandAgentPresetPlaceholders("看 {{worldbook}}", snapshot(), digest())).toBe("看 ");
  });

  it("单遍替换：世界书文本里的 {{user}} 不被二次展开（与摘要同语义）", () => {
    const text = expandAgentPresetPlaceholders(
      "{{worldbook}}",
      snapshot({ worldbookText: "{{user}} 的名字是秘密" }),
      digest(),
    );
    expect(text).toBe("{{user}} 的名字是秘密");
  });

  it("未知占位符原样保留（{{typo}} 不报错不清理）", () => {
    expect(expandAgentPresetPlaceholders("{{typo}} 和 {{user}}", snapshot(), digest())).toBe(
      "{{typo}} 和 小明",
    );
  });

  it("单遍替换：摘要内容里的同名 token 不被二次替换（表名可含 {{user}}）", () => {
    const weird: MemorySpaceTableDigest = {
      ...digest(),
      tables: [
        {
          ...digest().tables[0]!,
          name: "{{user}}的收藏",
        },
      ],
    };
    const text = expandAgentPresetPlaceholders("{{tablesDigest}}", snapshot(), weird);
    expect(text).toContain("【person｜{{user}}的收藏】");
    expect(text).not.toContain("【person｜小明的收藏】");
  });
});

describe("composePresetMessages", () => {
  it("返回 composer：digest 参数注入占位符展开（组合器签名与核心 ProposalMessagesComposer 一致）", () => {
    const composer = composePresetMessages(
      preset([{ role: "system", content: "给 {{char}} 填表，{{user}} 说了算" }]),
      snapshot(),
    );
    const messages = composer(digest());
    expect(messages).toEqual([{ role: "system", text: "给 爱丽丝 填表，小明 说了算" }]);
  });

  it("消息角色与顺序原样保留（system / user / assistant 混合编排）", () => {
    const composer = composePresetMessages(
      preset([
        { role: "system", content: "你是记忆助手。" },
        { role: "user", content: "这是示例对话。" },
        { role: "assistant", content: "我明白了。" },
        { role: "user", content: "继续。" },
      ]),
      snapshot(),
    );
    expect(composer(digest()).map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(composer(digest()).map((m) => m.text)).toEqual([
      "你是记忆助手。",
      "这是示例对话。",
      "我明白了。",
      "继续。",
    ]);
  });

  it("停用或内容为空的消息不参与编排", () => {
    const composer = composePresetMessages(
      preset([
        { role: "system", content: "启用" },
        { role: "user", content: "停用", enabled: false },
        { role: "assistant", content: "   " },
      ]),
      snapshot(),
    );
    expect(composer(digest())).toEqual([{ role: "system", text: "启用" }]);
  });

  it("{{msg}} 按块展开：compose(msgText) 每次组合展开为同一块快照文本", () => {
    const composer = composePresetMessages(
      preset([{ role: "user", content: "总结：\n{{msg}}" }]),
      snapshot({ msgText: "[3] 鲍勃：消息 3" }),
    );
    expect(composer(digest())).toEqual([{ role: "user", text: "总结：\n[3] 鲍勃：消息 3" }]);
  });

  it("composer 携带快照：{{char_card}}/{{user_card}}/{{worldbook}} 每次组合展开为同一快照文本", () => {
    const composer = composePresetMessages(
      preset([
        {
          role: "system",
          content: "卡：{{char_card}}｜设定：{{user_card}}｜参考：{{worldbook}}",
        },
      ]),
      snapshot({
        charCard: "爱丽丝是见习魔女。",
        userCard: "我是旅行商人。",
        worldbookText: "云烬是神族后裔",
      }),
    );
    expect(composer(digest())).toEqual([
      {
        role: "system",
        text: "卡：爱丽丝是见习魔女。｜设定：我是旅行商人。｜参考：云烬是神族后裔",
      },
    ]);
  });

  it("占位符常量供编辑器插入 chips 与文档使用", () => {
    expect(AGENT_PRESET_PLACEHOLDERS).toEqual({
      user: "{{user}}",
      char: "{{char}}",
      char_card: "{{char_card}}",
      user_card: "{{user_card}}",
      msg: "{{msg}}",
      tablesDigest: "{{tablesDigest}}",
      systemDefaultPrompt: "{{systemDefaultPrompt}}",
      worldbook: "{{worldbook}}",
    });
  });
});
