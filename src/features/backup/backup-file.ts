import { Type } from "typebox";
import { memorySpaceSnapshotSchema } from "../memory-snapshot/snapshot-schema.ts";
import type { MemorySpaceBackup } from "../memory-snapshot/snapshot.ts";
export type {
  MemorySpaceBackup,
  MemorySpaceBackupLedgerEntry,
} from "../memory-snapshot/snapshot.ts";

export const BACKUP_FORMAT = "ste-memory-backup" as const;
export const BACKUP_VERSION = 3 as const;

export interface MemoryBackupFile {
  readonly format: typeof BACKUP_FORMAT;
  readonly version: typeof BACKUP_VERSION;
  readonly exportedAt: string;
  readonly appVersion: string;
  readonly data: MemoryBackupData;
}
export interface MemoryBackupData {
  readonly spaces: readonly MemorySpaceBackup[];
}
export const memorySpaceBackupSchema = memorySpaceSnapshotSchema;
export const memoryBackupDataSchema = Type.Object({
  spaces: Type.Array(memorySpaceSnapshotSchema),
});
export const memoryBackupFileSchema = Type.Object({
  format: Type.Literal(BACKUP_FORMAT),
  version: Type.Literal(BACKUP_VERSION),
  exportedAt: Type.String(),
  appVersion: Type.String(),
  data: memoryBackupDataSchema,
});
