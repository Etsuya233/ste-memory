import { MEMORY_SNAPSHOT_SCHEMA_VERSION } from "../memory-snapshot/snapshot.ts";
import { Type, type Static } from "typebox";
import { DomainError } from "../memory/index.ts";
import {
  migrateMemorySpaceSnapshot,
  assertSnapshotStructure,
} from "../memory-snapshot/snapshot-migration.ts";
import {
  createSnapshotSeenIds,
  validateSnapshotIntegrity,
} from "../memory-snapshot/snapshot-integrity.ts";
import { memorySpaceSnapshotSchema } from "../memory-snapshot/snapshot-schema.ts";
import { snapshotInvalid } from "../memory-snapshot/snapshot-errors.ts";
import { BACKUP_FORMAT, BACKUP_VERSION } from "./backup-file.ts";
import type { MemoryBackupData, MemoryBackupFile } from "./backup-file.ts";

const backupEnvelopeSchema = Type.Object({
  format: Type.Literal(BACKUP_FORMAT),
  version: Type.Number(),
  exportedAt: Type.String(),
  appVersion: Type.String(),
  data: Type.Object({ spaces: Type.Array(Type.Unknown()) }),
});

/** 保存只接收完整当前快照，不在保存路径补字段或转换旧格式。 */
export function createBackupFile(
  snapshot: MemoryBackupData,
  appVersion: string,
  exportedAt: string,
): MemoryBackupFile {
  for (const unit of snapshot.spaces) assertSnapshotStructure(memorySpaceSnapshotSchema, unit);
  validateBackupData(snapshot);
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt, appVersion, data: snapshot };
}

/** 信封版本与领域快照版本分别校验，所有旧来源进入同一纯迁移入口。 */
export function decodeBackupFile(value: unknown): MemoryBackupFile {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    snapshotInvalid("文件顶层不是对象", "备份文件");
  const envelope = value as Record<string, unknown>;
  if (envelope.format !== BACKUP_FORMAT) snapshotInvalid("不是本插件的备份文件", "备份文件");
  if (![1, 2, BACKUP_VERSION].includes(envelope.version as number)) {
    throw new DomainError({
      type: "memory_backup_version_unsupported",
      param: { version: envelope.version },
      humanMsg: `备份文件版本不支持（${typeof envelope.version === "number" ? `文件 v${envelope.version}，` : ""}当前支持 v1、v2、v${BACKUP_VERSION}）`,
    });
  }
  assertSnapshotStructure(backupEnvelopeSchema, envelope);
  const file = envelope as Static<typeof backupEnvelopeSchema>;
  const version =
    envelope.version === 1
      ? "legacy-views"
      : envelope.version === 2
        ? "legacy-macros"
        : MEMORY_SNAPSHOT_SCHEMA_VERSION;
  const data = {
    spaces: file.data.spaces.map((snapshot) =>
      migrateMemorySpaceSnapshot({
        version:
          envelope.version === BACKUP_VERSION
            ? (snapshot as { schemaVersion?: unknown }).schemaVersion
            : version,
        snapshot,
      }),
    ),
  };
  validateBackupData(data);
  return { ...file, version: BACKUP_VERSION, data };
}

/** 全库物理表共享 ID 域，跨空间重复也必须在恢复前拒绝。 */
export function validateBackupData(data: MemoryBackupData): void {
  const seen = createSnapshotSeenIds();
  for (const unit of data.spaces) validateSnapshotIntegrity(unit, seen);
}

/** 备份文件 → 人类可读 JSON 文本（格式化缩进，便于检查与手工修复）。 */
export function serializeBackupFile(file: MemoryBackupFile): string {
  return JSON.stringify(file, null, 2);
}

/** JSON 文本 → 备份文件（解析失败或校验失败均抛 DomainError）。 */
export function parseBackupFile(text: string): MemoryBackupFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new DomainError({
      type: "memory_backup_invalid_json",
      param: { reason: error instanceof Error ? error.message : String(error) },
      humanMsg: `备份文件不是有效的 JSON：${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
  return decodeBackupFile(value);
}
