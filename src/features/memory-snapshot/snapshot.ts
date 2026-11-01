import type {
  MemoryMacro,
  MemoryEvidence,
  MemoryField,
  MemoryRecord,
  MemoryRecordHistory,
  MemorySpace,
  MemoryTable,
} from "../memory/index.ts";
import type { FillTask } from "../fill-tasks/fill-task.ts";

/** 楼层进度台账条目（untracked = 无行，不出现）。 */
export interface MemorySpaceBackupLedgerEntry {
  readonly floor: number;
  readonly status: "processed" | "error";
  readonly updatedAt: string;
}

/** 单个记忆空间的序列化单元。 */
export const MEMORY_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export interface MemorySpaceBackup {
  readonly schemaVersion: typeof MEMORY_SNAPSHOT_SCHEMA_VERSION;
  readonly space: MemorySpace & { readonly macros: readonly MemoryMacro[] };
  readonly tables: readonly MemoryTable[];
  readonly fields: readonly MemoryField[];
  readonly records: readonly MemoryRecord[];
  readonly history: readonly MemoryRecordHistory[];
  readonly evidence: readonly MemoryEvidence[];
  /** 旧备份的辅助任务集合，仅保留文件读取兼容；当前导出和空间替换不保存或恢复 */
  readonly fillTasks?: readonly FillTask[];
  /** 旧备份的辅助台账集合，仅保留文件读取兼容；当前导出和空间替换不保存或恢复 */
  readonly floorLedger?: readonly MemorySpaceBackupLedgerEntry[];
}
