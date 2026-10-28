import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings, type PluginSettings } from "./plugin-settings.ts";

describe("mergeSettings（旧数据/损坏数据补齐默认值，向前兼容）", () => {
  it("旧设置默认十分钟，自定义时限保留，非法时限尽早报错", () => {
    expect(mergeSettings({}).fillAgentTimeoutSeconds).toBe(600);
    expect(mergeSettings({ fillAgentTimeoutSeconds: 300 }).fillAgentTimeoutSeconds).toBe(300);
    expect(mergeSettings({ fillAgentTimeoutSeconds: 900 }).fillAgentTimeoutSeconds).toBe(900);
    for (const seconds of [0, 29, 1801, 1.5, "900"]) {
      expect(() => mergeSettings({ fillAgentTimeoutSeconds: seconds })).toThrow(/30–1800/);
    }
  });
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
  });

  it("已移除的旧 r2 键：读取时不进结果（下一次保存即从宿主设置消失），其他键保留", () => {
    const merged = mergeSettings({
      enabled: true,
      r2: { accountId: "a", accessKeyId: "b", secretAccessKey: "c", bucket: "d" },
      macroName: "{{m}}",
    }) as PluginSettings & { r2?: unknown };
    expect("r2" in merged).toBe(false);
    expect(merged.enabled).toBe(true);
    expect(merged.macroName).toBe("{{m}}");
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
    const merged = mergeSettings({ enabled: "yes", macroName: 7 });
    expect(merged).toEqual(DEFAULT_SETTINGS);
  });

  it("宏上限：非法值（负数/非数/NaN）回退默认 2000，合法值保留", () => {
    expect(mergeSettings({ macroLimit: -1 }).macroLimit).toBe(2000);
    expect(mergeSettings({ macroLimit: "2000" }).macroLimit).toBe(2000);
    expect(mergeSettings({ macroLimit: Number.NaN }).macroLimit).toBe(2000);
    expect(mergeSettings({ macroLimit: 0 }).macroLimit).toBe(0);
    expect(mergeSettings({ macroLimit: 8000 }).macroLimit).toBe(8000);
  });

  it("agentPresets 缺失/损坏：回退默认（空预设列表 + 系统默认活动）", () => {
    expect(mergeSettings({}).agentPresets).toEqual(DEFAULT_SETTINGS.agentPresets);
    expect(mergeSettings({ agentPresets: "oops" }).agentPresets).toEqual(
      DEFAULT_SETTINGS.agentPresets,
    );
    expect(mergeSettings({ agentPresets: [] }).agentPresets).toEqual(DEFAULT_SETTINGS.agentPresets);
  });

  it("agentPresets 合法数据保留；损坏的预设项丢弃，损坏的消息项跳过（预设保留）", () => {
    const raw = {
      agentPresets: {
        presets: [
          {
            id: "p1",
            name: "破限",
            messages: [
              { id: "f1", name: "规则", role: "system", content: "内容", enabled: true },
              { id: "f4", name: "问题", role: "user", content: "问", enabled: true },
            ],
          },
          { id: "p2", name: "坏预设", messages: "oops" },
          {
            id: "p3",
            name: "坏消息",
            messages: [
              { id: "f2", content: 42, enabled: true },
              { id: "f3", name: "好", role: "assistant", content: "好的", enabled: true },
            ],
          },
        ],
        activePresetId: "p1",
      },
    };
    const merged = mergeSettings(raw).agentPresets;
    expect(merged.presets.map((p) => p.id)).toEqual(["p1", "p3"]);
    expect(merged.presets[1]!.messages.map((m) => m.id)).toEqual(["f3"]);
    expect(merged.activePresetId).toBe("p1");
    // 角色字段原样保留
    expect(merged.presets[0]!.messages[1]!.role).toBe("user");
  });

  it("agentPresets 旧版片段（fragments，无角色）按 system 消息迁移；非法角色回退 system", () => {
    const raw = {
      agentPresets: {
        presets: [
          {
            id: "p1",
            name: "旧预设",
            fragments: [{ id: "f1", name: "规则", content: "内容", enabled: true }],
          },
          {
            id: "p2",
            name: "非法角色",
            messages: [{ id: "f2", name: "", role: "tool", content: "x", enabled: true }],
          },
        ],
        activePresetId: "p1",
      },
    };
    const merged = mergeSettings(raw).agentPresets;
    expect(merged.presets[0]!.messages).toEqual([
      { id: "f1", name: "规则", role: "system", content: "内容", enabled: true },
    ]);
    expect(merged.presets[1]!.messages[0]!.role).toBe("system");
  });

  it("agentPresets activePresetId 未知/损坏：回退系统默认", () => {
    expect(mergeSettings({ agentPresets: { activePresetId: "ghost" } }).agentPresets).toEqual(
      DEFAULT_SETTINGS.agentPresets,
    );
    expect(
      mergeSettings({
        agentPresets: { presets: [{ id: "p1", name: "一", messages: [] }], activePresetId: 42 },
      }).agentPresets.activePresetId,
    ).toBe("systemDefault");
    // 活动 id 指向被丢弃的损坏预设 → 回退系统默认
    expect(
      mergeSettings({
        agentPresets: {
          presets: [{ id: "p1", name: "一", messages: "bad" }],
          activePresetId: "p1",
        },
      }).agentPresets.activePresetId,
    ).toBe("systemDefault");
  });

  it("面板入口（entryPlacement）：缺失补默认 top；wand/both 保留；非法值回退 top", () => {
    expect(mergeSettings({}).entryPlacement).toBe("top");
    expect(mergeSettings({ entryPlacement: "wand" }).entryPlacement).toBe("wand");
    expect(mergeSettings({ entryPlacement: "both" }).entryPlacement).toBe("both");
    expect(mergeSettings({ entryPlacement: "left" }).entryPlacement).toBe("top");
    expect(mergeSettings({ entryPlacement: 42 }).entryPlacement).toBe("top");
  });

  it("未知键被丢弃（读取只取已知形状）", () => {
    const merged = mergeSettings({ enabled: true, evil: "x", r2: { hacker: 1 } });
    expect("evil" in merged).toBe(false);
    expect("r2" in merged).toBe(false);
  });

  it("完整合法数据：原样保留", () => {
    const settings: PluginSettings = {
      macroSchemaVersion: 1,
      macros: [],
      rerank: { enabled: false, candidateLimit: 50 },
      fillAgentTimeoutSeconds: 900,
      autoFill: DEFAULT_SETTINGS.autoFill,
      enabled: false,
      macroName: "{{ctx}}",
      macroLimit: 4000,
      mirror: { enabled: false, includeHistory: false },
      agentPresets: {
        presets: [
          {
            id: "p1",
            name: "破限",
            messages: [{ id: "f1", name: "", role: "system", content: "内容", enabled: true }],
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
      cleaningSchemaVersion: 3,
      cleaningRules: [],
      tablePresets: { userPresets: [], defaultPresetId: "systemDefault" },
      entryPlacement: "wand",
    };
    expect(mergeSettings(settings)).toEqual(settings);
  });

  it("旧视图迁移保留有效配置，损坏配置报错并保留原数据", () => {
    const view = {
      name: "未完成伏笔",
      tableKey: "plots",
      condition: null,
      limit: null,
      projection: [],
    };
    const raw = { memoryViews: [view] };
    expect(mergeSettings(raw).macros[0]).toMatchObject({
      name: view.name,
      expression: { query: { table: "plots", limit: 100 } },
    });
    expect(mergeSettings(raw).macros[0]!.id).toBe(mergeSettings(raw).macros[0]!.id);
    expect(() => mergeSettings({ memoryViews: [view, "garbage"] })).toThrow("旧宏定义损坏");
    expect(raw.memoryViews).toEqual([view]);
    expect(mergeSettings(raw)).not.toHaveProperty("memoryViews");
  });

  it("表格预设：缺省系统默认、损坏预设逐项丢弃、默认选择悬空回退系统默认（spec table-presets）", () => {
    expect(mergeSettings({}).tablePresets).toEqual({
      userPresets: [],
      defaultPresetId: "systemDefault",
    });
    const merged = mergeSettings({
      tablePresets: {
        userPresets: [
          { id: "p1", name: "预设", description: "", createdAt: "", updatedAt: "", tables: [] },
          { id: "", name: "无 id", tables: [] },
          "garbage",
        ],
        defaultPresetId: "p1",
      },
    });
    expect(merged.tablePresets.userPresets.map((preset) => preset.id)).toEqual(["p1"]);
    expect(merged.tablePresets.defaultPresetId).toBe("p1");
    // 默认选择指向不存在的预设 → 回退系统自带预设
    expect(
      mergeSettings({ tablePresets: { userPresets: [], defaultPresetId: "ghost" } }).tablePresets
        .defaultPresetId,
    ).toBe("systemDefault");
    expect(mergeSettings({ tablePresets: "oops" }).tablePresets.userPresets).toEqual([]);
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

  it("缺少版本号、v1 和 v2 列表直接丢弃，保留其他设置", () => {
    for (const cleaningSchemaVersion of [undefined, 1, 2]) {
      const result = mergeSettings({
        cleaningSchemaVersion,
        enabled: false,
        macroLimit: 123,
        cleaningRuleLists: [{ id: "old", name: "旧列表", rules: [] }],
      });
      expect(result).toMatchObject({
        cleaningSchemaVersion: 3,
        cleaningRules: [],
        enabled: false,
        macroLimit: 123,
      });
      expect(result).not.toHaveProperty("cleaningRuleLists");
    }
  });
  it("当前版本直接保存命名清洗规则，不包含子规则数组", () => {
    const cleaningRules = [
      {
        id: "r1",
        name: "正文",
        enabled: true,
        keepTags: [{ pre: "<正文>", post: "</正文>" }],
        excludeTags: [],
      },
    ];
    expect(mergeSettings({ cleaningSchemaVersion: 3, cleaningRules }).cleaningRules).toEqual(
      cleaningRules,
    );
  });
});

it("旧设置补齐自动填表默认值，保存后保留显式关闭和 false", () => {
  expect(mergeSettings({}).autoFill).toEqual(DEFAULT_SETTINGS.autoFill);
  expect(
    mergeSettings({ autoFill: { mode: "off", includeCurrent: false, blockSize: 4 } }).autoFill,
  ).toMatchObject({
    mode: "off",
    includeCurrent: false,
    blockSize: 4,
    retries: 2,
    retryDelaySeconds: 10,
  });
  expect(() => mergeSettings({ autoFill: { interval: 0 } })).toThrow("正整数");
});

it("自动隐藏设置兼容旧配置并校验非负保留数", () => {
  expect(mergeSettings({ autoFill: { mode: "auto" } }).autoFill).toMatchObject({
    hideAfterSuccess: false,
    keepRecentFloors: 10,
  });
  expect(
    mergeSettings({ autoFill: { hideAfterSuccess: true, keepRecentFloors: 0 } }).autoFill,
  ).toMatchObject({ hideAfterSuccess: true, keepRecentFloors: 0 });
  for (const keepRecentFloors of [-1, 1.5, "10", null]) {
    expect(() => mergeSettings({ autoFill: { keepRecentFloors } })).toThrow("非负整数");
  }
  expect(() => mergeSettings({ autoFill: { hideAfterSuccess: "true" } })).toThrow("楼层选项无效");
});
