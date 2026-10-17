/**
 * Agent 提示词预设模型（ticket 17 + 消息编排扩展）：预设 CRUD / 消息操作 /
 * 导入导出信封 / digest 引用检测。全部纯函数，settings 不可变更新。
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_PRESET_EXPORT_FORMAT,
  AGENT_PRESET_EXPORT_VERSION,
  BUILTIN_AGENT_PRESET_ID,
  containsDigestReference,
  containsMsgReference,
  containsWorldbookReference,
  createAgentPreset,
  deleteAgentPreset,
  duplicateAgentPreset,
  importAgentPreset,
  moveAgentPreset,
  moveAgentPresetMessage,
  parseAgentPresetExport,
  presetPromptText,
  removeAgentPresetMessage,
  renameAgentPreset,
  serializeAgentPresetExport,
  setActiveAgentPreset,
  updateAgentPresetMessage,
  addAgentPresetMessage,
  resolveActivePreset,
  type AgentPresetRole,
  type AgentPromptPreset,
  type AgentPresetSettings,
} from "./preset-model.ts";

/** 固定 id 生成器：按调用序递增，便于断言 */
function sequentialIds(): () => string {
  let next = 1;
  return () => `id-${next++}`;
}

function settings(overrides: Partial<AgentPresetSettings> = {}): AgentPresetSettings {
  return { presets: [], activePresetId: BUILTIN_AGENT_PRESET_ID, ...overrides };
}

function preset(
  id: string,
  name: string,
  messages: AgentPromptPreset["messages"] = [],
): AgentPromptPreset {
  return { id, name, messages };
}

function message(
  id: string,
  content: string,
  options: { enabled?: boolean; name?: string; role?: AgentPresetRole } = {},
): AgentPromptPreset["messages"][number] {
  return {
    id,
    name: options.name ?? "",
    role: options.role ?? "system",
    content,
    enabled: options.enabled ?? true,
  };
}

describe("创建与复制预设", () => {
  it("createAgentPreset：新建预设含一条空启用的 system 消息，并自动设为活动预设", () => {
    const next = createAgentPreset(settings(), "破限", sequentialIds());
    expect(next.presets).toHaveLength(1);
    expect(next.presets[0]).toMatchObject({
      name: "破限",
      messages: [{ role: "system", enabled: true, content: "", name: "" }],
    });
    expect(next.activePresetId).toBe(next.presets[0]!.id);
  });

  it("duplicateAgentPreset：复制全部消息（含角色）与开关状态，命名为「原名 (副本)」，设为活动", () => {
    const original = preset("p1", "轻度破限", [
      message("f1", "第一条", { name: "规则A" }),
      message("f2", "第二条", { enabled: false, name: "规则B", role: "user" }),
    ]);
    const next = duplicateAgentPreset(settings({ presets: [original] }), "p1", sequentialIds());
    const copy = next.presets.find((p) => p.id === "id-1");
    expect(copy).toBeDefined();
    expect(copy!.name).toBe("轻度破限 (副本)");
    expect(copy!.messages).toEqual([
      { id: "id-2", name: "规则A", role: "system", content: "第一条", enabled: true },
      { id: "id-3", name: "规则B", role: "user", content: "第二条", enabled: false },
    ]);
    expect(next.activePresetId).toBe("id-1");
    expect(next.presets[0]).toBe(original); // 原预设不动
  });

  it("duplicateAgentPreset：预设不存在时原样返回", () => {
    const next = duplicateAgentPreset(settings(), "nope", sequentialIds());
    expect(next).toEqual(settings());
  });

  it("renameAgentPreset：重命名指定预设", () => {
    const next = renameAgentPreset(settings({ presets: [preset("p1", "旧名")] }), "p1", "新名");
    expect(next.presets[0]!.name).toBe("新名");
  });

  it("renameAgentPreset：预设不存在时原样返回", () => {
    const next = renameAgentPreset(settings(), "nope", "新名");
    expect(next).toEqual(settings());
  });
});

