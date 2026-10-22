/** Dexie 持久层出口（ADR 0002）：schema + Memory 端口 repository 的浏览器实现。 */
export { SteMemoryDatabase, ST_MEMORY_DB_NAME } from "./database.ts";
export type { MemoryEvidenceRow } from "./database.ts";
export { DexieMemorySpaceRepository } from "./memory/memory-space-repository.ts";
export { DexieMemoryTableRepository } from "./memory/memory-table-repository.ts";
export { DexieMemoryFieldRepository } from "./memory/memory-field-repository.ts";
export { DexieMemoryRecordRepository } from "./memory/memory-record-repository.ts";
export { DexieMemoryBackupRepository } from "./backup/memory-backup-repository.ts";
export { DexieMemoryChangeSource } from "./memory-change-source.ts";
export {
  DexieFillTaskRepository,
  DexieFloorLedgerRepository,
} from "./fill-tasks/fill-task-repository.ts";
export { DexieSpaceStructureRebuild } from "./space/space-structure-rebuild-repository.ts";
export { SteMemoryLogDatabase, ST_MEMORY_LOG_DB_NAME } from "./logs/log-database.ts";
export { DexieLogRepository, LOG_LIMIT } from "./logs/log-repository.ts";
export { DexieVectorIndexRepository } from "./vector-index/vector-index-repository.ts";
