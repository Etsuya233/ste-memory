import { Type } from "typebox";
import type { MemorySpaceBackup } from "../export/backup-file.ts";
import { memorySpaceBackupSchema } from "../export/backup-file.ts";

/**
 * 对话文件镜像格式（ADR 0023）：随聊天文件（chat_metadata.steMemoryMirror）走的
 * 记忆快照。
 *
 * - 信封 `{ format: "ste-memory-chat-mirror", version: 1, spaceId, updatedAt,
 *   appVersion, data }`；data 与备份单元**完全同构**（space/tables/fields/
 *   records/history/evidence 六要素）——结构校验复用 memorySpaceBackupSchema、
 *   完整性校验复用 validateSpaceBackupUnit，零裁剪。
 * - updatedAt = 空间指纹的 LWW 键（本地与文件镜像比较的版本依据）。
 * - 与云同步文件语义不同：镜像只是随文件走的恢复源，**未知版本/损坏一律
 *   返回 null 由调用方忽略**（不抛错、不打断打开流程、不覆盖无法识别的内容）。
 */

export const CHAT_MIRROR_FORMAT = "ste-memory-chat-mirror" as const;
export const CHAT_MIRROR_VERSION = 1 as const;

/** 对话文件镜像信封。 */
export interface ChatMirrorFile {
  readonly format: typeof CHAT_MIRROR_FORMAT;
  readonly version: typeof CHAT_MIRROR_VERSION;
  /** 镜像所属记忆空间（与 data.space.id 一致；恢复时须与绑定指针一致） */
  readonly spaceId: string;
  /** LWW 键：空间指纹的最大 updatedAt */
  readonly updatedAt: string;
  readonly appVersion: string;
  /** 单空间完整快照（与备份单元同构；history 可被设置裁剪为空数组） */
  readonly data: MemorySpaceBackup;
}

/** 镜像信封结构校验 schema（data 复用备份单元 schema）。 */
export const chatMirrorFileSchema = Type.Object({
  format: Type.Literal(CHAT_MIRROR_FORMAT),
  version: Type.Literal(CHAT_MIRROR_VERSION),
  spaceId: Type.String(),
  updatedAt: Type.String(),
  appVersion: Type.String(),
  data: memorySpaceBackupSchema,
});