describe("删除与活动预设", () => {
  it("deleteAgentPreset：删除非活动预设不影响活动预设", () => {
    const target = preset("p1", "要删的");
    const active = preset("p2", "活动的");
    const next = deleteAgentPreset(
      settings({ presets: [target, active], activePresetId: "p2" }),
      "p1",
    );
    expect(next.presets.map((p) => p.id)).toEqual(["p2"]);
    expect(next.activePresetId).toBe("p2");
  });

  it("deleteAgentPreset：删除活动预设回退到系统默认", () => {
    const target = preset("p1", "活动的");
    const next = deleteAgentPreset(settings({ presets: [target], activePresetId: "p1" }), "p1");
    expect(next.presets).toEqual([]);
    expect(next.activePresetId).toBe(BUILTIN_AGENT_PRESET_ID);
  });

  it("deleteAgentPreset：预设不存在时原样返回", () => {
    const next = deleteAgentPreset(settings(), "nope");
    expect(next).toEqual(settings());
  });

  it("setActiveAgentPreset：切换到指定预设", () => {
    const next = setActiveAgentPreset(
      settings({ presets: [preset("p1", "一")], activePresetId: BUILTIN_AGENT_PRESET_ID }),
      "p1",
    );
    expect(next.activePresetId).toBe("p1");
  });

  it("setActiveAgentPreset：可以切回系统默认；未知 id 保持原样", () => {
    const s = settings({ presets: [preset("p1", "一")], activePresetId: "p1" });
    expect(setActiveAgentPreset(s, BUILTIN_AGENT_PRESET_ID).activePresetId).toBe(
      BUILTIN_AGENT_PRESET_ID,
    );
    expect(setActiveAgentPreset(s, "nope")).toBe(s);
  });

  it("moveAgentPreset：移动预设到指定索引（越界夹紧），活动预设跟随", () => {
    const s = settings({
      presets: [preset("p1", "一"), preset("p2", "二"), preset("p3", "三")],
      activePresetId: "p3",
    });
    expect(moveAgentPreset(s, "p3", 0).presets.map((p) => p.id)).toEqual(["p3", "p1", "p2"]);
    expect(moveAgentPreset(s, "p1", 99).presets.map((p) => p.id)).toEqual(["p2", "p3", "p1"]);
    expect(moveAgentPreset(s, "p2", -5).presets.map((p) => p.id)).toEqual(["p2", "p1", "p3"]);
    expect(moveAgentPreset(s, "p2", 1)).toBe(s); // 原位
    expect(moveAgentPreset(s, "ghost", 0)).toBe(s);
    expect(moveAgentPreset(s, "p3", 0).activePresetId).toBe("p3");
  });

  it("resolveActivePreset：活动 id 指向用户预设时返回该预设", () => {
    const p = preset("p1", "破限");
    expect(resolveActivePreset(settings({ presets: [p], activePresetId: "p1" }))).toBe(p);
  });

  it("resolveActivePreset：系统默认/未知 id 返回 undefined（宿主用核心默认 composer）", () => {
    expect(resolveActivePreset(settings())).toBeUndefined();
    expect(resolveActivePreset(settings({ activePresetId: "ghost" }))).toBeUndefined();
  });
});

describe("消息操作", () => {
  const s = (): AgentPresetSettings =>
    settings({
      presets: [
        preset("p1", "破限", [
          message("f1", "A", { name: "甲" }),
          message("f2", "B", { enabled: false, name: "乙", role: "user" }),
          message("f3", "C", { name: "丙", role: "assistant" }),
        ]),
      ],
      activePresetId: "p1",
    });

  it("addAgentPresetMessage：追加一条空启用的 system 消息", () => {
    const next = addAgentPresetMessage(s(), "p1", sequentialIds());
    const messages = next.presets[0]!.messages;
    expect(messages).toHaveLength(4);
    expect(messages[3]).toEqual({
      id: "id-1",
      name: "",
      role: "system",
      content: "",
      enabled: true,
    });
  });

  it("removeAgentPresetMessage：删除指定消息", () => {
    const next = removeAgentPresetMessage(s(), "p1", "f2");
    expect(next.presets[0]!.messages.map((m) => m.id)).toEqual(["f1", "f3"]);
  });

  it("updateAgentPresetMessage：部分更新名称/角色/内容/开关", () => {
    const next = updateAgentPresetMessage(s(), "p1", "f1", {
      name: "新名",
      role: "user",
      enabled: false,
    });
    expect(next.presets[0]!.messages[0]).toEqual({
      id: "f1",
      name: "新名",
      role: "user",
      content: "A",
      enabled: false,
    });
  });

  it("updateAgentPresetMessage：预设/消息不存在时原样返回", () => {
    expect(updateAgentPresetMessage(s(), "p1", "ghost", { enabled: false })).toEqual(s());
    expect(updateAgentPresetMessage(s(), "ghost", "f1", { enabled: false })).toEqual(s());
  });

  it("moveAgentPresetMessage：移动到指定索引（0 基），越界索引夹紧", () => {
    expect(
      moveAgentPresetMessage(s(), "p1", "f1", 2).presets[0]!.messages.map((m) => m.id),
    ).toEqual(["f2", "f3", "f1"]);
    expect(
      moveAgentPresetMessage(s(), "p1", "f2", 99).presets[0]!.messages.map((m) => m.id),
    ).toEqual(["f1", "f3", "f2"]);
    expect(
      moveAgentPresetMessage(s(), "p1", "f3", -5).presets[0]!.messages.map((m) => m.id),
    ).toEqual(["f3", "f1", "f2"]);
    // 目标索引 = 当前位置：原样
    expect(moveAgentPresetMessage(s(), "p1", "f2", 1)).toEqual(s());
  });
});

