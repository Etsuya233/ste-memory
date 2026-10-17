/** Memory 持久化端口出口：其他功能只依赖接口，实现在 infrastructure。 */
export type { MemoryFieldRepository } from "./memory-field-repository.ts";
export type { MemoryRecordHistoryQuery, MemoryRecordMutation } from "./memory-record-repository.ts";
export type {
  MemoryEvidenceRepository,
  MemoryRecordRepository,
} from "./memory-record-repository.ts";
export type { MemorySpaceRepository } from "./memory-space-repository.ts";
export type { MemoryTableRepository } from "./memory-table-repository.ts";
export { memoryChangesEqual } from "./change-source.ts";
export type { MemoryChangeFingerprint, MemoryChangeSource } from "./change-source.ts";
