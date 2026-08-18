import type { MemorySpace, MemorySpaceId } from "../../domain/index.ts";

export interface MemorySpaceRepository {
  create(memorySpace: MemorySpace): Promise<void>;
  delete(id: MemorySpaceId): Promise<boolean>;
  find(id: MemorySpaceId): Promise<MemorySpace | undefined>;
  list(): Promise<MemorySpace[]>;
  rename(id: MemorySpaceId, name: string, updatedAt: string): Promise<MemorySpace | undefined>;
  /**
   * 清除空间记录（spec reset-space）：删除该空间全部记录派生数据
   * （记忆记录、历史记录、字段证据与修订身份），保留表格定义、字段与显示策略。
   * 空间不存在返回 false。
   */
  clearRecords(id: MemorySpaceId): Promise<boolean>;
  /**
   * 重置空间（spec reset-space）：删除该空间全部表格
   * （级联其字段、记录、历史与证据），空间实体本身保留。
   * 空间不存在返回 false。
   */
  deleteAllTables(id: MemorySpaceId): Promise<boolean>;
}
