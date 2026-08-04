/**
 * MemorySpaceReader 适配器：把现有应用层 UseCases 装配为 core agent 的只读端口。
 * 只转发只读方法（表/字段列表 + 记录查询），agent 永远接触不到写方法。
 */
import type { MemorySpaceReader } from "@ste-memory/core/agent";
import type { MemorySpaceId, MemoryTableId, QueryRecordsInput } from "@ste-memory/core/memory";
import type { MemoryFieldManager } from "../../../application/ports/memory-field.ts";
import type { MemoryRecordQueryManager } from "../../../application/ports/memory-record-query.ts";
import type { MemoryTableManager } from "../../../application/ports/memory-table.ts";

export class UseCaseMemorySpaceReader implements MemorySpaceReader {
  readonly #tables: MemoryTableManager;
  readonly #fields: MemoryFieldManager;
  readonly #queries: MemoryRecordQueryManager;

  constructor(
    tables: MemoryTableManager,
    fields: MemoryFieldManager,
    queries: MemoryRecordQueryManager,
  ) {
    this.#tables = tables;
    this.#fields = fields;
    this.#queries = queries;
  }

  listTables(memorySpaceId: MemorySpaceId) {
    return this.#tables.list(memorySpaceId);
  }

  listFields(memorySpaceId: MemorySpaceId, tableId: MemoryTableId) {
    return this.#fields.list(memorySpaceId, tableId);
  }

  queryRecords(memorySpaceId: MemorySpaceId, input: QueryRecordsInput) {
    return this.#queries.query(memorySpaceId, input);
  }
}
