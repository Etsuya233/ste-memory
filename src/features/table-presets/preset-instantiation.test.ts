import { describe, expect, it, vi } from "vitest";
import type { MemoryFieldId, MemorySpaceId, MemoryTableId } from "../memory/index.ts";
import { instantiateTablePreset } from "./preset-instantiation.ts";
import type { TablePresetStructure } from "./preset-model.ts";
import { SYSTEM_TABLE_PRESET } from "./system-preset.ts";
import { STORY_MEMORY_PRESET } from "./story-memory-preset.ts";
import { captureSpaceStructure } from "./space-structure-capture.ts";
import { validateTablePresetContent } from "./preset-transfer.ts";
import type { MemoryField, MemoryTable } from "../memory/index.ts";

const SPACE = "space-1" as MemorySpaceId;

/** 顺序 id 工厂（测试可读性：table-1 / field-1） */
function idFactory(prefix = "") {
  let tables = 0;
  let fields = 0;
  let groups = 0;
  return {
    table: () => `${prefix}table-${++tables}` as MemoryTableId,
    field: () => `${prefix}field-${++fields}` as MemoryFieldId,
    group: () => `${prefix}group-${++groups}`,
  };
}

describe("预设实例化（spec 4.2 / 10.2）", () => {
  it("剧情记忆实例化启用 7 表 8 组自动索引，捕获时保留预设字段映射", async () => {
    const { tables, fields } = instantiateTablePreset(
      STORY_MEMORY_PRESET,
      SPACE,
      idFactory("story-"),
      "now",
    );
    const indexedTables = tables.filter((table) => table.vectorIndex?.enabled);
    expect(indexedTables.map((table) => table.key)).toEqual([
      "characters",
      "relationships",
      "locations",
      "items",
      "chronicle",
      "important_events",
      "plot_summaries",
    ]);
    const groupIds: string[] = [];
    for (const table of indexedTables) {
      expect(table.vectorIndex).toMatchObject({
        source: "preset",
        updateMode: "automatic",
        groups: [],
      });
      for (const group of table.vectorIndex!.presetGroups!) {
        groupIds.push(group.id);
        for (const fieldId of group.fieldIds) {
          const field = fields.find((candidate) => candidate.id === fieldId)!;
          expect(field.tableId).toBe(table.id);
          expect(field.enabled).toBe(true);
          expect(field.type).not.toBe("datetime");
          expect(field.key).not.toBe("plot_summary");
        }
      }
    }
    expect(groupIds).toHaveLength(8);
    expect(new Set(groupIds).size).toBe(8);
    expect(tables.find((table) => table.key === "story_state")!.vectorIndex).toBeUndefined();

    const captured = await captureSpaceStructure(
      {
        listTables: async () => tables,
        listFields: async (_space, tableId) => fields.filter((field) => field.tableId === tableId),
      },
      SPACE,
    );
    expect(captured.tables.map((table) => table.vectorIndex)).toEqual(
      STORY_MEMORY_PRESET.tables.map((table) => table.vectorIndex),
    );
  });

  it("含向量分组的预设校验和实例化只使用注入的身份工厂", () => {
    const preset = {
      name: SYSTEM_TABLE_PRESET.name,
      description: SYSTEM_TABLE_PRESET.description,
      prompt: SYSTEM_TABLE_PRESET.prompt,
      tables: SYSTEM_TABLE_PRESET.tables.map((table, index) =>
        index === 0
          ? {
              ...table,
              vectorIndex: {
                enabled: true,
                updateMode: "manual" as const,
                groups: [{ name: "人物", fieldKeys: [table.fields[0]!.key] }],
              },
            }
          : table,
      ),
    };
    const nativeId = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      throw new Error("当前上下文没有原生 UUID 生成能力");
    });
    try {
      const validated = validateTablePresetContent(preset);
      const structure = instantiateTablePreset(validated, SPACE, idFactory("host-"), "now");
      expect(structure.tables[0]!.vectorIndex?.presetGroups?.[0]?.id).toBe("host-group-1");
      expect(nativeId).not.toHaveBeenCalled();
    } finally {
      nativeId.mockRestore();
    }
  });

  it("系统自带预设实例化出当前默认的 8 张表与完整规则（AC-02）", () => {
    const { tables, fields } = instantiateTablePreset(
      SYSTEM_TABLE_PRESET,
      SPACE,
      idFactory(),
      "2026-10-18T00:00:00.000Z",
    );
    expect(tables.map((table) => table.key)).toEqual([
      "characters",
      "relationships",
      "locations",
      "items",
      "plots",
      "foreshadowing",
      "todos",
      "story_state",
    ]);
    expect(tables.map((table) => table.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(tables.every((table) => table.enabled && table.memorySpaceId === SPACE)).toBe(true);
    expect(fields).toHaveLength(48);
    expect(fields.every((field) => field.memorySpaceId === SPACE)).toBe(true);

    const characters = tables.find((table) => table.key === "characters")!;
    const relationships = tables.find((table) => table.key === "relationships")!;
    const charactersFields = fields.filter((field) => field.tableId === characters.id);
    expect(charactersFields.map((field) => field.key)).toEqual([
      "name",
      "aliases",
      "role",
      "personality",
      "appearance",
      "background",
      "current_status",
    ]);
    expect(charactersFields.every((field) => field.enabled)).toBe(true);
    // 显示策略：字段策略按字段 Key 映射为新字段 ID
    expect(characters.displayStrategy).toEqual({
      type: "field",
      fieldId: charactersFields[0]!.id,
    });
    // 引用按表 Key 映射为新表 ID
    const relationshipFields = fields.filter((field) => field.tableId === relationships.id);
    expect(relationshipFields.slice(0, 2)).toMatchObject([
      { type: "single_reference", required: true, referenceTableId: characters.id },
      { type: "single_reference", required: true, referenceTableId: characters.id },
    ]);
    // 模板显示策略：占位符按字段 Key 换成新字段 ID
    expect(relationships.displayStrategy).toEqual({
      type: "template",
      template: `{${relationshipFields[0]!.id}} <-> {${relationshipFields[1]!.id}}`,
    });
    // 字段校验规则与选项保持
    const itemStatus = fields.find(
      (field) =>
        field.tableId === tables.find((table) => table.key === "items")!.id &&
        field.key === "status",
    )!;
    expect(itemStatus.options).toEqual(["可用", "已消耗", "已丢失", "已赠出"]);
    const plotTime = fields.find(
      (field) =>
        field.tableId === tables.find((table) => table.key === "plots")!.id &&
        field.key === "time_hint",
    )!;
    expect(plotTime.valuePattern).toContain("20\\d{2}年");
    expect(plotTime.maxChars).toBe(30);
  });

  it("跨表引用与组合显示策略正确映射，且引用局限在新空间内（AC-16）", () => {
    // 两个空间的 ID 工厂各自独立（真实实现为 UUID），实例化结果互不相同
    const first = instantiateTablePreset(SYSTEM_TABLE_PRESET, SPACE, idFactory("a"), "now");
    const second = instantiateTablePreset(
      SYSTEM_TABLE_PRESET,
      "space-2" as MemorySpaceId,
      idFactory("b"),
      "now",
    );
    const firstRelationships = first.tables.find((table) => table.key === "relationships")!;
    const secondRelationships = second.tables.find((table) => table.key === "relationships")!;
    const firstFields = first.fields.filter((field) => field.tableId === firstRelationships.id);
    const secondFields = second.fields.filter((field) => field.tableId === secondRelationships.id);
    expect(firstRelationships.displayStrategy).not.toEqual(secondRelationships.displayStrategy);
    const firstTemplate = (firstRelationships.displayStrategy as { template: string }).template;
    const secondTemplate = (secondRelationships.displayStrategy as { template: string }).template;
    // 模板只引用前两个字段（人物 A / 人物 B）：各自映射到本空间的新字段 ID
    expect(firstTemplate).toBe(`{${firstFields[0]!.id}} <-> {${firstFields[1]!.id}}`);
    expect(secondTemplate).toBe(`{${secondFields[0]!.id}} <-> {${secondFields[1]!.id}}`);
    // 引用目标表 ID 一律属于同一空间
    const firstTableIds = new Set(first.tables.map((table) => table.id));
    for (const field of first.fields) {
      if (field.referenceTableId) expect(firstTableIds.has(field.referenceTableId)).toBe(true);
    }
    const secondTableIds = new Set(second.tables.map((table) => table.id));
    for (const field of second.fields) {
      if (field.referenceTableId) expect(secondTableIds.has(field.referenceTableId)).toBe(true);
    }
  });

  it("停用的表与字段保留启用状态（AC-05）", () => {
    const structure: TablePresetStructure = {
      tables: [
        {
          key: "notes",
          name: "笔记",
          description: "",
          prompt: "",
          enabled: false,
          displayStrategy: null,
          fields: [
            {
              key: "title",
              name: "标题",
              type: "short_text",
              required: false,
              prompt: "",
              enabled: false,
              options: [],
              referenceTableKey: null,
              maxChars: null,
              valuePattern: null,
              valuePatternMessage: null,
            },
          ],
        },
      ],
    };
    const { tables, fields } = instantiateTablePreset(structure, SPACE, idFactory(), "now");
    expect(tables[0]!.enabled).toBe(false);
    expect(fields[0]!.enabled).toBe(false);
  });

  it("预设内容损坏（引用目标表不存在）：实例化抛错，不产出半成品结构", () => {
    const structure: TablePresetStructure = {
      tables: [
        {
          key: "notes",
          name: "笔记",
          description: "",
          prompt: "",
          enabled: true,
          displayStrategy: null,
          fields: [
            {
              key: "owner",
              name: "归属",
              type: "single_reference",
              required: false,
              prompt: "",
              enabled: true,
              options: [],
              referenceTableKey: "missing",
              maxChars: null,
              valuePattern: null,
              valuePatternMessage: null,
            },
          ],
        },
      ],
    };
    expect(() => instantiateTablePreset(structure, SPACE, idFactory(), "now")).toThrowError(
      /引用目标表「missing」不存在/,
    );
  });

  it("显示策略引用不存在或停用字段：实例化抛错（不落不一致结构）", () => {
    const baseTable = {
      key: "notes",
      name: "笔记",
      description: "",
      prompt: "",
      enabled: true,
      fields: [
        {
          key: "title",
          name: "标题",
          type: "short_text" as const,
          required: false,
          prompt: "",
          enabled: true,
          options: [],
          referenceTableKey: null,
          maxChars: null,
          valuePattern: null,
          valuePatternMessage: null,
        },
      ],
    };
    expect(() =>
      instantiateTablePreset(
        { tables: [{ ...baseTable, displayStrategy: { type: "field", fieldKey: "gone" } }] },
        SPACE,
        idFactory(),
        "now",
      ),
    ).toThrowError(/显示字段必须是表内启用的短文本字段/);
    expect(() =>
      instantiateTablePreset(
        {
          tables: [
            {
              ...baseTable,
              fields: [{ ...baseTable.fields[0]!, enabled: false }],
              displayStrategy: { type: "template", template: "{title}" },
            },
          ],
        },
        SPACE,
        idFactory(),
        "now",
      ),
    ).toThrowError(/停用字段/);
    expect(() =>
      instantiateTablePreset(
        { tables: [{ ...baseTable, displayStrategy: { type: "template", template: "{gone}" } }] },
        SPACE,
        idFactory(),
        "now",
      ),
    ).toThrowError(/不存在的字段「gone」/);
  });

  it("结构捕获 → 实例化往返：表、字段、引用与显示策略一致（AC-05 / AC-16）", async () => {
    const { tables, fields } = instantiateTablePreset(
      SYSTEM_TABLE_PRESET,
      SPACE,
      idFactory(),
      "2026-10-18T00:00:00.000Z",
    );
    // 模拟空间改动：停用一张表的一个字段、改表名、加一张自定义表
    const characters = tables.find((table) => table.key === "characters")!;
    const modifiedFields = fields.map((field) =>
      field.tableId === characters.id && field.key === "aliases"
        ? { ...field, enabled: false }
        : field,
    );
    const modifiedTables: readonly MemoryTable[] = [
      ...tables.map((table) =>
        table.key === "characters" ? { ...table, name: "人物档案" } : table,
      ),
      {
        ...tables[0]!,
        id: "custom-table" as MemoryTableId,
        key: "clues" as MemoryTable["key"],
        name: "线索",
        position: 8,
      },
    ];

    const captured = await captureSpaceStructure(
      {
        listTables: async () => modifiedTables,
        listFields: async (_space, tableId) =>
          tableId === ("custom-table" as MemoryTableId)
            ? []
            : (modifiedFields.filter(
                (field) => field.tableId === tableId,
              ) as readonly MemoryField[]),
      },
      SPACE,
    );

    expect(captured.tables).toHaveLength(9);
    expect(captured.tables[0]!.name).toBe("人物档案");
    expect(captured.tables[0]!.fields.find((field) => field.key === "aliases")!.enabled).toBe(
      false,
    );
    expect(captured.tables[1]!.displayStrategy).toEqual({
      type: "template",
      template: "{character_a} <-> {character_b}",
    });
    expect(
      captured.tables
        .find((table) => table.key === "items")!
        .fields.find((field) => field.key === "owner")!.referenceTableKey,
    ).toBe("characters");

    const restored = instantiateTablePreset(
      captured,
      "space-2" as MemorySpaceId,
      idFactory(),
      "now",
    );
    expect(restored.tables.map((table) => table.key)).toEqual([
      ...tables.map((table) => table.key),
      "clues",
    ]);
    expect(restored.tables[0]!.name).toBe("人物档案");
    const restoredRelationships = restored.tables.find((table) => table.key === "relationships")!;
    const restoredRelationshipFields = restored.fields.filter(
      (field) => field.tableId === restoredRelationships.id,
    );
    expect(restoredRelationships.displayStrategy).toEqual({
      type: "template",
      template: `{${restoredRelationshipFields[0]!.id}} <-> {${restoredRelationshipFields[1]!.id}}`,
    });
    const restoredItems = restored.tables.find((table) => table.key === "items")!;
    const restoredOwner = restored.fields.find(
      (field) => field.tableId === restoredItems.id && field.key === "owner",
    )!;
    const restoredCharacters = restored.tables.find((table) => table.key === "characters")!;
    expect(restoredOwner.referenceTableId).toBe(restoredCharacters.id);
  });
});
