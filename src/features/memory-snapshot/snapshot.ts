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
  /** 填表任务（缺省 = 不涉及：恢复保持目标原有任务） */
  readonly fillTasks?: readonly FillTask[];
  /** 楼层进度台账（缺省 = 不涉及） */
  readonly floorLedger?: readonly MemorySpaceBackupLedgerEntry[];
}
