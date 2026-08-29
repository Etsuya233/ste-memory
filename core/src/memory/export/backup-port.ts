import type {
  MemoryBackupData,
  MemorySpaceBackup,
} from "./backup-file.ts";
import type {
  MemoryEvidenceId,
  MemoryFieldId,
  MemoryRecordHistoryId,
  MemoryRecordId,
  MemorySpaceId,
  MemoryTableId,
} from "../domain/index.ts";

/** 全库快照（备份 port 的载荷）：与备份文件 data 部分同构。 */
export type MemoryBackupSnapshot = MemoryBackupData;

/** 克隆空间时的 ID 工厂（st-extension 的 cloneSpace / cloneSpaceFromUnit 共用）。 */
export interface BackupIdFactory {
  readonly space: () => MemorySpaceId;
  readonly table: () => MemoryTableId;
  readonly field: () => MemoryFieldId;
  readonly record: () => MemoryRecordId;
  readonly history: () => MemoryRecordHistoryId;
  readonly evidence: () => MemoryEvidenceId;
}

/**
 * 备份存储端口（ADR 0021）：I/O 留在平台（st 的 Dexie、api 的 SQLite 各自实现），
 * core 只定义契约。
 *
 * - loadSnapshot：读取全库（空间/表格/字段/记录/修订历史/证据），按空间分组。
 * - restoreSnapshot：以快照整体替换当前库；实现必须原子（任一步失败整体回滚，
 *   绝不产生半导入状态）。
 * - restoreSpace：按空间恢复单个单元（对话文件镜像恢复用，ADR 0023）——只
 *   替换该空间在六张表里的数据，其他空间不受影响；同样必须原子。
 * - cloneSpace：读取某空间完整单元并克隆为全新 ID 的空间（外键重映射），原子写入。
 * - cloneSpaceFromUnit：从内存中的备份单元克隆为全新 ID 的空间（外键重映射），原子写入；
 *   导入场景（issue 26）数据库里没有源空间，源是文件反序列化的单元，故单独提供。
 */
export interface MemoryBackupRepository {
  loadSnapshot(): Promise<MemoryBackupSnapshot>;
  restoreSnapshot(snapshot: MemoryBackupSnapshot): Promise<void>;
  restoreSpace(unit: MemorySpaceBackup): Promise<void>;
  cloneSpace(sourceSpaceId: MemorySpaceId, createId: BackupIdFactory): Promise<MemorySpaceId>;
  cloneSpaceFromUnit(
    unit: MemorySpaceBackup,
    createId: BackupIdFactory,
  ): Promise<MemorySpaceId>;
}
