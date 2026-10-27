import type { MemoryMacro } from "../domain/index.ts";
import type { MemorySpace, MemorySpaceId } from "../domain/index.ts";

export interface MemorySpaceRepository {
  setMacros(
    id: MemorySpaceId,
    macros: readonly MemoryMacro[],
    updatedAt: string,
  ): Promise<MemorySpace | undefined>;
  create(memorySpace: MemorySpace): Promise<void>;
  delete(id: MemorySpaceId): Promise<boolean>;
  find(id: MemorySpaceId): Promise<MemorySpace | undefined>;
  list(): Promise<MemorySpace[]>;
  rename(id: MemorySpaceId, name: string, updatedAt: string): Promise<MemorySpace | undefined>;
  /**
   * 清除空间记录：删除该空间全部记录派生数据（记忆记录、历史记录、字段证据与
   * 修订身份），保留表格定义、字段与显示策略。空间不存在返回 false。
   */
  clearRecords(id: MemorySpaceId): Promise<boolean>;
  /**
   * 删除该空间全部表格（级联其字段、记录、历史与证据），空间实体本身保留。
   * 表格预设的原子重建（复用本操作）与空间级联删除共用同一语义。
   * 空间不存在返回 false。
   */
  deleteAllTables(id: MemorySpaceId): Promise<boolean>;
}
