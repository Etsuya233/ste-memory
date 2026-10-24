import { describe, expect, it } from "vitest";
import { STORY_MEMORY_PRESET } from "../../features/table-presets/story-memory-preset.ts";
import {
  parseTablePresetExport,
  serializeTablePresetExport,
  validateTablePresetContent,
} from "../../features/table-presets/preset-transfer.ts";
import {
  presetDisplayStrategySummary,
  presetFieldUsedForDisplay,
  renamePresetDisplayField,
  replacePresetTable,
} from "./table-preset-editor-model.ts";

describe("预设编辑的引用与显示策略", () => {
  it("修改目标表 Key 同步更新所有引用，原始预设保持不变", () => {
    const original = STORY_MEMORY_PRESET.tables;
    const target = original.findIndex((t) =>
      original.some((source) => source.fields.some((f) => f.referenceTableKey === t.key)),
    );
    const key = original[target]!.key;
    const tables = replacePresetTable(original, target, {
      ...original[target]!,
      key: "renamed_table",
    });
    expect(tables.some((t) => t.fields.some((f) => f.referenceTableKey === key))).toBe(false);
    expect(tables.some((t) => t.fields.some((f) => f.referenceTableKey === "renamed_table"))).toBe(
      true,
    );
    expect(original[target]!.key).toBe(key);
    const preset = { ...STORY_MEMORY_PRESET, tables };
    expect(() => parseTablePresetExport(serializeTablePresetExport(preset, ""))).not.toThrow();
  });

  it("阻止将表 Key 改成已有 Key", () => {
    const tables = STORY_MEMORY_PRESET.tables;
    expect(() => replacePresetTable(tables, 0, { ...tables[0]!, key: tables[1]!.key })).toThrow(
      "Key 已存在",
    );
  });

  it("显示模板按完整占位符重映射，依赖检查与模板一致", () => {
    const table = {
      ...STORY_MEMORY_PRESET.tables[0]!,
      displayStrategy: { type: "template" as const, template: "{name} / {nickname} / {name}" },
    };
    expect(renamePresetDisplayField(table, "name", "title")).toEqual({
      type: "template",
      template: "{title} / {nickname} / {title}",
    });
    expect(presetFieldUsedForDisplay(table, "name")).toBe(true);
    expect(presetFieldUsedForDisplay(table, "nick")).toBe(false);
    expect(
      renamePresetDisplayField(
        { ...table, displayStrategy: { type: "field", fieldKey: "name" } },
        "name",
        "title",
      ),
    ).toEqual({ type: "field", fieldKey: "title" });
  });

  it("显示策略摘要与表格详情共用同一文案口径", () => {
    const table = STORY_MEMORY_PRESET.tables.find(
      (candidate) => candidate.displayStrategy?.type === "field",
    )!;
    expect(presetDisplayStrategySummary(table)).toMatch(/^显示字段：/);
    expect(presetDisplayStrategySummary({ ...table, displayStrategy: null })).toBe("默认");
    expect(
      presetDisplayStrategySummary({
        ...table,
        displayStrategy: { type: "template", template: "{name} / {nickname}" },
      }),
    ).toBe("显示模板：{name} / {nickname}");
  });

  it("编辑保存时拒绝悬空引用与非法约束", () => {
    const content = { name: "编辑测试", description: "", tables: STORY_MEMORY_PRESET.tables };
    expect(() => validateTablePresetContent(content)).not.toThrow();
    const table = content.tables[0]!;
    const field = table.fields[0]!;
    expect(() =>
      validateTablePresetContent({
        ...content,
        tables: [{ ...table, fields: [{ ...field, maxChars: 0 }] }],
      }),
    ).toThrow();
    expect(() =>
      validateTablePresetContent({
        ...content,
        tables: [
          {
            ...table,
            fields: [{ ...field, type: "single_reference", referenceTableKey: "missing" }],
          },
        ],
      }),
    ).toThrow();
  });
});