describe("提示词文本与占位符引用", () => {
  it("presetPromptText：启用消息按顺序拼接（空行分隔），停用消息不参与", () => {
    const p = preset("p1", "破限", [
      message("f1", "第一段"),
      message("f2", "第二段（停用）", { enabled: false }),
      message("f3", "第三段"),
    ]);
    expect(presetPromptText(p)).toBe("第一段\n\n第三段");
  });

  it("presetPromptText：空内容消息跳过，全空返回空串", () => {
    const p = preset("p1", "空", [message("f1", ""), message("f2", "   ")]);
    expect(presetPromptText(p)).toBe("");
    expect(presetPromptText(preset("p2", "全空", [message("f1", "")]))).toBe("");
  });

  it("containsDigestReference：任一启用消息含占位符即 true，停用消息不算", () => {
    const withDigest = (content: string) =>
      preset("p1", "x", [message("f1", content), message("f2", "普通")]);
    expect(containsDigestReference(withDigest("看 {{tablesDigest}}"))).toBe(true);
    expect(containsDigestReference(withDigest("用 {{systemDefaultPrompt}} 扩展"))).toBe(true);
    expect(containsDigestReference(withDigest("没有引用"))).toBe(false);
    expect(
      containsDigestReference(
        preset("p2", "x", [
          message("f1", "{{tablesDigest}}", { enabled: false }),
          message("f2", "普通"),
        ]),
      ),
    ).toBe(false);
    expect(containsDigestReference(preset("p3", "无消息", []))).toBe(false);
  });

  it("containsWorldbookReference：启用消息含 {{worldbook}} 即 true，停用消息不算", () => {
    expect(containsWorldbookReference(preset("p1", "x", [message("f1", "看 {{worldbook}}")]))).toBe(
      true,
    );
    expect(containsWorldbookReference(preset("p2", "x", [message("f1", "没有引用")]))).toBe(false);
    expect(
      containsWorldbookReference(
        preset("p3", "x", [
          message("f1", "{{worldbook}}", { enabled: false }),
          message("f2", "普通"),
        ]),
      ),
    ).toBe(false);
    expect(containsWorldbookReference(preset("p4", "无消息", []))).toBe(false);
  });

  it("containsMsgReference：启用消息含 {{msg}} 即 true（用户接管消息编排），停用消息不算", () => {
    expect(containsMsgReference(preset("p1", "x", [message("f1", "总结：{{msg}}")]))).toBe(true);
    expect(containsMsgReference(preset("p2", "x", [message("f1", "没有引用")]))).toBe(false);
    expect(
      containsMsgReference(
        preset("p3", "x", [message("f1", "{{msg}}", { enabled: false }), message("f2", "普通")]),
      ),
    ).toBe(false);
    expect(containsMsgReference(preset("p4", "无消息", []))).toBe(false);
  });
});

