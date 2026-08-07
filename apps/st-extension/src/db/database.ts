import { Dexie, type Table } from "dexie";
import type {
  MemoryField,
  MemoryFieldId,
  MemorySpace,
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
} from "@ste-memory/core/memory";

/** 插件 Dexie 数据库默认名称（同一 origin 下与后续版本共用，ADR 0002） */
export const ST_MEMORY_DB_NAME = "ste-memory";

/**
 * v1 schema：记忆空间 / 记忆表格 / 字段定义。
 *
 * - 实体按领域对象原样存储：IndexedDB 原生支持数组与对象，不需要像 SQLite
 *   参照实现那样把 options / displayStrategy JSON 字符串化——导出与云同步
 *   （ticket 07/08）直接序列化行即可。
 * - 复合唯一索引在数据库层兜底 core 的「定义 Key 空间内唯一」规则：
 *   - memoryTables: `[memorySpaceId+key]`（空间内表格 Key 唯一）
 *   - memoryFields: `[memorySpaceId+tableId+key]`（表内字段 Key 唯一）
 * - 跨空间隔离：所有查询都携带 memorySpaceId 作用域，走复合索引/索引过滤。
 * - 字段类型创建后不可变等规则由 core 服务层强制（repository 只做读写）。
 */
export class SteMemoryDatabase extends Dexie {
  memorySpaces!: Table<MemorySpace, MemorySpaceId>;
  memoryTables!: Table<MemoryTable, MemoryTableId>;
  memoryFields!: Table<MemoryField, MemoryFieldId>;

  constructor(name: string = ST_MEMORY_DB_NAME) {
    super(name);
    this.version(1).stores({
      memorySpaces: "id",
      memoryTables: "id, &[memorySpaceId+key], memorySpaceId",
      memoryFields: "id, &[memorySpaceId+tableId+key], [memorySpaceId+tableId]",
    });
  }
}
