import type { MemoryMacro } from "../macros/macro-expression.ts";
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
 * - SQLite 原子替换结构、记录、历史与证据，替换失败保留原内容；
 * - 文件保存成功后按原文件归属清理任务、楼层进度与向量；等待确认期间停止新业务写入。
 *   文件与辅助数据没有共同事务，保存失败只重试保存与确认，不重建业务内容；
 * - 空间身份（space 行）与对话绑定保留：只替换空间内部结构与数据；
 * - 首次创建（空间刚建立、内容为空）与应用预设共用本操作。
 * 空间不存在返回 false（不创建空间）。
 */
export interface SpaceStructureRebuildInput {
  readonly macros?: readonly MemoryMacro[];
  readonly prompt?: string;
  readonly memorySpaceId: MemorySpaceId;
  readonly tables: readonly MemoryTable[];
  readonly fields: readonly MemoryField[];
  readonly initializationSource: MemorySpaceInitializationSource;
}

export interface SpaceStructureRebuild {
  rebuild(input: SpaceStructureRebuildInput): Promise<boolean>;
}
