import type {
  MemoryField,
  MemorySpaceId,
  MemorySpaceInitializationSource,
  MemoryTable,
} from "../memory/index.ts";

/**
 * 空间结构重建端口（spec 10.3 / 6.4）：把空间的表格、字段、记录、修订历史、
 * 证据、填表任务与楼层进度台账全部清空，写入新的表/字段结构并更新初始化来源。
 *
 * - 单事务提交：任一步失败整体回滚，保留原结构、记录与任务，绝不产生
 *   半初始化空间；
 * - 空间身份（space 行）与对话绑定保留：只替换空间内部结构与数据；
 * - 首次创建（空间刚建立、内容为空）与应用预设共用本操作。
 * 空间不存在返回 false（不创建空间）。
 */
export interface SpaceStructureRebuildInput {
  readonly memorySpaceId: MemorySpaceId;
  readonly tables: readonly MemoryTable[];
  readonly fields: readonly MemoryField[];
  readonly initializationSource: MemorySpaceInitializationSource;
}

export interface SpaceStructureRebuild {
  rebuild(input: SpaceStructureRebuildInput): Promise<boolean>;
}
