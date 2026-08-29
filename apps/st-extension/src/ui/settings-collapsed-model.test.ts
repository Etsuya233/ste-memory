import { describe, expect, it } from "vitest";
import {
  BUILTIN_AGENT_PRESET_ID,
  type AgentPresetSettings,
} from "../agent-presets/preset-model.ts";
import type { PluginSettings } from "../settings/plugin-settings.ts";
import { DEFAULT_SETTINGS } from "../settings/plugin-settings.ts";
import {
  SETTINGS_COLLAPSED_STORAGE_KEY,
  agentConnectionsSummary,
  agentPresetsSummary,
  cleaningSummary,
  isExpanded,
  loadExpandedGroups,
  macroSummary,
  mirrorSummary,
  parseStoredGroups,
  r2Summary,
  saveExpandedGroups,
  serializeGroups,
  toggleGroup,
} from "./settings-collapsed-model.ts";

function fakeStorage(initial: Record<string, string> = {}): {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  map: Record<string, string>;
} {
  const map = { ...initial };
  return {
    getItem: (k) => map[k] ?? null,
    setItem: (k, v) => {
      map[k] = v;
    },
    map,
  };
}

describe("settings-collapsed-model（折叠持久化）", () => {
  it("空存储 → 空集合（默认全部折叠）", () => {
    expect(loadExpandedGroups(fakeStorage())).toEqual(new Set());
  });

  it("往返：保存后可加载", () => {
    const storage = fakeStorage();
    saveExpandedGroups(storage, new Set(["macro", "r2"]));
    expect(storage.map[SETTINGS_COLLAPSED_STORAGE_KEY]).toBe(JSON.stringify(["macro", "r2"]));
    expect(loadExpandedGroups(storage)).toEqual(new Set(["macro", "r2"]));
  });

  it("损坏 JSON → 空集合", () => {
    const storage = fakeStorage({ [SETTINGS_COLLAPSED_STORAGE_KEY]: "not-json" });
    expect(loadExpandedGroups(storage)).toEqual(new Set());
  });

  it("非数组 → 空集合", () => {
    const storage = fakeStorage({ [SETTINGS_COLLAPSED_STORAGE_KEY]: JSON.stringify({ a: 1 }) });
    expect(loadExpandedGroups(storage)).toEqual(new Set());
  });

  it("未知 key 被丢弃", () => {
    const raw = JSON.stringify(["macro", "unknown", "r2"]);
    expect(parseStoredGroups(raw)).toEqual(new Set(["macro", "r2"]));
  });

  it("toggle：不存在则添加，存在则删除", () => {
    const set = new Set(["macro"] as const);
    expect(toggleGroup(set, "r2")).toEqual(new Set(["macro", "r2"]));
    expect(toggleGroup(new Set(["macro", "r2"]), "macro")).toEqual(new Set(["r2"]));
  });

  it("isExpanded：存在即展开", () => {
    const set = new Set(["macro"] as const);
    expect(isExpanded(set, "macro")).toBe(true);
    expect(isExpanded(set, "r2")).toBe(false);
  });

  it("serializeGroups：数组 JSON", () => {
    expect(serializeGroups(new Set(["macro", "r2"]))).toBe(JSON.stringify(["macro", "r2"]));
  });
});

describe("折叠头摘要", () => {
  it("macroSummary：宏名 + 视图数", () => {
    const settings: PluginSettings = {
      ...DEFAULT_SETTINGS,
      macroName: "{{memoryContext}}",
      memoryViews: [
        { name: "v1", tableKey: "t", conditionFieldKey: "", conditionValues: [], projection: [], limit: undefined } as never,
      ],
    };
    expect(macroSummary(settings)).toBe("{{memoryContext}} · 1视图");
  });

  it("macroSummary：空宏名 → 未配置", () => {
    const settings = { ...DEFAULT_SETTINGS, macroName: "  ", memoryViews: [] } as PluginSettings;
    expect(macroSummary(settings)).toBe("未配置 · 0视图");
  });

  it("agentConnectionsSummary：未配置", () => {
    expect(agentConnectionsSummary(DEFAULT_SETTINGS)).toBe("未配置 · 跟随 ST 当前连接");
  });

  it("agentConnectionsSummary：有连接 + 选中", () => {
    const settings: PluginSettings = {
      ...DEFAULT_SETTINGS,
      agentConnections: [
        { id: "c1", name: "Conn1", baseUrl: "http://a", apiKey: "", model: "m1" },
        { id: "c2", name: "Conn2", baseUrl: "http://b", apiKey: "", model: "m2" },
      ],
      fillTaskConnectionId: "c1",
      queryChatConnectionId: undefined,
    };
    expect(agentConnectionsSummary(settings)).toBe("2个 · 填表:Conn1 · 查询:跟随 ST 当前连接");
  });

  it("agentPresetsSummary：系统默认", () => {
    const settings: PluginSettings = {
      ...DEFAULT_SETTINGS,
      agentPresets: { presets: [], activePresetId: BUILTIN_AGENT_PRESET_ID } as AgentPresetSettings,
    };
    expect(agentPresetsSummary(settings)).toBe("0个 · 当前:系统默认");
  });

  it("agentPresetsSummary：自定义活动", () => {
    const settings: PluginSettings = {
      ...DEFAULT_SETTINGS,
      agentPresets: {
        presets: [{ id: "p1", name: "我的预设", messages: [] }],
        activePresetId: "p1",
      } as AgentPresetSettings,
    };
    expect(agentPresetsSummary(settings)).toBe("1个 · 当前:我的预设");
  });

  it("cleaningSummary：未配置", () => {
    expect(cleaningSummary(DEFAULT_SETTINGS, undefined)).toBe("未配置");
  });

  it("cleaningSummary：有列表 + 选中", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      cleaningRuleLists: [{ id: "l1", name: "我的列表", rules: [] }],
    } as unknown as PluginSettings;
    expect(cleaningSummary(settings, "l1")).toBe("1列表 · 当前:我的列表");
    expect(cleaningSummary(settings, undefined)).toBe("1列表 · 未选择");
  });

  it("mirrorSummary：停用", () => {
    const settings = { ...DEFAULT_SETTINGS, mirror: { enabled: false, includeHistory: true } } as PluginSettings;
    expect(mirrorSummary(settings, { kind: "idle", lastWrittenAt: undefined, sizeBytes: undefined })).toBe(
      "已停用",
    );
  });

  it("r2Summary：未配置", () => {
    expect(r2Summary(DEFAULT_SETTINGS, { kind: "unconfigured" })).toBe("未配置");
  });

  it("r2Summary：已配置返回 syncStatusSummary", () => {
    const settings: PluginSettings = {
      ...DEFAULT_SETTINGS,
      r2: { accountId: "a", accessKeyId: "b", secretAccessKey: "c", bucket: "d" },
    };
    expect(r2Summary(settings, { kind: "syncing" })).toBe("同步中…");
  });
});
