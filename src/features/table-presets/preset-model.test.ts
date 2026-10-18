import { describe, expect, it } from "vitest";
import type { MemoryFieldType } from "../memory/index.ts";
import {
  DEFAULT_TABLE_PRESET_SETTINGS,
  SYSTEM_TABLE_PRESET_ID,
  SYSTEM_TABLE_PRESET_NAME,
  listTablePresets,
  mergeTablePresetSettings,
  resolveDefaultTablePreset,
  resolveTablePreset,
  tablePresetName,
  tablePresetNameAvailable,
  type TablePreset,
  type TablePresetSettings,
  type TablePresetStructure,
} from "./preset-model.ts";
import {
  copyTablePresetAsUserPreset,
  deleteUserTablePreset,
  overwriteUserTablePreset,
  renameUserTablePreset,
  saveUserTablePreset,
  setDefaultTablePreset,
} from "./table-preset-library.ts";
import { SYSTEM_TABLE_PRESET } from "./system-preset.ts";

const NOW = "2026-10-18T00:00:00.000Z";

/** 最小结构：一张表 + 一个短文本字段（库操作测试用）。 */
function structure(tableKey = "notes", fieldKey: string = "title"): TablePresetStructure {
  return {
    tables: [
      {
        key: tableKey,
        name: "笔记",
        description: "记录",
        prompt: "只记录要点",
        enabled: true,
        displayStrategy: { type: "field", fieldKey },
        fields: [
          {
            key: fieldKey,
            name: "标题",
            type: "short_text" as MemoryFieldType,
            required: true,
            prompt: "",
            enabled: true,
            options: [],
            referenceTableKey: null,
            maxChars: 30,
            valuePattern: null,
            valuePatternMessage: null,
          },
        ],
      },
    ],
  };
}

function userPreset(id: string, name: string): TablePreset {
  return { id, name, description: "", createdAt: NOW, updatedAt: NOW, ...structure() };
}

function settingsWith(...presets: TablePreset[]): TablePresetSettings {
  return { userPresets: presets, defaultPresetId: presets[0]?.id ?? SYSTEM_TABLE_PRESET_ID };
}

describe("表格预设模型（spec 表格预设）", () => {
  it("默认设置：无用户预设、默认选择系统自带预设（AC-01）", () => {
    expect(DEFAULT_TABLE_PRESET_SETTINGS).toEqual({
      userPresets: [],
      defaultPresetId: SYSTEM_TABLE_PRESET_ID,
    });
    expect(SYSTEM_TABLE_PRESET.builtIn).toBe(true);
    expect(SYSTEM_TABLE_PRESET.name).toBe(SYSTEM_TABLE_PRESET_NAME);
  });

  it("预设库列表恒含系统自带预设（在首位），用户预设附在其后", () => {
    const presets = listTablePresets(
      settingsWith(userPreset("p1", "我的结构")),
      SYSTEM_TABLE_PRESET,
    );
    expect(presets.map((preset) => [preset.id, preset.builtIn])).toEqual([
      [SYSTEM_TABLE_PRESET_ID, true],
      ["p1", false],
    ]);
  });

  it("按 ID 解析预设：命中用户预设 / 系统预设 / 未知 ID 明确报错", () => {
    const settings = settingsWith(userPreset("p1", "我的结构"));
    expect(resolveTablePreset(settings, SYSTEM_TABLE_PRESET, "p1").name).toBe("我的结构");
    expect(resolveTablePreset(settings, SYSTEM_TABLE_PRESET, SYSTEM_TABLE_PRESET_ID).builtIn).toBe(
      true,
    );
    expect(() => resolveTablePreset(settings, SYSTEM_TABLE_PRESET, "gone")).toThrowError(
      /预设不存在/,
    );
    expect(resolveDefaultTablePreset(settings, SYSTEM_TABLE_PRESET).id).toBe("p1");
  });

  it("名称规范：去空白非空、超长拒绝、系统自带预设名称保留、库内唯一", () => {
    expect(tablePresetName("  我的结构  ")).toBe("我的结构");
    expect(() => tablePresetName("   ")).toThrowError(/名称不能为空/);
    expect(() => tablePresetName("x".repeat(121))).toThrowError(/120/);
    expect(() => tablePresetName(SYSTEM_TABLE_PRESET_NAME)).toThrowError(/系统自带预设名称/);
    expect(tablePresetNameAvailable([userPreset("p1", "重名")], "重名")).toBe(false);
    expect(tablePresetNameAvailable([userPreset("p1", "重名")], "重名", "p1")).toBe(true);
    expect(tablePresetNameAvailable([userPreset("p1", "重名")], "其他")).toBe(true);
  });

  it("合并持久化设置：损坏项逐项丢弃，默认选择指向不存在预设时回退系统默认", () => {
    const merged = mergeTablePresetSettings({
      userPresets: [
        { id: "", name: "无 id" },
        { id: "p1", name: "可用", tables: structure().tables },
        { id: "p2", name: "坏表", tables: [{ key: "", name: "x", fields: [] }] },
        { id: "p3", name: "缺表" },
      ],
      defaultPresetId: "gone",
    });
    expect(merged.userPresets.map((preset) => preset.id)).toEqual(["p1", "p2"]);
    expect(merged.defaultPresetId).toBe(SYSTEM_TABLE_PRESET_ID);
  });

  it("合并持久化设置：显示策略字段 Key 不在表内时按无策略合并，模板策略原样保留", () => {
    const merged = mergeTablePresetSettings({
      userPresets: [
        {
          id: "p1",
          name: "预设",
          tables: [
            {
              ...structure().tables[0]!,
              displayStrategy: { type: "field", fieldKey: "gone" },
            },
            {
              ...structure("other").tables[0]!,
              displayStrategy: { type: "template", template: "{title} / {other}" },
            },
          ],
        },
      ],
      defaultPresetId: "p1",
    });
    expect(merged.userPresets[0]!.tables[0]!.displayStrategy).toBeNull();
    expect(merged.userPresets[0]!.tables[1]!.displayStrategy).toEqual({
      type: "template",
      template: "{title} / {other}",
    });
  });
});

