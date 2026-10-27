import { describe, expect, it } from "vitest";
import {
  copyMemoryMacros,
  migrateMemoryViews,
  parseMemoryMacros,
  restoredMemoryMacros,
  validateMacroDependencies,
  type MemoryMacro,
} from "./macro-expression.ts";
import { STORY_MEMORY_PRESET } from "../table-presets/story-memory-preset.ts";
import { instantiateTablePreset } from "../table-presets/preset-instantiation.ts";
import {
  parseTablePresetExport,
  serializeTablePresetExport,
} from "../table-presets/preset-transfer.ts";
import { createBackupFile, decodeBackupFile } from "../backup/backup-codec.ts";
import { createChatMirrorFile, decodeChatMirrorFile } from "../chat-mirror/chat-mirror-codec.ts";
import type { MemoryFieldId, MemorySpaceId, MemoryTableId } from "../memory/index.ts";

const semantic: MemoryMacro = {
  id: "semantic-1",
  name: "相关",
  enabled: true,
  expression: {
    language: "query",
    query: {
      table: "chronicle",
      semantic: { groups: ["event_memory"], query: { context: "last_user_message" } },
      fields: ["$similarity"],
      orderBy: { field: "$similarity", direction: "desc" },
      limit: 10,
    },
  },
  output: { format: "json", maxChars: 2000 },
};

describe("宏定义与持久化边界", () => {
  it("拒绝未声明相关度和大小写重复源，损坏集合不丢弃有效部分", () => {
    expect(() =>
      parseMemoryMacros([
        {
          ...semantic,
          expression: { language: "query", query: { table: "chronicle", fields: ["$similarity"] } },
        },
      ]),
    ).toThrow("semantic");
    const source = {
      name: "Scores",
      table: "chronicle",
      groups: ["event_memory"],
      query: { text: "线索" },
    };
    expect(() =>
      parseMemoryMacros([
        {
          ...semantic,
          expression: {
            language: "sql",
            sql: "SELECT 1",
            sources: [source, { ...source, name: "scores" }],
          },
        },
      ]),
    ).toThrow("重复");
    expect(
      parseMemoryMacros([
        {
          ...semantic,
          expression: {
            language: "query",
            query: {
              table: "chronicle",
              conditions: [{ field: "count", op: "in", value: [1, 2, null] }],
            },
          },
        },
      ]),
    ).toHaveLength(1);
    const raw = [semantic, { name: "损坏" }];
    expect(() => parseMemoryMacros(raw)).toThrow("宏定义无效");
    expect(raw).toHaveLength(2);
  });

  it("旧视图幂等转换保留AND in与实际100条上限", () => {
    const view = {
      name: "人物",
      tableKey: "characters",
      condition: { fieldKey: "name", values: ["Alice"] },
      projection: ["name"],
      limit: null,
    };
    const converted = migrateMemoryViews([view], "global");
    expect(converted).toEqual(migrateMemoryViews([view], "global"));
    expect(converted[0]).toMatchObject({
      legacyRendering: true,
      expression: {
        language: "query",
        query: {
          table: "characters",
          limit: 100,
          fields: ["name"],
          conditions: [{ field: "name", op: "in", value: ["Alice"] }],
        },
      },
    });
    expect(() => migrateMemoryViews([view, { ...view, tableKey: 5 }], "global")).toThrow("损坏");
  });

  it("复制产生新身份且仅关闭语义宏，显式恢复保留身份关闭语义", () => {
    const plain = {
      ...semantic,
      id: "plain",
      name: "普通",
      expression: { language: "sql" as const, sql: "SELECT 1" },
    };
    let id = 0;
    const copied = copyMemoryMacros([plain, semantic], () => `new-${++id}`);
    expect(copied.map((macro) => [macro.id, macro.enabled])).toEqual([
      ["new-1", true],
      ["new-2", false],
    ]);
    expect(restoredMemoryMacros([semantic])[0]).toMatchObject({ id: semantic.id, enabled: false });
    expect(semantic.enabled).toBe(true);
  });

  it("预设按Key校验宏依赖，实例化关闭语义宏且每次生成新身份", () => {
    validateMacroDependencies([semantic], STORY_MEMORY_PRESET.tables);
    expect(() =>
      validateMacroDependencies(
        [{ ...semantic, expression: { language: "query", query: { table: "missing" } } }],
        STORY_MEMORY_PRESET.tables,
      ),
    ).toThrow("不存在的表");
    let next = 0;
    const ids = {
      table: () => `table-${++next}` as MemoryTableId,
      field: () => `field-${++next}` as MemoryFieldId,
      group: () => `group-${++next}`,
    };
    const preset = { ...STORY_MEMORY_PRESET, macros: [semantic] };
    const first = instantiateTablePreset(preset, "space" as MemorySpaceId, ids, "now");
    const second = instantiateTablePreset(preset, "space" as MemorySpaceId, ids, "now");
    expect(first.macros[0]!.enabled).toBe(false);
    expect(first.macros[0]!.id).not.toBe(second.macros[0]!.id);
    expect(parseTablePresetExport(serializeTablePresetExport(preset, "now")).macros).toEqual([
      semantic,
    ]);
  });

  it("备份和普通镜像加载保留宏启用态，旧独立视图集合显式迁入空间", () => {
    const unit = {
      space: {
        id: "space" as MemorySpaceId,
        name: "对话",
        initializationSource: null,
        createdAt: "now",
        updatedAt: "now",
        macros: [semantic],
      },
      tables: [],
      fields: [],
      records: [],
      history: [],
      evidence: [],
    };
    const file = createBackupFile({ spaces: [unit] }, "test", "now");
    expect(decodeBackupFile(file).data.spaces[0]!.space.macros).toEqual([semantic]);
    expect(
      decodeChatMirrorFile(createChatMirrorFile(unit, "space", "now", "test"))!.data.space
        .macros![0]!.enabled,
    ).toBe(true);
    const legacy = {
      ...unit,
      space: { ...unit.space, macros: undefined },
      chatScopeMacros: [
        { name: "旧宏", tableKey: "chronicle", condition: null, projection: [], limit: null },
      ],
    };
    const decoded = decodeBackupFile({ ...file, version: 1, data: { spaces: [legacy] } }).data
      .spaces[0]!;
    expect(decoded.space.macros![0]).toMatchObject({
      name: "旧宏",
      expression: { query: { limit: 100 } },
    });
    expect(decoded).not.toHaveProperty("chatScopeMacros");
  });
});
