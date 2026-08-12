/**
 * Agent 提示词预设模型（ticket 17）：预设 CRUD / 片段操作 / 导入导出信封 /
 * digest 引用检测。全部纯函数，settings 不可变更新。
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_PRESET_EXPORT_FORMAT,
  AGENT_PRESET_EXPORT_VERSION,
  BUILTIN_AGENT_PRESET_ID,
  containsDigestReference,
  containsWorldbookReference,
  createAgentPreset,
  deleteAgentPreset,
  duplicateAgentPreset,
  importAgentPreset,
  moveAgentPreset,
  moveAgentPresetFragment,
  parseAgentPresetExport,
  presetPromptText,
  removeAgentPresetFragment,
  renameAgentPreset,
  serializeAgentPresetExport,
  setActiveAgentPreset,
  updateAgentPresetFragment,
  addAgentPresetFragment,
  resolveActivePreset,
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
  fragments: AgentPromptPreset["fragments"] = [],
): AgentPromptPreset {
  return { id, name, fragments };
}

function fragment(
  id: string,
  content: string,
  enabled = true,
  name = "",
): AgentPromptPreset["fragments"][number] {
  return { id, name, content, enabled };
}

describe("创建与复制预设", () => {
  it("createAgentPreset：新建预设含一个空启用片段，并自动设为活动预设", () => {
    const next = createAgentPreset(settings(), "破限", sequentialIds());
    expect(next.presets).toHaveLength(1);
    expect(next.presets[0]).toMatchObject({
      name: "破限",
      fragments: [{ enabled: true, content: "", name: "" }],
    });
    expect(next.activePresetId).toBe(next.presets[0]!.id);
  });

  it("duplicateAgentPreset：复制全部片段与开关状态，命名为「原名 (副本)」，设为活动", () => {
    const original = preset("p1", "轻度破限", [
      fragment("f1", "第一条", true, "规则A"),
      fragment("f2", "第二条", false, "规则B"),
    ]);
    const next = duplicateAgentPreset(settings({ presets: [original] }), "p1", sequentialIds());
    const copy = next.presets.find((p) => p.id === "id-1");
    expect(copy).toBeDefined();
    expect(copy!.name).toBe("轻度破限 (副本)");
    expect(copy!.fragments).toEqual([
      { id: "id-2", name: "规则A", content: "第一条", enabled: true },
      { id: "id-3", name: "规则B", content: "第二条", enabled: false },
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

describe("片段操作", () => {
  const s = (): AgentPresetSettings =>
    settings({
      presets: [
        preset("p1", "破限", [
          fragment("f1", "A", true, "甲"),
          fragment("f2", "B", false, "乙"),
          fragment("f3", "C", true, "丙"),
        ]),
      ],
      activePresetId: "p1",
    });

  it("addAgentPresetFragment：追加一个空启用片段", () => {
    const next = addAgentPresetFragment(s(), "p1", sequentialIds());
    const fragments = next.presets[0]!.fragments;
    expect(fragments).toHaveLength(4);
    expect(fragments[3]).toEqual({ id: "id-1", name: "", content: "", enabled: true });
  });

  it("removeAgentPresetFragment：删除指定片段", () => {
    const next = removeAgentPresetFragment(s(), "p1", "f2");
    expect(next.presets[0]!.fragments.map((f) => f.id)).toEqual(["f1", "f3"]);
  });

  it("updateAgentPresetFragment：部分更新名称/内容/开关", () => {
    const next = updateAgentPresetFragment(s(), "p1", "f1", { name: "新名", enabled: false });
    expect(next.presets[0]!.fragments[0]).toEqual({
      id: "f1",
      name: "新名",
      content: "A",
      enabled: false,
    });
  });

  it("updateAgentPresetFragment：预设/片段不存在时原样返回", () => {
    expect(updateAgentPresetFragment(s(), "p1", "ghost", { enabled: false })).toEqual(s());
    expect(updateAgentPresetFragment(s(), "ghost", "f1", { enabled: false })).toEqual(s());
  });

  it("moveAgentPresetFragment：移动到指定索引（0 基），越界索引夹紧", () => {
    expect(
      moveAgentPresetFragment(s(), "p1", "f1", 2).presets[0]!.fragments.map((f) => f.id),
    ).toEqual(["f2", "f3", "f1"]);
    expect(
      moveAgentPresetFragment(s(), "p1", "f2", 99).presets[0]!.fragments.map((f) => f.id),
    ).toEqual(["f1", "f3", "f2"]);
    expect(
      moveAgentPresetFragment(s(), "p1", "f3", -5).presets[0]!.fragments.map((f) => f.id),
    ).toEqual(["f3", "f1", "f2"]);
    // 目标索引 = 当前位置：原样
    expect(moveAgentPresetFragment(s(), "p1", "f2", 1)).toEqual(s());
  });
});

describe("提示词文本与 digest 引用", () => {
  it("presetPromptText：启用片段按顺序拼接（空行分隔），停用片段不参与", () => {
    const p = preset("p1", "破限", [
      fragment("f1", "第一段", true),
      fragment("f2", "第二段（停用）", false),
      fragment("f3", "第三段", true),
    ]);
    expect(presetPromptText(p)).toBe("第一段\n\n第三段");
  });

  it("presetPromptText：空内容片段跳过，全空返回空串", () => {
    const p = preset("p1", "空", [fragment("f1", ""), fragment("f2", "   ")]);
    expect(presetPromptText(p)).toBe("");
    expect(presetPromptText(preset("p2", "全空", [fragment("f1", "")]))).toBe("");
  });

  it("containsDigestReference：任一启用片段含占位符即 true，停用片段不算", () => {
    const withDigest = (content: string) =>
      preset("p1", "x", [fragment("f1", content, true), fragment("f2", "普通", true)]);
    expect(containsDigestReference(withDigest("看 {{tablesDigest}}"))).toBe(true);
    expect(containsDigestReference(withDigest("用 {{systemDefaultPrompt}} 扩展"))).toBe(true);
    expect(containsDigestReference(withDigest("没有引用"))).toBe(false);
    expect(
      containsDigestReference(
        preset("p2", "x", [
          fragment("f1", "{{tablesDigest}}", false),
          fragment("f2", "普通", true),
        ]),
      ),
    ).toBe(false);
    expect(containsDigestReference(preset("p3", "无片段", []))).toBe(false);
  });

  it("containsWorldbookReference：启用片段含 {{worldbook}} 即 true，停用片段不算", () => {
    expect(
      containsWorldbookReference(preset("p1", "x", [fragment("f1", "看 {{worldbook}}", true)])),
    ).toBe(true);
    expect(containsWorldbookReference(preset("p2", "x", [fragment("f1", "没有引用", true)]))).toBe(
      false,
    );
    expect(
      containsWorldbookReference(
        preset("p3", "x", [fragment("f1", "{{worldbook}}", false), fragment("f2", "普通", true)]),
      ),
    ).toBe(false);
    expect(containsWorldbookReference(preset("p4", "无片段", []))).toBe(false);
  });
});

describe("导入导出（备份信封模式）", () => {
  it("serializeAgentPresetExport：信封含 format/version/exportedAt/preset", () => {
    const p = preset("p1", "破限", [fragment("f1", "内容")]);
    const text = serializeAgentPresetExport(p, "2026-08-11T00:00:00.000Z");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.format).toBe(AGENT_PRESET_EXPORT_FORMAT);
    expect(parsed.version).toBe(AGENT_PRESET_EXPORT_VERSION);
    expect(parsed.exportedAt).toBe("2026-08-11T00:00:00.000Z");
    expect(parsed.preset).toEqual(p);
  });

  it("parseAgentPresetExport：合法信封返回预设", () => {
    const p = preset("p1", "破限", [fragment("f1", "内容")]);
    const parsed = parseAgentPresetExport(
      serializeAgentPresetExport(p, "2026-08-11T00:00:00.000Z"),
    );
    expect(parsed).toEqual(p);
  });

  it("parseAgentPresetExport：非法 JSON / 未知 format / 未知 version / 结构损坏都明确报错", () => {
    expect(() => parseAgentPresetExport("not json")).toThrow(/格式/i);
    expect(() =>
      parseAgentPresetExport(JSON.stringify({ format: "other", version: 1, preset: {} })),
    ).toThrow(/格式/i);
    expect(() =>
      parseAgentPresetExport(
        JSON.stringify({ format: AGENT_PRESET_EXPORT_FORMAT, version: 99, preset: {} }),
      ),
    ).toThrow(/版本/i);
    expect(() =>
      parseAgentPresetExport(
        JSON.stringify({ format: AGENT_PRESET_EXPORT_FORMAT, version: 1, preset: { name: 42 } }),
      ),
    ).toThrow(/结构/i);
  });

  it("importAgentPreset：追加导入的预设并设为活动；重名自动改名（原名 (2)，继续递增）", () => {
    const imported = preset("imported-1", "破限", [fragment("f1", "内容")]);
    const s1 = settings({ presets: [preset("p1", "破限")] });
    const next = importAgentPreset(s1, imported);
    expect(next.presets).toHaveLength(2);
    expect(next.presets[1]!.name).toBe("破限 (2)");
    expect(next.presets[1]!.fragments).toEqual(imported.fragments);
    expect(next.activePresetId).toBe(next.presets[1]!.id);

    const next2 = importAgentPreset(next, { ...imported, id: "imported-2" });
    expect(next2.presets[2]!.name).toBe("破限 (3)");
  });

  it("importAgentPreset：导入 id 冲突时循环重分配（多次导入同一文件不产生重复 id）", () => {
    const s1 = settings({ presets: [preset("imported-1", "别的")] });
    const first = importAgentPreset(s1, preset("imported-1", "破限", [fragment("f1", "内容")]));
    expect(first.presets[1]!.id).not.toBe("imported-1");
    const second = importAgentPreset(first, preset("imported-1", "破限", [fragment("f1", "内容")]));
    const ids = second.presets.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length); // 无重复 id
    expect(ids[2]).not.toBe(ids[1]);
  });
});
