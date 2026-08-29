/** 备份文件模块出口（ADR 0021）：编解码纯函数 + 格式类型 + 备份存储端口。 */
export {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  memoryBackupDataSchema,
  memoryBackupFileSchema,
} from "./backup-file.ts";
export type { MemoryBackupData, MemoryBackupFile, MemorySpaceBackup } from "./backup-file.ts";
export {
  createBackupFile,
  decodeBackupFile,
  parseBackupFile,
  serializeBackupFile,
  validateBackupData,
} from "./backup-codec.ts";
export type {
  BackupIdFactory,
  MemoryBackupRepository,
  MemoryBackupSnapshot,
} from "./backup-port.ts";
