/**
 * 宏注册表（双 Scope 宏系统，Phase 2）：
 *
 * - 管理三种作用域的宏：内置宏（memoryFull + memory_<表Key>）、全局宏、聊天 Scope 宏；
 * - 名称全局唯一，优先级：内置 > 聊天 Scope > 全局（聊天 Scope 可覆盖全局同名宏）；
 * - 内置宏动态计算（根据当前空间的表结构生成）；
 * - 聊天 Scope 宏存储在 chatMetadata，随 .jsonl 导入导出。
 */
import type { MemoryFieldValue, MemorySpaceId, MemoryTable, MemoryTableId } from "@ste-memory/core/memory";
import type { MemorySpaceReader } from "@ste-memory/core/memory/agent";
import { buildMemorySpaceTableDigest } from "@ste-memory/core/memory/agent";
import type { MemoryView } from "../settings/memory-views.ts";
import {
  BUILTIN_FULL_MACRO,
  BUILTIN_TABLE_MACRO_PREFIX,
  isBuiltinMacroName,
} from "./chat-scope-macros.ts";
import { renderMemoryFullSnapshot, type MemoryFullRenderInput } from "./memory-view-render.ts";
import { createReadTimeDisplayTextResolver } from "@ste-memory/core/memory";

/** 宏定义（统一表示三种作用域的宏） */
export interface MacroDefinition {
  /** 宏名（裸标识符，ST 注册名） */
  readonly name: string;
  /** 宏类型 */
  readonly kind: "builtin" | "global" | "chat-scope";
  /** 快照文本（预计算） */
  snapshot: string;
}

/** 可变数组类型 */
type Mutable<T> = T extends readonly (infer U)[] ? U[] : T;

/** 宏注册表端口 */
export interface MacroRegistryPorts {
  /** 当前活动记忆空间 */
  getSpaceId(): MemorySpaceId | undefined;
  /** 记忆空间只读端口 */
  readonly reader: MemorySpaceReader;
  /** 数据端口（读取表和记录） */
  readonly data: {
    listTables(memorySpaceId: MemorySpaceId): Promise<readonly MemoryTable[]>;
    listRecords(
      memorySpaceId: MemorySpaceId,
      tableId: MemoryTableId,
    ): Promise<readonly import("@ste-memory/core/memory").MemoryRecord[]>;
  };
  /** 全局宏定义 */
  readonly globalMacros: readonly MemoryView[];
  /** 聊天 Scope 宏定义 */
  readonly chatScopeMacros: readonly MemoryView[];
  /** 全局字符上限 */
  readonly macroLimit: number;
  /** 可选日志 */
  readonly log?: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

/**
 * 宏注册表：管理所有宏的注册、快照计算和名称冲突处理。
 * 这是一个纯逻辑层，不直接与 ST 宏引擎交互。
 */
export class MacroRegistry {
  readonly #ports: MacroRegistryPorts;
  /** 已注册的宏（name → definition） */
  #macros = new Map<string, MacroDefinition>();
  /** 最近一次重建时的空间与指纹 */
  #lastSpaceId: MemorySpaceId | undefined;
  #lastFingerprint: import("../cloud/space-fingerprint.ts").SpaceFingerprint | undefined;
  #lastGlobalSignature: string | undefined;
  #lastChatScopeSignature: string | undefined;

  constructor(ports: MacroRegistryPorts) {
    this.#ports = ports;
  }

