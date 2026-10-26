import { describe, expect, it } from "vitest";
import {
  DEFAULT_TABLE_PRESET_SETTINGS,
  mergeTablePresetSettings,
  resolveDefaultTablePreset,
} from "./preset-model.ts";
import { SYSTEM_TABLE_PRESET } from "./system-preset.ts";
import { STORY_MEMORY_PRESET } from "./story-memory-preset.ts";
import {
  importTablePreset,
  parseTablePresetExport,
  serializeTablePresetExport,
} from "./preset-transfer.ts";

const NOW = "2026-10-20T00:00:00.000Z";

describe("表格预设导入导出", () => {
  it("内置预设往返保留通用规则、44 字段、引用和显示策略，文件不带身份与默认选择", () => {
    const text = serializeTablePresetExport(STORY_MEMORY_PRESET, NOW);
    const parsed = parseTablePresetExport(text);
    expect(parsed).toEqual({
      macros: STORY_MEMORY_PRESET.macros,
      name: STORY_MEMORY_PRESET.name,
      description: STORY_MEMORY_PRESET.description,
      prompt: STORY_MEMORY_PRESET.prompt,
      tables: STORY_MEMORY_PRESET.tables,
    });
    expect(parsed.tables.reduce((sum, table) => sum + table.fields.length, 0)).toBe(44);
    expect(JSON.parse(text).preset).not.toHaveProperty("id");
    expect(JSON.parse(text)).not.toHaveProperty("defaultPresetId");
    expect(JSON.parse(text).preset).not.toHaveProperty("records");
  });

  it("重复导入生成不同用户身份与名称，默认选择不变；保存重载后仍保留通用规则", () => {
    const parsed = parseTablePresetExport(serializeTablePresetExport(STORY_MEMORY_PRESET, NOW));
    const first = importTablePreset(DEFAULT_TABLE_PRESET_SETTINGS, SYSTEM_TABLE_PRESET, parsed, {
      id: "import-1",
      now: NOW,
    });
    const second = importTablePreset(first.settings, SYSTEM_TABLE_PRESET, parsed, {
      id: "import-2",
      now: NOW,
    });
    expect(first.preset.name).toBe("剧情记忆 (2)");
    expect(second.preset.name).toBe("剧情记忆 (3)");
    const reloaded = mergeTablePresetSettings(JSON.parse(JSON.stringify(second.settings)));
    expect(reloaded.defaultPresetId).toBe("systemDefault");
    expect(reloaded.userPresets.map((preset) => preset.id)).toEqual(["import-1", "import-2"]);
    expect(reloaded.userPresets[0]!.prompt).toBe(STORY_MEMORY_PRESET.prompt);
  });

  it("旧设置默认选择保持不变，新增内置预设可设默认并在重载后解析", () => {
    const old = mergeTablePresetSettings({ defaultPresetId: "systemDefault", userPresets: [] });
    expect(resolveDefaultTablePreset(old, SYSTEM_TABLE_PRESET).id).toBe("systemDefault");
    const next = mergeTablePresetSettings({ ...old, defaultPresetId: STORY_MEMORY_PRESET.id });
    expect(resolveDefaultTablePreset(next, SYSTEM_TABLE_PRESET)).toBe(STORY_MEMORY_PRESET);
  });

  it.each([
    "未知版本",
    "错误字段类型",
    "重复表 Key",
    "重复字段 Key",
    "引用目标缺失",
    "显示字段缺失",
    "夹带记忆数据",
  ])("%s 时整体拒绝导入", (kind) => {
    const raw = JSON.parse(serializeTablePresetExport(STORY_MEMORY_PRESET, NOW));
    switch (kind) {
      case "未知版本":
        raw.version = 999;
        break;
      case "错误字段类型":
        raw.preset.tables[0].fields[0].type = "unknown";
        break;
      case "重复表 Key":
        raw.preset.tables.push(raw.preset.tables[0]);
        break;
      case "重复字段 Key":
        raw.preset.tables[0].fields.push(raw.preset.tables[0].fields[0]);
        break;
      case "引用目标缺失":
        raw.preset.tables[1].fields[0].referenceTableKey = "missing";
        break;
      case "显示字段缺失":
        raw.preset.tables[0].displayStrategy.fieldKey = "missing";
        break;
      case "夹带记忆数据":
        raw.preset.records = [];
        break;
    }
    expect(() => parseTablePresetExport(JSON.stringify(raw))).toThrow();
  });
});
