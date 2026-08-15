import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  isR2Configured,
  mergeSettings,
  type PluginSettings,
} from "./plugin-settings.ts";

function r2(overrides: Partial<PluginSettings["r2"]> = {}): PluginSettings["r2"] {
  return { accountId: "", accessKeyId: "", secretAccessKey: "", bucket: "", ...overrides };
}

describe("mergeSettings（旧数据/损坏数据补齐默认值，向前兼容）", () => {
  it("空值与未知形状：整体回退默认值", () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings("oops")).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(42)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings([])).toEqual(DEFAULT_SETTINGS);
  });

  it("部分键缺失：只补缺失的键，已存在的键保留", () => {
    const merged = mergeSettings({ enabled: false });
    expect(merged.enabled).toBe(false);
    expect(merged.macroName).toBe(DEFAULT_SETTINGS.macroName);
    expect(merged.r2).toEqual(DEFAULT_SETTINGS.r2);
  });

  it("嵌套 r2 部分缺失：按字段补默认，不整体覆盖", () => {
    const merged = mergeSettings({ r2: { accountId: "abc", bucket: "mem" } });
    expect(merged.r2.accountId).toBe("abc");
    expect(merged.r2.bucket).toBe("mem");
    expect(merged.r2.accessKeyId).toBe("");
    expect(merged.r2.secretAccessKey).toBe("");
  });

  it("镜像设置缺失/部分缺失：补默认值（旧数据向前兼容）", () => {
    const merged = mergeSettings({ enabled: true });
    expect(merged.mirror).toEqual(DEFAULT_SETTINGS.mirror);
    const partial = mergeSettings({ mirror: { includeHistory: false } });
    expect(partial.mirror.includeHistory).toBe(false);
    expect(partial.mirror.enabled).toBe(true);
    expect(mergeSettings({ mirror: "oops" }).mirror).toEqual(DEFAULT_SETTINGS.mirror);
  });

  it("类型不符的键：回退默认值（损坏数据不崩）", () => {
    const merged = mergeSettings({ enabled: "yes", macroName: 7, r2: "nope" });
    expect(merged).toEqual(DEFAULT_SETTINGS);
  });

  it("宏上限：非法值（负数/非数/NaN）回退默认 2000，合法值保留", () => {
    expect(mergeSettings({ macroLimit: -1 }).macroLimit).toBe(2000);
    expect(mergeSettings({ macroLimit: "2000" }).macroLimit).toBe(2000);
    expect(mergeSettings({ macroLimit: Number.NaN }).macroLimit).toBe(2000);
    expect(mergeSettings({ macroLimit: 0 }).macroLimit).toBe(0);
    expect(mergeSettings({ macroLimit: 8000 }).macroLimit).toBe(8000);
  });

  it("r2 不是对象时整体回退，其余键保留", () => {
    const merged = mergeSettings({ enabled: true, macroName: "{{m}}", r2: ["x"] });
    expect(merged.enabled).toBe(true);
    expect(merged.macroName).toBe("{{m}}");
    expect(merged.r2).toEqual(DEFAULT_SETTINGS.r2);
  });

  it("agentPresets 缺失/损坏：回退默认（空预设列表 + 系统默认活动）", () => {
    expect(mergeSettings({}).agentPresets).toEqual(DEFAULT_SETTINGS.agentPresets);
    expect(mergeSettings({ agentPresets: "oops" }).agentPresets).toEqual(
      DEFAULT_SETTINGS.agentPresets,
    );
    expect(mergeSettings({ agentPresets: [] }).agentPresets).toEqual(DEFAULT_SETTINGS.agentPresets);
  });

  it("agentPresets 合法数据保留；损坏的预设项丢弃，损坏的片段项跳过（预设保留）", () => {
    const raw = {
      agentPresets: {
        presets: [
          {
            id: "p1",
            name: "破限",
            fragments: [{ id: "f1", name: "规则", content: "内容", enabled: true }],
          },
          { id: "p2", name: "坏预设", fragments: "oops" },
          {
            id: "p3",
            name: "坏片段",
            fragments: [
              { id: "f2", content: 42, enabled: true },
              { id: "f3", name: "好", content: "好的", enabled: true },
            ],
          },
        ],
        activePresetId: "p1",
      },
    };
    const merged = mergeSettings(raw).agentPresets;
    expect(merged.presets.map((p) => p.id)).toEqual(["p1", "p3"]);
    expect(merged.presets[1]!.fragments.map((f) => f.id)).toEqual(["f3"]);
    expect(merged.activePresetId).toBe("p1");
  });

  it("agentPresets activePresetId 未知/损坏：回退系统默认", () => {
    expect(mergeSettings({ agentPresets: { activePresetId: "ghost" } }).agentPresets).toEqual(
      DEFAULT_SETTINGS.agentPresets,
    );
    expect(
      mergeSettings({
        agentPresets: { presets: [{ id: "p1", name: "一", fragments: [] }], activePresetId: 42 },
      }).agentPresets.activePresetId,
    ).toBe("systemDefault");
    // 活动 id 指向被丢弃的损坏预设 → 回退系统默认
    expect(
      mergeSettings({
        agentPresets: {
          presets: [{ id: "p1", name: "一", fragments: "bad" }],
          activePresetId: "p1",
        },
      }).agentPresets.activePresetId,
    ).toBe("systemDefault");
  });

  it("未知键被丢弃（读取只取已知形状）", () => {
    const merged = mergeSettings({ enabled: true, evil: "x", r2: { hacker: 1 } });
    expect("evil" in merged).toBe(false);
    expect("hacker" in merged.r2).toBe(false);
  });

  it("完整合法数据：原样保留", () => {
    const settings: PluginSettings = {
      enabled: false,
      r2: r2({ accountId: "a", accessKeyId: "b", secretAccessKey: "c", bucket: "d" }),
      macroName: "{{ctx}}",
      macroLimit: 4000,
      mirror: { enabled: false, includeHistory: false },
      agentPresets: {
        presets: [
          {
            id: "p1",
            name: "破限",
            fragments: [{ id: "f1", name: "", content: "内容", enabled: true }],
          },
        ],
        activePresetId: "p1",
      },
      agentConnections: [
        {
          id: "c1",
          name: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "sk-1",
          model: "deepseek-chat",
        },
      ],
      fillTaskConnectionId: "c1",
      queryChatConnectionId: undefined,
      cleaningRuleLists: [],
    };
    expect(mergeSettings(settings)).toEqual(settings);
  });

  it("Agent 连接（ADR 0010）：损坏项丢弃、悬空选择回退跟随 ST", () => {
    const merged = mergeSettings({
      agentConnections: [
        { id: "c1", name: "好", baseUrl: "https://x", apiKey: "k", model: "m" },
        { id: "c2", name: "坏", baseUrl: 42, apiKey: "k", model: "m" },
        "garbage",
      ],
      fillTaskConnectionId: "c1",
      queryChatConnectionId: "ghost",
    });
    expect(merged.agentConnections.map((c) => c.id)).toEqual(["c1"]);
    expect(merged.fillTaskConnectionId).toBe("c1");
    expect(merged.queryChatConnectionId).toBeUndefined();
    // 缺省：空池 + 跟随 ST
    expect(mergeSettings({}).agentConnections).toEqual([]);
    expect(mergeSettings({}).fillTaskConnectionId).toBeUndefined();
  });

  it("清洗规则列表：缺省空数组，损坏项逐项丢弃（ticket 22）", () => {
    expect(mergeSettings({}).cleaningRuleLists).toEqual([]);
    const merged = mergeSettings({
      cleaningRuleLists: [
        { id: "l1", name: "清洗A", rules: [{ id: "r1", name: "去粗体", mode: "discard", pattern: "\\*\\*", flags: "g", enabled: true }] },
        { id: "", name: "缺 id", rules: [] },
        "junk",
      ],
    });
    expect(merged.cleaningRuleLists).toEqual([
      { id: "l1", name: "清洗A", rules: [{ id: "r1", name: "去粗体", mode: "discard", pattern: "\\*\\*", flags: "g", enabled: true }] },
    ]);
  });
});

describe("isR2Configured（同步状态占位判定）", () => {
  it("全空与部分填写：未配置", () => {
    expect(isR2Configured({ ...DEFAULT_SETTINGS })).toBe(false);
    expect(isR2Configured({ ...DEFAULT_SETTINGS, r2: r2({ accountId: "a" }) })).toBe(false);
  });

  it("四项全填：已配置", () => {
    expect(
      isR2Configured({
        ...DEFAULT_SETTINGS,
        r2: r2({ accountId: "a", accessKeyId: "b", secretAccessKey: "c", bucket: "d" }),
      }),
    ).toBe(true);
  });
});
