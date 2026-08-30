import type {
  MemoryField,
  MemoryFieldId,
  MemoryFieldKey,
  MemoryRecord,
  MemoryRecordId,
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
  MemoryTableKey,
} from "@ste-memory/core/memory";
import type { MemorySpaceReader } from "@ste-memory/core/memory/agent";
import { describe, expect, it, vi } from "vitest";
import type { MemoryView } from "../settings/memory-views.ts";
import { BUILTIN_FULL_MACRO, BUILTIN_TABLE_MACRO_PREFIX } from "./chat-scope-macros.ts";
import { MacroRegistry, type MacroRegistryPorts } from "./macro-registry.ts";

const BASE = "2026-07-28T00:00:00.000Z";

function table(id: string, key: string, name: string, enabled = true): MemoryTable {
  return {
    id: id as MemoryTableId,
    memorySpaceId: "space-1" as MemorySpaceId,
    key: key as MemoryTableKey,
    kind: "custom",
    name,
    description: "",
    prompt: "",
    displayStrategy: null,
    enabled,
    createdAt: BASE,
    updatedAt: BASE,
  };
}

function field(id: string, key: string, name: string, enabled = true): MemoryField {
  return {
    id: id as MemoryFieldId,
    memorySpaceId: "space-1" as MemorySpaceId,
    tableId: "table-1" as MemoryTableId,
    key: key as MemoryFieldKey,
    name,
    type: "short_text",
    required: false,
    prompt: "",
    enabled,
    position: 0,
    options: [],
    referenceTableId: null,
    maxChars: null,
    valuePattern: null,
    valuePatternMessage: null,
    createdAt: BASE,
    updatedAt: BASE,
  };
}

function record(id: string, displayText: string, payload: Record<string, unknown> = {}): MemoryRecord {
  return {
    id: id as MemoryRecordId,
    memorySpaceId: "space-1" as MemorySpaceId,
    tableId: "table-1" as MemoryTableId,
    payload: payload as Record<string, never>,
    fieldEvidence: {},
    displayText,
    source: { type: "manual" },
    revisionId: "r" as never,
    revisionSource: "user" as const,
    createdAt: BASE,
    updatedAt: BASE,
  };
}

function createPorts(overrides: Partial<MacroRegistryPorts> = {}): MacroRegistryPorts {
  const tables = [
    table("table-1", "characters", "角色"),
    table("table-2", "events", "事件"),
  ];

  const fields = new Map([
    ["table-1", [field("f1", "name", "姓名"), field("f2", "status", "状态")]],
    ["table-2", [field("f3", "name", "名称"), field("f4", "time", "时间")]],
  ]);

  const records = new Map([
    ["table-1", [record("r1", "张三", { f1: "张三", f2: "活跃" }), record("r2", "李四", { f1: "李四", f2: "退场" })]],
    ["table-2", [record("r3", "初遇", { f3: "初遇", f4: "第1章" })]],
  ]);

  return {
    getSpaceId: () => "space-1" as MemorySpaceId,
    reader: {
      listTables: async () => tables,
      listFields: async (_spaceId, tableId) => fields.get(tableId) ?? [],
      queryRecords: async (_spaceId, input) => {
        const tableRecords = records.get(input.tableId) ?? [];
        return {
          records: tableRecords.slice(0, input.paging.pageSize),
          total: tableRecords.length,
          page: 1,
          pageSize: input.paging.pageSize,
          totalPages: 1,
        };
      },
    },
    data: {
      listTables: async () => tables,
      listRecords: async (_spaceId, tableId) => records.get(tableId) ?? [],
    },
    globalMacros: () => [],
    chatScopeMacros: () => [],
    macroLimit: () => 2000,
    ...overrides,
  };
}

