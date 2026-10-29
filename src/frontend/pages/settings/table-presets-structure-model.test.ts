import { describe, expect, it } from "vitest";
import type {
  ResolvedTablePreset,
  TablePresetField,
} from "../../../features/table-presets/preset-model.ts";
import { emptyFieldDraft } from "../../models/memory/field-editor-model.ts";
import {
  fieldFromDraft,
  removeDraftField,
  removeDraftTable,
  replaceDraftField,
  replaceDraftTable,
} from "./table-presets-structure-model.ts";

function preset(): ResolvedTablePreset {
  const field: TablePresetField = {
    key: "name",
    name: "名称",
    type: "short_text",
    required: false,
    enabled: true,
    prompt: "",
    options: [],
    referenceTableKey: null,
    maxChars: null,
    valuePattern: null,
    valuePatternMessage: null,
  };
  return {
    id: "user-preset",
    name: "预设",
    description: "",
    builtIn: false,
    tables: [
      {
        key: "people",
        name: "人物",
        description: "",
        prompt: "",
        enabled: true,
        displayStrategy: { type: "template", template: "人物：{name}" },
        vectorIndex: {
          enabled: true,
          updateMode: "manual",
          groups: [{ key: "core", name: "核心", fieldKeys: ["name"] }],
        },
        fields: [field],
      },
      {
        key: "events",
        name: "事件",
        description: "",
        prompt: "",
        enabled: true,
        displayStrategy: null,
        fields: [
          {
            ...field,
            key: "person",
            name: "人物引用",
            type: "single_reference",
            referenceTableKey: "people",
          },
        ],
      },
    ],
    macros: [
      {
        id: "macro",
        name: "people_list",
        enabled: true,
        expression: {
          language: "query",
          query: {
            table: "people",
            fields: ["name"],
            conditions: [{ field: "name", op: "contains", value: "某" }],
            orderBy: { field: "name", direction: "asc" },
          },
        },
        output: { format: "text", maxChars: null },
      },
    ],
  };
}

describe("preset structure draft edits", () => {
  it("renames a table while preserving cross-table references and structured macro sources", () => {
    const original = preset();
    const next = replaceDraftTable(original, 0, { ...original.tables[0]!, key: "characters" });
    expect(next.tables[1]!.fields[0]!.referenceTableKey).toBe("characters");
    expect(next.macros![0]!.expression).toMatchObject({ query: { table: "characters" } });
    expect(original.tables[0]!.key).toBe("people");
  });
  it("renames a field in display templates vector groups and structured macro columns", () => {
    const original = preset();
    const next = replaceDraftField(original, 0, 0, {
      ...original.tables[0]!.fields[0]!,
      key: "title",
    });
    expect(next.tables[0]!.displayStrategy).toEqual({
      type: "template",
      template: "人物：{title}",
    });
    expect(next.tables[0]!.vectorIndex!.groups[0]!.fieldKeys).toEqual(["title"]);
    expect(next.macros![0]!.expression).toMatchObject({
      query: { fields: ["title"], conditions: [{ field: "title" }], orderBy: { field: "title" } },
    });
  });
  it("rejects deletion of a referenced table before touching the draft", () => {
    const original = preset();
    expect(() => removeDraftTable(original, 0)).toThrow("请先调整引用字段");
    expect(original.tables).toHaveLength(2);
  });
  it("rejects removal of a field still used by display indexing or a macro", () => {
    expect(() => removeDraftField(preset(), 0, 0)).toThrow();
    const original = preset();
    const table = { ...original.tables[0]!, displayStrategy: null, vectorIndex: undefined };
    const withoutDisplay = { ...original, tables: [table, original.tables[1]!] };
    expect(() => removeDraftField(withoutDisplay, 0, 0)).toThrow("people.name");
  });
  it("rejects conflicting table and field keys", () => {
    const original = preset();
    expect(() => replaceDraftTable(original, 0, { ...original.tables[0]!, key: "events" })).toThrow(
      "Key 已存在",
    );
    expect(() =>
      fieldFromDraft(
        {
          ...emptyFieldDraft("short_text"),
          key: "name",
          name: "重复",
          maxChars: "",
          valuePattern: "",
          valuePatternMessage: "",
        },
        original.tables[0]!.fields,
      ),
    ).toThrow("Key 不能重复");
  });
  it("validates text constraints using the domain regex boundary", () => {
    expect(() =>
      fieldFromDraft(
        {
          ...emptyFieldDraft("short_text"),
          key: "value",
          name: "值",
          maxChars: "100",
          valuePattern: "[",
          valuePatternMessage: "",
        },
        [],
      ),
    ).toThrow("合法正则");
  });
  it("permits draft field type changes when its dependencies remain valid", () => {
    const original = preset();
    const next = replaceDraftField(original, 1, 0, {
      ...original.tables[1]!.fields[0]!,
      type: "long_text",
      referenceTableKey: null,
    });
    expect(next.tables[1]!.fields[0]!.type).toBe("long_text");
  });
});
