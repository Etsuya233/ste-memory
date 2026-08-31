/**
 * Agent 预设预览 model（issue 01）：预览构建纯逻辑单测——
 * 启用且非空过滤、来源名回退、占位符展开（digest 缺省 = 空）、
 * {{msg}}/{{worldbook}} 空输入与扫描状态的标注。
 */
import { describe, expect, it } from "vitest";
import type { MemorySpaceTableDigest } from "@ste-memory/core/memory/agent";
import type { AgentPromptSnapshot } from "./preset-composer.ts";
import type { AgentPromptPreset } from "./preset-model.ts";
import { buildAgentPresetPreviewItems } from "./preset-preview-model.ts";

const NAMES = { user: "小明", char: "爱丽丝" };

function snapshot(overrides: Partial<AgentPromptSnapshot> = {}): AgentPromptSnapshot {
  return {
    names: NAMES,
    charCard: "爱丽丝是见习魔女。",
    userCard: "我是旅行商人。",
    worldbookText: "",
    msgText: "",
    ...overrides,
  };
}

/** 手写 digest：摘要格式契约 = core composeTableDigestSummary */
function digest(): MemorySpaceTableDigest {
  return {
    memorySpaceId: "space-1" as MemorySpaceTableDigest["memorySpaceId"],
    tables: [
      {
        id: "t1" as MemorySpaceTableDigest["tables"][number]["id"],
        key: "person" as MemorySpaceTableDigest["tables"][number]["key"],
        name: "人物",
        description: "",
        fields: [],
      },
    ],
  };
}

function preset(
  messages: readonly {
    readonly role: "system" | "user" | "assistant";
    readonly content: string;
    readonly name?: string;
    readonly enabled?: boolean;
  }[],
): AgentPromptPreset {
  return {
    id: "p1",
    name: "测试预设",
    messages: messages.map((m, i) => ({
      id: `m${i}`,
      name: m.name ?? "",
      role: m.role,
      content: m.content,
      enabled: m.enabled ?? true,
    })),
  };
}

describe("buildAgentPresetPreviewItems（预设预览构建纯逻辑）", () => {
  it("逐条展示启用且非空消息：角色 + 来源名 + 展开文本；停用/空内容不参与", () => {
    const items = buildAgentPresetPreviewItems({
      preset: preset([
        { role: "system", content: "你是 {{char}} 的填写员", name: "规则A" },
        { role: "user", content: "停用", enabled: false },
        { role: "assistant", content: "   " },
      ]),
      snapshot: snapshot(),
      digest: digest(),
      worldbookState: "scanned",
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      id: "m0",
      role: "system",
      sourceName: "规则A",
      text: "你是 爱丽丝 的填写员",
      note: undefined,
    });
  });

  it("来源名：空名回退内容首行；以空行开头的消息兜底「未命名消息」", () => {
    const items = buildAgentPresetPreviewItems({
      preset: preset([
        { role: "system", content: "第一行说明\n第二行细节" },
        { role: "user", content: "\n\n实际内容" },
      ]),
      snapshot: snapshot(),
      digest: digest(),
      worldbookState: "scanned",
    });
    expect(items.map((item) => item.sourceName)).toEqual(["第一行说明", "未命名消息"]);
  });

  it("{{msg}}：有输入展开为输入内容；无输入展开空串并标注", () => {
    const withInput = buildAgentPresetPreviewItems({
      preset: preset([{ role: "user", content: "总结：\n{{msg}}" }]),
      snapshot: snapshot({ msgText: "[3] 鲍勃：消息 3" }),
      digest: digest(),
      worldbookState: "scanned",
    });
    expect(withInput[0]!.text).toBe("总结：\n[3] 鲍勃：消息 3");
    expect(withInput[0]!.note).toBeUndefined();

    const noInput = buildAgentPresetPreviewItems({
      preset: preset([{ role: "user", content: "总结：\n{{msg}}" }]),
      snapshot: snapshot(),
      digest: digest(),
      worldbookState: "scanned",
    });
    expect(noInput[0]!.text).toBe("总结：\n");
    expect(noInput[0]!.note).toBe("{{msg}} 依赖任务块消息，预览中无输入 → 展开为空串");
  });

  it("{{worldbook}}：有输入展开扫描结果；无输入未扫描 → 标注；扫描失败 → 标注", () => {
    const scanned = buildAgentPresetPreviewItems({
      preset: preset([{ role: "system", content: "参考：\n{{worldbook}}" }]),
      snapshot: snapshot({ worldbookText: "云烬是神族后裔。" }),
      digest: digest(),
      worldbookState: "scanned",
    });
    expect(scanned[0]!.text).toBe("参考：\n云烬是神族后裔。");
    expect(scanned[0]!.note).toBeUndefined();

    const skipped = buildAgentPresetPreviewItems({
      preset: preset([{ role: "system", content: "参考：\n{{worldbook}}" }]),
      snapshot: snapshot(),
      digest: digest(),
      worldbookState: "skipped",
    });
    expect(skipped[0]!.text).toBe("参考：\n");
    expect(skipped[0]!.note).toBe("输入为空，未执行世界书扫描 → 展开为空串");

    const failed = buildAgentPresetPreviewItems({
      preset: preset([{ role: "system", content: "参考：\n{{worldbook}}" }]),
      snapshot: snapshot(),
      digest: digest(),
      worldbookState: "failed",
    });
    expect(failed[0]!.note).toBe("世界书扫描失败（旧版 ST 或扫描异常）→ 展开为空串");
  });

  it("digest 缺省（无活动空间）：{{tablesDigest}}/{{systemDefaultPrompt}} 展开空串，预览正常可用", () => {
    const items = buildAgentPresetPreviewItems({
      preset: preset([
        { role: "system", content: "摘要：{{tablesDigest}}" },
        { role: "user", content: "{{systemDefaultPrompt}}" },
      ]),
      snapshot: snapshot(),
      digest: undefined,
      worldbookState: "skipped",
    });
    expect(items[0]!.text).toBe("摘要：");
    expect(items[1]!.text).toBe("");
  });

  it("未知占位符原样保留（{{typo}} / ST 宏 {{time}} 不被展开、不标注）", () => {
    const items = buildAgentPresetPreviewItems({
      preset: preset([{ role: "system", content: "{{typo}} 和 {{time}} 与 {{user}}" }]),
      snapshot: snapshot(),
      digest: digest(),
      worldbookState: "scanned",
    });
    expect(items[0]!.text).toBe("{{typo}} 和 {{time}} 与 小明");
  });

  it("单遍替换：世界书扫描文本里的 {{user}} 不被二次展开", () => {
    const items = buildAgentPresetPreviewItems({
      preset: preset([{ role: "system", content: "{{worldbook}}" }]),
      snapshot: snapshot({ worldbookText: "{{user}} 的名字是秘密" }),
      digest: digest(),
      worldbookState: "scanned",
    });
    expect(items[0]!.text).toBe("{{user}} 的名字是秘密");
  });
});