describe("MacroRegistry（宏注册表）", () => {
  it("内置宏：memoryFull + memory_<表Key>", async () => {
    const ports = createPorts();
    const registry = new MacroRegistry(ports);
    await registry.rebuild("space-1" as MemorySpaceId, {
      tables: 2,
      fields: 4,
      records: 3,
      history: 0,
      evidence: 0,
      updatedAt: BASE,
    });

    const macros = registry.getAllMacros();
    const builtinMacros = macros.filter((m) => m.kind === "builtin");
    expect(builtinMacros.length).toBe(3); // memoryFull + memory_characters + memory_events
    expect(builtinMacros.map((m) => m.name)).toContain(BUILTIN_FULL_MACRO);
    expect(builtinMacros.map((m) => m.name)).toContain("memory_characters");
    expect(builtinMacros.map((m) => m.name)).toContain("memory_events");
  });

  it("内置宏 memoryFull 包含所有表数据", async () => {
    const ports = createPorts();
    const registry = new MacroRegistry(ports);
    await registry.rebuild("space-1" as MemorySpaceId, {
      tables: 2,
      fields: 4,
      records: 3,
      history: 0,
      evidence: 0,
      updatedAt: BASE,
    });

    const snapshot = registry.getSnapshot(BUILTIN_FULL_MACRO);
    expect(snapshot).toBeDefined();
    expect(snapshot!).toContain("## 角色");
    expect(snapshot!).toContain("## 事件");
    expect(snapshot!).toContain("张三");
    expect(snapshot!).toContain("初遇");
  });

  it("内置宏 memory_<表Key> 包含单表数据", async () => {
    const ports = createPorts();
    const registry = new MacroRegistry(ports);
    await registry.rebuild("space-1" as MemorySpaceId, {
      tables: 2,
      fields: 4,
      records: 3,
      history: 0,
      evidence: 0,
      updatedAt: BASE,
    });

    const snapshot = registry.getSnapshot("memory_characters");
    expect(snapshot).toBeDefined();
    expect(snapshot!).toContain("## 角色");
    expect(snapshot!).toContain("张三");
    expect(snapshot!).toContain("李四");
    expect(snapshot!).not.toContain("## 事件");
  });

  it("非法表 Key 的内置宏跳过", async () => {
    const ports = createPorts({
      data: {
        listTables: async () => [
          table("table-1", "invalid key with spaces", "无效表"),
        ],
        listRecords: async () => [],
      },
    });
    const registry = new MacroRegistry(ports);
    await registry.rebuild("space-1" as MemorySpaceId, {
      tables: 1,
      fields: 0,
      records: 0,
      history: 0,
      evidence: 0,
      updatedAt: BASE,
    });

    const macros = registry.getAllMacros();
    const builtinMacros = macros.filter((m) => m.kind === "builtin");
    expect(builtinMacros.length).toBe(1); // 只有 memoryFull
    expect(builtinMacros[0]!.name).toBe(BUILTIN_FULL_MACRO);
  });

  it("全局宏注册", async () => {
    const globalView: MemoryView = {
      name: "全局视图",
      tableKey: "characters",
      condition: null,
      limit: 10,
      projection: ["name"],
    };
    const ports = createPorts({ globalMacros: () => [globalView] });
    const registry = new MacroRegistry(ports);
    await registry.rebuild("space-1" as MemorySpaceId, {
      tables: 2,
      fields: 4,
      records: 3,
      history: 0,
      evidence: 0,
      updatedAt: BASE,
    });

    const macros = registry.getAllMacros();
    const globalMacros = macros.filter((m) => m.kind === "global");
    expect(globalMacros.length).toBe(1);
    expect(globalMacros[0]!.name).toBe("全局视图");
  });

  it("聊天 Scope 宏注册", async () => {
    const chatView: MemoryView = {
      name: "聊天视图",
      tableKey: "characters",
      condition: null,
      limit: 5,
      projection: ["name"],
    };
    const ports = createPorts({ chatScopeMacros: () => [chatView] });
    const registry = new MacroRegistry(ports);
    await registry.rebuild("space-1" as MemorySpaceId, {
      tables: 2,
      fields: 4,
      records: 3,
      history: 0,
      evidence: 0,
      updatedAt: BASE,
    });

    const macros = registry.getAllMacros();
    const chatScopeMacros = macros.filter((m) => m.kind === "chat-scope");
    expect(chatScopeMacros.length).toBe(1);
    expect(chatScopeMacros[0]!.name).toBe("聊天视图");
  });

  it("聊天 Scope 宏覆盖全局同名宏", async () => {
    const globalView: MemoryView = {
      name: "同名视图",
      tableKey: "characters",
      condition: null,
      limit: 10,
      projection: ["name"],
    };
    const chatView: MemoryView = {
      name: "同名视图",
      tableKey: "events",
      condition: null,
      limit: 5,
      projection: ["name"],
    };
    const ports = createPorts({ globalMacros: () => [globalView], chatScopeMacros: () => [chatView] });
    const registry = new MacroRegistry(ports);
    await registry.rebuild("space-1" as MemorySpaceId, {
      tables: 2,
      fields: 4,
      records: 3,
      history: 0,
      evidence: 0,
      updatedAt: BASE,
    });

    const macros = registry.getAllMacros();
    const sameNameMacros = macros.filter((m) => m.name === "同名视图");
    expect(sameNameMacros.length).toBe(1);
    expect(sameNameMacros[0]!.kind).toBe("chat-scope");
  });

  it("未变化的重建跳过", async () => {
    const ports = createPorts();
    const registry = new MacroRegistry(ports);
    const fingerprint = {
      tables: 2,
      fields: 4,
      records: 3,
      history: 0,
      evidence: 0,
      updatedAt: BASE,
    };

    await registry.rebuild("space-1" as MemorySpaceId, fingerprint);
    const macros1 = registry.getAllMacros();

    // 重新构建（指纹相同）
    await registry.rebuild("space-1" as MemorySpaceId, fingerprint);
    const macros2 = registry.getAllMacros();

    // 应该返回相同的内容（跳过重建）
    expect(macros1).toStrictEqual(macros2);
  });

  it("重置状态", async () => {
    const ports = createPorts();
    const registry = new MacroRegistry(ports);
    await registry.rebuild("space-1" as MemorySpaceId, {
      tables: 2,
      fields: 4,
      records: 3,
      history: 0,
      evidence: 0,
      updatedAt: BASE,
    });

    expect(registry.getAllMacros().length).toBeGreaterThan(0);

    registry.reset();
    expect(registry.getAllMacros().length).toBe(0);
  });
});
