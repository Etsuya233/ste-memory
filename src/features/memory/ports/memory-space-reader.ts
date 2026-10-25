import type {
  MemorySpace,
  MemoryField,
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
} from "../domain/index.ts";
import type { QueryRecordsInput, QueryRecordsPage } from "../record-query-contract.ts";

/**
 * 记忆空间只读端口：Agent / 宏 / 填表 / 问答等消费方与记忆写路径之间的只读边界。
 *
 * 只暴露查询能力（表/字段列表 + 记录查询），写入统一走跨表原子提交批次；
 * 实现由宿主（runtime）用 Memory 服务装配。
 */
export interface MemorySpaceReader {
  getSpace(memorySpaceId: MemorySpaceId): Promise<MemorySpace | undefined>;
  listTables(memorySpaceId: MemorySpaceId): Promise<readonly MemoryTable[]>;
  listFields(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): Promise<readonly MemoryField[]>;
  queryRecords(memorySpaceId: MemorySpaceId, input: QueryRecordsInput): Promise<QueryRecordsPage>;
  /** Optional host SQL capability. The host enforces read-only authorization and execution/result budgets. */
  querySql?(memorySpaceId: MemorySpaceId, sql: string): Promise<readonly Record<string, unknown>[]>;
}
