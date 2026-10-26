import { describe, expect, it } from "vitest";
import type { MemorySpace, MemorySpaceId } from "../../features/memory/index.ts";
import {
  SYSTEM_TABLE_PRESET_ID,
  type TablePreset,
  type TablePresetSettings,
} from "../../features/table-presets/preset-model.ts";
import { SYSTEM_TABLE_PRESET } from "../../features/table-presets/system-preset.ts";
import {
  BUILTIN_PRESET_READONLY_HINT,
  SAVE_PRESET_HINT,
  commitPresetDraft,
  applyPresetActionLabel,
  applyPresetConfirmText,
  applyPresetConfirmTitle,
  applyPresetUnavailableReason,
  deletePresetConfirmText,
  initializationSourceLabel,
  overwritePresetConfirmText,
  presetPreviewViewModel,
  tablePresetOptions,
  tablePresetRows,
  tablePresetsSummary,
} from "./table-preset-manager-model.ts";

const NOW = "2026-10-18T00:00:00.000Z";

function space(overrides: Partial<MemorySpace> = {}): MemorySpace {
  return {
    id: "space-1" as MemorySpaceId,
    name: "爱丽丝 - story",
    initializationSource: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function userPreset(): TablePreset {
  return {
    id: "p1",
    name: "我的结构",
    description: "两表",
    createdAt: NOW,
    updatedAt: NOW,
    tables: [
      {
        key: "people",
        name: "人物",
        description: "登场角色",
        prompt: "只记人物",
        enabled: true,
        displayStrategy: { type: "field", fieldKey: "name" },
        fields: [
          {
            key: "name",
            name: "名称",
            type: "short_text",
            required: true,
            prompt: "一句话名字",
            enabled: true,
            options: [],
            referenceTableKey: null,
            maxChars: 30,
            valuePattern: "^.+$",
            valuePatternMessage: "不能为空",
          },
          {
            key: "kind",
            name: "类型",
            type: "single_select",
            required: false,
            prompt: "",
            enabled: false,
            options: ["主角", "配角"],
            referenceTableKey: null,
            maxChars: null,
            valuePattern: null,
            valuePatternMessage: null,
          },
        ],
      },
    ],
  };
}

const SETTINGS: TablePresetSettings = {
  userPresets: [userPreset()],
  defaultPresetId: "p1",
};

describe("表格预设设置区模型（spec 6）", () => {
  it("预设库行：系统自带与用户预设、默认标记、表/字段计数", () => {
    const rows = tablePresetRows(SETTINGS, SYSTEM_TABLE_PRESET);
    expect(rows.map((row) => [row.id, row.builtIn, row.isDefault])).toEqual([
      [SYSTEM_TABLE_PRESET_ID, true, false],
      ["storyMemory", true, false],
      ["p1", false, true],
    ]);
    expect(rows[0]!.tableCount).toBe(8);
    expect(rows[0]!.fieldCount).toBe(48);
    expect(rows[2]!.tableCount).toBe(1);
    expect(rows[2]!.fieldCount).toBe(2);
  });

  it("预设选项与摘要：默认预设名展示（无活动空间也可管理）", () => {
    expect(tablePresetOptions(SETTINGS, SYSTEM_TABLE_PRESET).map((option) => option.label)).toEqual(
      ["系统默认（系统自带）", "剧情记忆（系统自带）", "我的结构"],
    );
    expect(tablePresetsSummary(SETTINGS, SYSTEM_TABLE_PRESET)).toBe("1个用户预设 · 默认:我的结构");
    expect(
      tablePresetsSummary(
        { userPresets: [], defaultPresetId: SYSTEM_TABLE_PRESET_ID },
        SYSTEM_TABLE_PRESET,
      ),
    ).toBe("0个用户预设 · 默认:系统默认");
  });

  it("结构预览：说明 + 表名/字段数量 + 字段定义与填写规则详情（spec 6.2）", () => {
    const preview = presetPreviewViewModel(userPreset());
    expect(preview.description).toBe("两表");
    expect(preview.tables[0]).toMatchObject({
      key: "people",
      name: "人物",
      fieldCount: 2,
      description: "登场角色",
      prompt: "只记人物",
    });
    expect(preview.tables[0]!.fields[0]).toEqual({
      key: "name",
      name: "名称",
      typeLabel: "短文本",
      required: true,
      enabled: true,
      prompt: "一句话名字",
      detail: "上限 30 字 · 格式校验：^.+$",
    });
    expect(preview.tables[0]!.fields[1]).toMatchObject({
      typeLabel: "单选",
      enabled: false,
      detail: "选项：主角 / 配角",
    });
  });

  it("初始化来源标签：有来源显示名称快照与时间；无来源不推断（spec 6.2）", () => {
    expect(
      initializationSourceLabel(
        space({
          initializationSource: {
            presetId: SYSTEM_TABLE_PRESET_ID,
            presetName: "系统默认",
            appliedAt: "2026-10-18T12:30:00.000Z",
          },
        }),
      ),
    ).toBe("初始化自：系统默认（2026-10-18 12:30）");
    expect(initializationSourceLabel(space())).toBe("初始化来源未记录");
    expect(initializationSourceLabel(undefined)).toBe("无活动记忆空间");
  });

  it("应用按钮与确认标题：目标 ID 与来源 ID 相同 → 按此预设重新初始化（AC-09）", () => {
    const recorded = space({
      initializationSource: { presetId: "p1", presetName: "我的结构", appliedAt: NOW },
    });
    expect(applyPresetActionLabel(recorded, "p1")).toBe("按此预设重新初始化");
    expect(applyPresetConfirmTitle(recorded, "p1")).toBe("按此预设重新初始化");
    expect(applyPresetActionLabel(recorded, SYSTEM_TABLE_PRESET_ID)).toBe("应用到当前空间");
    expect(applyPresetConfirmTitle(recorded, SYSTEM_TABLE_PRESET_ID)).toBe("应用到当前空间");
    expect(applyPresetActionLabel(space(), "p1")).toBe("应用到当前空间");
    expect(applyPresetActionLabel(undefined, "p1")).toBe("应用到当前空间");
  });

  it("应用确认文案：空间名 + 目标预设名 + 删除范围 + 保留项 + 备份提醒（spec 6.3）", () => {
    const text = applyPresetConfirmText("爱丽丝 - story", "我的结构");
    expect(text).toContain("应用「我的结构」到「爱丽丝 - story」？");
    expect(text).toContain(
      "全部表结构、记录、修订历史、证据、填表任务、同步进度和问答历史将被清空",
    );
    expect(text).toContain("当前对话级宏也将被清除");
    expect(text).toContain("对话文件中的记忆镜像将被覆盖");
    expect(text).toContain("聊天正文、全局设置和预设库保留");
    expect(text).toContain("请先备份当前记忆空间，此操作无法撤销。");
  });

  it("覆盖与删除确认文案：说明默认选择/已空间不受影响", () => {
    expect(overwritePresetConfirmText("我的结构")).toContain("预设 ID 与默认选择保持不变");
    const deleted = deletePresetConfirmText("我的结构", true);
    expect(deleted).toContain("已有记忆空间不会受到影响");
    expect(deleted).toContain("默认选择回到「系统默认」");
    expect(deletePresetConfirmText("其他", false)).not.toContain("默认选择回到");
  });

  it("应用不可用原因与固化文案：插件停用/无活动空间/系统预设只读/另存说明", () => {
    expect(applyPresetUnavailableReason({ pluginEnabled: false, hasActiveSpace: true })).toBe(
      "插件已停用，无法应用预设",
    );
    expect(applyPresetUnavailableReason({ pluginEnabled: true, hasActiveSpace: false })).toBe(
      "当前对话没有活动的记忆空间",
    );
    expect(
      applyPresetUnavailableReason({ pluginEnabled: true, hasActiveSpace: true }),
    ).toBeUndefined();
    expect(BUILTIN_PRESET_READONLY_HINT).toContain("不可删除、重命名或覆盖");
    expect(SAVE_PRESET_HINT).toContain("不包含记录");
  });
});

it("预设编辑实际提交链路在新建、编辑表、改名宏和删除宏时保存完整宏集合", () => {
  const source = userPreset();
  const macro = {
    id: "preset-macro",
    name: "人物宏",
    enabled: true,
    expression: { language: "query" as const, query: { table: "people", fields: ["name"] } },
    output: { format: "json" as const, maxChars: null },
  };
  const draft = { ...source, builtIn: false, macros: [macro] };
  let settings = commitPresetDraft(
    { userPresets: [], defaultPresetId: "systemDefault" },
    draft,
    NOW,
  );
  expect(settings.userPresets[0]?.macros).toEqual([macro]);
  const edited = {
    ...draft,
    tables: draft.tables.map((table) => ({ ...table, description: "编辑后的表说明" })),
    macros: [{ ...macro, name: "改名宏" }],
  };
  settings = commitPresetDraft(settings, edited, NOW);
  expect(settings.userPresets[0]?.tables[0]?.description).toBe("编辑后的表说明");
  expect(settings.userPresets[0]?.macros).toEqual(edited.macros);
  settings = commitPresetDraft(settings, { ...edited, macros: [] }, NOW);
  expect(settings.userPresets[0]?.macros).toEqual([]);
});
