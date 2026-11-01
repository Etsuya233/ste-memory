import type { MemorySpaceBackup } from "./backup-file.ts";
import type {
  MemoryEvidenceId,
  MemoryFieldId,
  MemoryRecordHistoryId,
  MemoryRecordId,
  MemorySpaceId,
  MemoryTableId,
} from "../memory/index.ts";

/** 纯快照克隆所需的领域身份工厂，不包含辅助任务身份。 */
export interface BackupIdFactory {
  readonly space: () => MemorySpaceId;
  /** 副本中对话宏的独立身份。 */
  readonly macro: () => string;
  /** 克隆的向量分组身份。 */
  readonly group: () => string;
  readonly table: () => MemoryTableId;
  readonly field: () => MemoryFieldId;
  readonly record: () => MemoryRecordId;
  readonly history: () => MemoryRecordHistoryId;
  readonly evidence: () => MemoryEvidenceId;
}

/** 当前聊天的完整空间导出，持久化只由聊天保存组件管理。 */
export interface MemoryBackupRepository {
  exportCurrentSpace(): Promise<MemorySpaceBackup>;
  validateSnapshot(unit: MemorySpaceBackup): Promise<void>;
}
