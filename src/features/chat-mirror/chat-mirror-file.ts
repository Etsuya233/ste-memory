import { Type } from "typebox";
import type { MemorySpaceBackup } from "../backup/backup-file.ts";
import { memorySpaceBackupSchema } from "../backup/backup-file.ts";

/**
 * 对话文件镜像格式（ADR 0023）：随聊天文件（chat_metadata.steMemoryMirror）走的
 * 记忆快照。
 *
 * - 信封 `{ format: "ste-memory-chat-mirror", version: 1, spaceId, updatedAt,
 *   appVersion, data }`；data 与备份单元**完全同构**（space/tables/fields/
 *   records/history/evidence 六要素）——结构校验复用 memorySpaceBackupSchema、
 *   完整性校验复用 validateSpaceBackupUnit，零裁剪。
 * - updatedAt 记录快照时间；当前 SQLite 初始化固定采用文件快照，不按时间戳竞争。
 * - 未知版本/损坏由解码器返回 null；当前初始化与保存调用方据此报告错误并停止覆盖。
 */

export const CHAT_MIRROR_FORMAT = "ste-memory-chat-mirror" as const;
export const CHAT_MIRROR_VERSION = 2 as const;

/** 对话文件镜像信封。 */
export interface ChatMirrorFile {
  readonly format: typeof CHAT_MIRROR_FORMAT;
  readonly version: typeof CHAT_MIRROR_VERSION;
  /** 镜像所属记忆空间（与 data.space.id 一致；恢复时须与绑定指针一致） */
  readonly spaceId: string;
  /** 快照记录的空间更新时间，不参与本地与文件的来源选择。 */
  readonly updatedAt: string;
  readonly appVersion: string;
  /** 单空间完整快照；当前 SQLite 保存入口始终包含历史。 */
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
