/**
 * Agent 提示词预设组合器（ticket 17 / ADR 0006）：预设文本 → 最终 system prompt。
 * 占位符**单遍**展开（正则一次扫描，替换结果不再被扫描——摘要/默认提示词里的
 * 同名 token 不会被二次替换）；未知占位符原样保留（用户决策）。
 */
import { describe, expect, it } from "vitest";
import type { MemoryFieldKey, MemoryFieldType, MemoryTableKey } from "@ste-memory/core/memory";
import type { MemorySpaceTableDigest } from "@ste-memory/core/memory/agent";
import {
  AGENT_PRESET_PLACEHOLDERS,
  composePresetSystemPrompt,
  expandAgentPresetPlaceholders,
  type AgentPromptNames,
} from "./preset-composer.ts";

const NAMES: AgentPromptNames = { user: "小明", char: "爱丽丝" };

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

describe("占位符展开", () => {
  it("{{user}} / {{char}} 展开为提交时快照的对话双方名字", () => {
    expect(expandAgentPresetPlaceholders("服务 {{user}} 与 {{char}}", NAMES, digest(), "")).toBe(
      "服务 小明 与 爱丽丝",
    );
  });

  it("{{tablesDigest}} 展开为表/字段摘要（与默认提示词摘要同格式）", () => {
    const text = expandAgentPresetPlaceholders("请参考：\n{{tablesDigest}}", NAMES, digest(), "");
    expect(text).toBe(`请参考：\n${DIGEST_SUMMARY}`);
  });

  it("{{systemDefaultPrompt}} 展开为默认提示词全文（指令 + 摘要）", () => {
    const text = expandAgentPresetPlaceholders("{{systemDefaultPrompt}}", NAMES, digest(), "");
    expect(text).toContain("你是记忆表格填写助手");
    expect(text).toContain("工作流程：");
    expect(text).toContain(DIGEST_SUMMARY);
  });

  it("{{worldbook}} 展开为提交时快照的世界书文本（原样插入）", () => {
    const text = expandAgentPresetPlaceholders(
      "世界观：\n{{worldbook}}",
      NAMES,
      digest(),
      "云烬是上古神族后裔。\n藤ノ森学园的地下隐藏着结界。",
    );
    expect(text).toBe("世界观：\n云烬是上古神族后裔。\n藤ノ森学园的地下隐藏着结界。");
  });

  it("{{worldbook}} 无世界书/无匹配（空文本）→ 空串，不留占位符原文", () => {
    expect(expandAgentPresetPlaceholders("看 {{worldbook}}", NAMES, digest(), "")).toBe("看 ");
  });

  it("单遍替换：世界书文本里的 {{user}} 不被二次展开（与摘要同语义）", () => {
    const text = expandAgentPresetPlaceholders(
      "{{worldbook}}",
      NAMES,
      digest(),
      "{{user}} 的名字是秘密",
    );
    expect(text).toBe("{{user}} 的名字是秘密");
  });

  it("未知占位符原样保留（{{typo}} 不报错不清理）", () => {
    expect(expandAgentPresetPlaceholders("{{typo}} 和 {{user}}", NAMES, digest(), "")).toBe(
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
    const text = expandAgentPresetPlaceholders("{{tablesDigest}}", NAMES, weird, "");
    expect(text).toContain("【person｜{{user}}的收藏】");
    expect(text).not.toContain("【person｜小明的收藏】");
  });
});

describe("composePresetSystemPrompt", () => {
  it("返回 composer：digest 参数注入占位符展开（组合器签名与核心 ProposalSystemPromptComposer 一致）", () => {
    const composer = composePresetSystemPrompt("给 {{char}} 填表，{{user}} 说了算", NAMES, "");
    const prompt = composer(digest());
    expect(prompt).toBe("给 爱丽丝 填表，小明 说了算");
  });

  it("composer 携带世界书快照：{{worldbook}} 每次组合展开为同一快照文本", () => {
    const composer = composePresetSystemPrompt("参考：{{worldbook}}", NAMES, "云烬是神族后裔");
    expect(composer(digest())).toBe("参考：云烬是神族后裔");
  });

  it("占位符常量供编辑器插入 chips 与文档使用", () => {
    expect(AGENT_PRESET_PLACEHOLDERS).toEqual({
      user: "{{user}}",
      char: "{{char}}",
      tablesDigest: "{{tablesDigest}}",
      systemDefaultPrompt: "{{systemDefaultPrompt}}",
      worldbook: "{{worldbook}}",
    });
  });
});
