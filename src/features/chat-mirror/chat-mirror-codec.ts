import {
  createSnapshotSeenIds,
  validateSnapshotIntegrity,
} from "../memory-snapshot/snapshot-integrity.ts";
import { snapshotInvalid } from "../memory-snapshot/snapshot-errors.ts";
import { MEMORY_SNAPSHOT_SCHEMA_VERSION } from "../memory-snapshot/snapshot.ts";
import { Type, type Static } from "typebox";
import type { MemorySpaceBackup } from "../backup/backup-file.ts";
import {
  migrateMemorySpaceSnapshot,
  assertSnapshotStructure,
} from "../memory-snapshot/snapshot-migration.ts";
import { memorySpaceSnapshotSchema } from "../memory-snapshot/snapshot-schema.ts";
import {
  CHAT_MIRROR_FORMAT,
  CHAT_MIRROR_VERSION,
  type ChatMirrorFile,
} from "./chat-mirror-file.ts";

const mirrorEnvelopeSchema = Type.Object({
  format: Type.Literal(CHAT_MIRROR_FORMAT),
  version: Type.Number(),
  spaceId: Type.String(),
  updatedAt: Type.String(),
  appVersion: Type.String(),
  data: Type.Unknown(),
});

/** 组装对话文件镜像（完整空间内容，无历史裁剪）。
 *  镜像包含空间内的对话宏；任务和楼层进度使用各自的持久化路径，镜像不带它们。 */
export function createChatMirrorFile(
  unit: MemorySpaceBackup,
  spaceId: string,
  updatedAt: string,
  appVersion: string,
): ChatMirrorFile {
  assertSnapshotStructure(memorySpaceSnapshotSchema, unit);
  validateSnapshotIntegrity(unit, createSnapshotSeenIds());
  if (unit.space.id !== spaceId) snapshotInvalid("镜像空间身份不一致");
  const content = mirrorContent(unit);
  return {
    format: CHAT_MIRROR_FORMAT,
    version: CHAT_MIRROR_VERSION,
    spaceId,
    updatedAt,
    appVersion,
    data: content,
  };
}

/** 镜像内容 = 记忆内容六要素（结构 / 记录 / 修订历史 / 证据）；其余键不带走。 */
function mirrorContent(unit: MemorySpaceBackup): MemorySpaceBackup {
  return {
    schemaVersion: unit.schemaVersion,
    space: unit.space,
    tables: unit.tables,
    fields: unit.fields,
    records: unit.records,
    history: unit.history,
    evidence: unit.evidence,
  };
}

/** 未知版本、结构损坏或自相矛盾的镜像返回 null，调用方据此停止加载和覆盖。 */
export function decodeChatMirrorFile(value: unknown): ChatMirrorFile | null {
  try {
    assertSnapshotStructure(mirrorEnvelopeSchema, value);
    const file = value as Static<typeof mirrorEnvelopeSchema>;
    const envelopeVersion = file.version;
    if (![1, 2, CHAT_MIRROR_VERSION].includes(envelopeVersion)) return null;
    const version =
      envelopeVersion === 1
        ? "legacy-views"
        : envelopeVersion === 2
          ? "legacy-macros"
          : MEMORY_SNAPSHOT_SCHEMA_VERSION;
    const data = migrateMemorySpaceSnapshot({ version, snapshot: file.data });
    if (file.spaceId !== data.space.id) return null;
    return { ...file, version: CHAT_MIRROR_VERSION, data };
  } catch {
    return null;
  }
}
