import type { MemoryField, MemorySpaceId, MemoryTable, MemoryTableId } from "../../domain/index.ts";
import type { QueryRecordsInput, QueryRecordsPage } from "../memory-record-query-contract.ts";

/**
 * 记忆空间只读端口：agent 子层（memory/application/agent）与记忆模块其他部分之间的只读边界。
 *
 * 只暴露查询能力（表/字段列表 + 记录查询），写入统一走 12 的跨表原子提交批次，
 * 本模块永远接触不到写方法。实现由宿主（apps/api，11.5）用现有应用层
 * UseCases（MemoryTableUseCases / MemoryFieldUseCases / MemoryRecordQueryUseCases）
 * 装配；方法签名与 UseCases 结构兼容。
 */
export interface MemorySpaceReader {
  listTables(memorySpaceId: MemorySpaceId): Promise<readonly MemoryTable[]>;
  listFields(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): Promise<readonly MemoryField[]>;
  queryRecords(memorySpaceId: MemorySpaceId, input: QueryRecordsInput): Promise<QueryRecordsPage>;
}
