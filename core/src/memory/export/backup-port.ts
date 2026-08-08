import type { MemoryBackupData } from "./backup-file.ts";

/** 全库快照（备份 port 的载荷）：与备份文件 data 部分同构。 */
export type MemoryBackupSnapshot = MemoryBackupData;

/**
 * 备份存储端口（ADR 0021）：I/O 留在平台（st 的 Dexie、api 的 SQLite 各自实现），
 * core 只定义契约。
 *
 * - loadSnapshot：读取全库（空间/表格/字段/记录/修订历史/证据），按空间分组。
 * - restoreSnapshot：以快照整体替换当前库；实现必须原子（任一步失败整体回滚，
 *   绝不产生半导入状态）。
 */
export interface MemoryBackupRepository {
  loadSnapshot(): Promise<MemoryBackupSnapshot>;
  restoreSnapshot(snapshot: MemoryBackupSnapshot): Promise<void>;
}