  /** 获取所有宏（按优先级排序：内置 > 聊天 Scope > 全局） */
  getAllMacros(): readonly MacroDefinition[] {
    return Array.from(this.#macros.values());
  }

  /** 获取指定宏的快照 */
  getSnapshot(name: string): string | undefined {
    return this.#macros.get(name)?.snapshot;
  }

  /**
   * 重建所有宏的快照。
   * @param fingerprint 空间变更指纹（用于跳过未变化的重建）
   */
  async rebuild(
    spaceId: MemorySpaceId,
    fingerprint: import("../cloud/space-fingerprint.ts").SpaceFingerprint,
  ): Promise<void> {
    const globalSignature = JSON.stringify(this.#ports.globalMacros);
    const chatScopeSignature = JSON.stringify(this.#ports.chatScopeMacros);

    // 跳过未变化的重建
    if (
      spaceId === this.#lastSpaceId &&
      this.#lastFingerprint !== undefined &&
      this.#lastFingerprint.tables === fingerprint.tables &&
      this.#lastFingerprint.fields === fingerprint.fields &&
      this.#lastFingerprint.records === fingerprint.records &&
      this.#lastFingerprint.history === fingerprint.history &&
      this.#lastFingerprint.evidence === fingerprint.evidence &&
      this.#lastFingerprint.updatedAt === fingerprint.updatedAt &&
      this.#lastGlobalSignature === globalSignature &&
      this.#lastChatScopeSignature === chatScopeSignature
    ) {
      return;
    }

    const newMacros = new Map<string, MacroDefinition>();

    // 1. 内置宏（最低优先级）
    await this.#rebuildBuiltinMacros(spaceId, newMacros);

    // 2. 全局宏（可覆盖内置同名宏，但用户不太会用 memory_ 前缀）
    this.#rebuildGlobalMacros(newMacros);

    // 3. 聊天 Scope 宏（最高优先级，可覆盖全局同名宏）
    this.#rebuildChatScopeMacros(newMacros);

    this.#macros = newMacros;
    this.#lastSpaceId = spaceId;
    this.#lastFingerprint = fingerprint;
    this.#lastGlobalSignature = globalSignature;
    this.#lastChatScopeSignature = chatScopeSignature;
  }

  /** 重置状态（插件停用/无活动空间时调用） */
  reset(): void {
    this.#macros.clear();
    this.#lastSpaceId = undefined;
    this.#lastFingerprint = undefined;
    this.#lastGlobalSignature = undefined;
    this.#lastChatScopeSignature = undefined;
  }

  /** 重建内置宏（memoryFull + memory_<表Key>） */
  async #rebuildBuiltinMacros(
    spaceId: MemorySpaceId,
    macros: Map<string, MacroDefinition>,
  ): Promise<void> {
    try {
      const tables = await this.#ports.data.listTables(spaceId);
      const enabledTables = tables.filter((t) => t.enabled);

      // 重建 memoryFull 快照
      const fullSnapshot = await this.#buildMemoryFullSnapshot(spaceId, enabledTables);
      macros.set(BUILTIN_FULL_MACRO, {
        name: BUILTIN_FULL_MACRO,
        kind: "builtin",
        snapshot: fullSnapshot,
      });

      // 重建 memory_<表Key> 宏
      for (const table of enabledTables) {
        const macroName = `${BUILTIN_TABLE_MACRO_PREFIX}${table.key}`;
        // 检查表 Key 是否为合法 ST 宏标识符
        if (!/^[a-zA-Z][A-Za-z0-9_-]*$/.test(macroName)) {
          this.#ports.log?.warn(
            `内置表宏「${macroName}」表 Key 不符合 ST 标识符规则，跳过注册`,
          );
          continue;
        }
        const tableSnapshot = await this.#buildTableSnapshot(spaceId, table);
        macros.set(macroName, {
          name: macroName,
          kind: "builtin",
          snapshot: tableSnapshot,
        });
      }
    } catch (error) {
      this.#ports.log?.error(
        `内置宏快照重建失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 构建 memoryFull 快照 */
  async #buildMemoryFullSnapshot(
    spaceId: MemorySpaceId,
    tables: readonly MemoryTable[],
  ): Promise<string> {
    const resolveDisplay = createReadTimeDisplayTextResolver({
      getTable: async (tableId) => tables.find((candidate) => candidate.id === tableId),
      getFields: (tableId) => this.#ports.reader.listFields(spaceId, tableId),
      findRecord: async (tableId, recordId) => {
        const records = await this.#ports.data.listRecords(spaceId, tableId);
        return records.find((candidate) => candidate.id === recordId);
      },
    });

    const tableInputs: Mutable<MemoryFullRenderInput["tables"]> = [];
    for (const table of tables) {
      const fields = await this.#ports.reader.listFields(spaceId, table.id);
      const enabledFields = fields.filter((f) => f.enabled);
      const records = await this.#ports.data.listRecords(spaceId, table.id);
      const recordsWithDisplay = await Promise.all(
        records.map(async (record) => ({
          payload: new Map(Object.entries(record.payload)),
          displayText: await resolveDisplay(record),
        })),
      );
      tableInputs.push({
        name: table.name,
        fields: enabledFields.map((f) => ({ name: f.name, id: f.id })),
        records: recordsWithDisplay,
      });
    }

    return renderMemoryFullSnapshot({
      tables: tableInputs,
      limit: this.#ports.macroLimit,
    });
  }

  /** 构建单表 memory_<表Key> 快照 */
  async #buildTableSnapshot(
    spaceId: MemorySpaceId,
    table: MemoryTable,
  ): Promise<string> {
    const fields = await this.#ports.reader.listFields(spaceId, table.id);
    const enabledFields = fields.filter((f) => f.enabled);
    const records = await this.#ports.data.listRecords(spaceId, table.id);

    const resolveDisplay = createReadTimeDisplayTextResolver({
      getTable: async () => table,
      getFields: () => Promise.resolve(fields),
      findRecord: async (tableId, recordId) =>
        records.find((candidate) => candidate.id === recordId),
    });

    const recordsWithDisplay = await Promise.all(
      records.map(async (record) => ({
        payload: record.payload,
        displayText: await resolveDisplay(record),
      })),
    );

    // 使用 renderMemoryFullSnapshot 渲染单表
    return renderMemoryFullSnapshot({
      tables: [
        {
          name: table.name,
          fields: enabledFields.map((f) => ({ name: f.name, id: f.id })),
          records: recordsWithDisplay.map((r) => ({
            payload: new Map(Object.entries(r.payload)),
            displayText: r.displayText,
          })),
        },
      ],
      limit: this.#ports.macroLimit,
    });
  }

  /** 重建全局宏（复用现有快照逻辑） */
  #rebuildGlobalMacros(macros: Map<string, MacroDefinition>): void {
    // 全局宏的快照由 MemoryMacroService 管理，这里只记录它们的存在
    // 实际快照计算在 MemoryMacroService 中完成
    for (const view of this.#ports.globalMacros) {
      if (!macros.has(view.name)) {
        macros.set(view.name, {
          name: view.name,
          kind: "global",
          snapshot: "", // 快照由 MemoryMacroService 填充
        });
      }
    }
  }

  /** 重建聊天 Scope 宏（复用现有快照逻辑） */
  #rebuildChatScopeMacros(macros: Map<string, MacroDefinition>): void {
    // 聊天 Scope 宏的快照由 MemoryMacroService 管理，这里只记录它们的存在
    // 实际快照计算在 MemoryMacroService 中完成
    for (const view of this.#ports.chatScopeMacros) {
      // 聊天 Scope 宏可覆盖全局同名宏
      macros.set(view.name, {
        name: view.name,
        kind: "chat-scope",
        snapshot: "", // 快照由 MemoryMacroService 填充
      });
    }
  }
}
