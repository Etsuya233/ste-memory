/** Dexie 持久层出口（ADR 0002）：schema + core 端口 repository 的浏览器实现。 */
export { SteMemoryDatabase, ST_MEMORY_DB_NAME } from "./database.ts";
export type { MemoryEvidenceRow } from "./database.ts";
export { DexieMemorySpaceRepository } from "./memory-space-repository.ts";
export { DexieMemoryTableRepository } from "./memory-table-repository.ts";
export { DexieMemoryFieldRepository } from "./memory-field-repository.ts";
export { DexieMemoryRecordRepository } from "./memory-record-repository.ts";
export { DexieMemoryBackupRepository } from "./memory-backup-repository.ts";
export { DexieSyncChangeSource } from "./dexie-sync-change-source.ts";
export { DexieFillTaskRepository, DexieFloorLedgerRepository } from "./fill-task-repository.ts";