describe("预设库操作（spec 5）", () => {
  it("另存当前结构：新建用户预设，不改默认选择、不覆盖已有预设（AC-05）", () => {
    const settings = settingsWith(userPreset("p1", "我的结构"));
    const { settings: next, preset } = saveUserTablePreset(settings, {
      id: "p2",
      name: "  第二份  ",
      description: "  说明  ",
      structure: structure("extra", "label"),
      now: NOW,
    });
    expect(next.userPresets.map((item) => item.id)).toEqual(["p1", "p2"]);
    expect(next.userPresets.map((item) => item.name)).toEqual(["我的结构", "第二份"]);
    expect(preset.description).toBe("说明");
    expect(preset.createdAt).toBe(NOW);
    expect(next.defaultPresetId).toBe("p1");
  });

  it("另存时重名 / 空名 / 系统自带预设名被拒（spec 5.1）", () => {
    const settings = settingsWith(userPreset("p1", "我的结构"));
    const base = { id: "p2", description: "", structure: structure(), now: NOW };
    expect(() => saveUserTablePreset(settings, { ...base, name: "我的结构" })).toThrowError(/同名/);
    expect(() => saveUserTablePreset(settings, { ...base, name: " " })).toThrowError(/不能为空/);
    expect(() =>
      saveUserTablePreset(settings, { ...base, name: SYSTEM_TABLE_PRESET_NAME }),
    ).toThrowError(/系统自带预设名称/);
  });

  it("重命名与覆盖：预设 ID 与默认选择保持，结构内容替换（AC-06）", () => {
    const settings = settingsWith(userPreset("p1", "旧名"));
    const renamed = renameUserTablePreset(settings, "p1", {
      name: "新名",
      description: "改过",
      now: NOW,
    });
    expect(renamed.userPresets[0]).toMatchObject({
      id: "p1",
      name: "新名",
      description: "改过",
    });
    expect(renamed.defaultPresetId).toBe("p1");

    const overwritten = overwriteUserTablePreset(settings, "p1", {
      structure: structure("other", "label"),
      now: NOW,
    });
    expect(overwritten.userPresets[0]!.id).toBe("p1");
    expect(overwritten.userPresets[0]!.tables[0]!.key).toBe("other");
    expect(overwritten.defaultPresetId).toBe("p1");
  });

  it("系统自带预设不可重命名、覆盖或删除（AC-01）", () => {
    const settings = settingsWith(userPreset("p1", "我的结构"));
    expect(() =>
      renameUserTablePreset(settings, SYSTEM_TABLE_PRESET_ID, {
        name: "改名",
        description: "",
        now: NOW,
      }),
    ).toThrowError(/系统自带预设/);
    expect(() =>
      overwriteUserTablePreset(settings, SYSTEM_TABLE_PRESET_ID, {
        structure: structure(),
        now: NOW,
      }),
    ).toThrowError(/系统自带预设/);
    expect(() => deleteUserTablePreset(settings, SYSTEM_TABLE_PRESET_ID)).toThrowError(
      /系统自带预设/,
    );
  });

  it("删除默认用户预设：同一设置更新把默认选择改为系统默认（AC-04）", () => {
    const settings: TablePresetSettings = {
      userPresets: [userPreset("p1", "我的结构"), userPreset("p2", "另一份")],
      defaultPresetId: "p2",
    };
    const next = deleteUserTablePreset(settings, "p2");
    expect(next.userPresets.map((preset) => preset.id)).toEqual(["p1"]);
    expect(next.defaultPresetId).toBe(SYSTEM_TABLE_PRESET_ID);

    // 删除非默认预设：默认选择不变
    const keepDefault = deleteUserTablePreset(settings, "p1");
    expect(keepDefault.defaultPresetId).toBe("p2");
  });

  it("复制预设：生成内容一致的新用户预设，默认选择不变", () => {
    const settings = settingsWith(userPreset("p1", "我的结构"));
    const { settings: next, preset } = copyTablePresetAsUserPreset(settings, SYSTEM_TABLE_PRESET, {
      id: "p2",
      now: NOW,
    });
    expect(preset.name).toBe("系统默认 副本");
    expect(preset.tables).toEqual(SYSTEM_TABLE_PRESET.tables);
    expect(next.defaultPresetId).toBe("p1");

    const explicit = copyTablePresetAsUserPreset(settings, SYSTEM_TABLE_PRESET, {
      id: "p3",
      name: "我的系统结构",
      now: NOW,
    });
    expect(explicit.preset.name).toBe("我的系统结构");
  });

  it("设置新空间默认预设：命中系统预设或用户预设；未知 ID 被拒（AC-03）", () => {
    const settings = settingsWith(userPreset("p1", "我的结构"));
    expect(setDefaultTablePreset(settings, SYSTEM_TABLE_PRESET, "p1").defaultPresetId).toBe("p1");
    expect(
      setDefaultTablePreset(settings, SYSTEM_TABLE_PRESET, SYSTEM_TABLE_PRESET_ID).defaultPresetId,
    ).toBe(SYSTEM_TABLE_PRESET_ID);
    expect(() => setDefaultTablePreset(settings, SYSTEM_TABLE_PRESET, "gone")).toThrowError(
      /预设不存在/,
    );
  });
});