describe("导入导出（备份信封模式）", () => {
  it("serializeAgentPresetExport：信封含 format/version/exportedAt/preset（v2 消息模型）", () => {
    const p = preset("p1", "破限", [
      message("f1", "内容"),
      message("f2", "问题", { role: "user" }),
    ]);
    const text = serializeAgentPresetExport(p, "2026-08-11T00:00:00.000Z");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.format).toBe(AGENT_PRESET_EXPORT_FORMAT);
    expect(parsed.version).toBe(AGENT_PRESET_EXPORT_VERSION);
    expect(parsed.exportedAt).toBe("2026-08-11T00:00:00.000Z");
    expect(parsed.preset).toEqual(p);
  });

  it("parseAgentPresetExport：合法信封返回预设", () => {
    const p = preset("p1", "破限", [message("f1", "内容", { role: "user" })]);
    const parsed = parseAgentPresetExport(
      serializeAgentPresetExport(p, "2026-08-11T00:00:00.000Z"),
    );
    expect(parsed).toEqual(p);
  });

  it("parseAgentPresetExport：v1 片段文件按 system 消息迁移（旧行为：全部进系统提示词）", () => {
    const v1 = JSON.stringify({
      format: AGENT_PRESET_EXPORT_FORMAT,
      version: 1,
      exportedAt: "2026-08-11T00:00:00.000Z",
      preset: {
        id: "p1",
        name: "旧预设",
        fragments: [
          { id: "f1", name: "规则A", content: "第一段", enabled: true },
          { id: "f2", name: "", content: "第二段", enabled: false },
        ],
      },
    });
    const parsed = parseAgentPresetExport(v1);
    expect(parsed.messages).toEqual([
      { id: "f1", name: "规则A", role: "system", content: "第一段", enabled: true },
      { id: "f2", name: "", role: "system", content: "第二段", enabled: false },
    ]);
  });

  it("parseAgentPresetExport：非法 JSON / 未知 format / 未知 version / 结构损坏都明确报错", () => {
    expect(() => parseAgentPresetExport("not json")).toThrow(/格式/i);
    expect(() =>
      parseAgentPresetExport(JSON.stringify({ format: "other", version: 2, preset: {} })),
    ).toThrow(/格式/i);
    expect(() =>
      parseAgentPresetExport(
        JSON.stringify({ format: AGENT_PRESET_EXPORT_FORMAT, version: 99, preset: {} }),
      ),
    ).toThrow(/版本/i);
    expect(() =>
      parseAgentPresetExport(
        JSON.stringify({ format: AGENT_PRESET_EXPORT_FORMAT, version: 2, preset: { name: 42 } }),
      ),
    ).toThrow(/结构/i);
    // 非法角色字段拒绝导入
    expect(() =>
      parseAgentPresetExport(
        JSON.stringify({
          format: AGENT_PRESET_EXPORT_FORMAT,
          version: 2,
          preset: {
            name: "x",
            messages: [{ id: "m1", role: "tool", content: "x", enabled: true }],
          },
        }),
      ),
    ).toThrow(/结构/i);
  });

  it("importAgentPreset：追加导入的预设并设为活动；重名自动改名（原名 (2)，继续递增）", () => {
    const imported = preset("imported-1", "破限", [message("f1", "内容")]);
    const s1 = settings({ presets: [preset("p1", "破限")] });
    const next = importAgentPreset(s1, imported);
    expect(next.presets).toHaveLength(2);
    expect(next.presets[1]!.name).toBe("破限 (2)");
    expect(next.presets[1]!.messages).toEqual(imported.messages);
    expect(next.activePresetId).toBe(next.presets[1]!.id);

    const next2 = importAgentPreset(next, { ...imported, id: "imported-2" });
    expect(next2.presets[2]!.name).toBe("破限 (3)");
  });

  it("importAgentPreset：导入 id 冲突时循环重分配（多次导入同一文件不产生重复 id）", () => {
    const s1 = settings({ presets: [preset("imported-1", "别的")] });
    const first = importAgentPreset(s1, preset("imported-1", "破限", [message("f1", "内容")]));
    expect(first.presets[1]!.id).not.toBe("imported-1");
    const second = importAgentPreset(first, preset("imported-1", "破限", [message("f1", "内容")]));
    const ids = second.presets.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length); // 无重复 id
    expect(ids[2]).not.toBe(ids[1]);
  });
});
