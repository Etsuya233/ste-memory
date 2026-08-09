import { Value } from "typebox/value";
import type { MemorySpaceBackup } from "../export/backup-file.ts";
import { createBackupSeenIds, validateSpaceBackupUnit } from "../export/backup-codec.ts";
import { CHAT_MIRROR_FORMAT, CHAT_MIRROR_VERSION } from "./chat-mirror-file.ts";
import type { ChatMirrorFile } from "./chat-mirror-file.ts";
import { chatMirrorFileSchema } from "./chat-mirror-file.ts";

/**
 * 对话文件镜像编解码（纯函数，ADR 0023）：信封 ↔ 对象。
 *
 * - createChatMirrorFile：组装信封；includeHistory=false 时把 data.history
 *   裁为空数组（设置项「镜像包含修订历史」关闭，体积主要来源）。
 * - decodeChatMirrorFile：**忽略语义**——format/version 不匹配（未来版本）、
 *   结构损坏、空间 id 不一致、完整性违规一律返回 null，由调用方决定忽略并
 *   原样保留（与云同步文件「抛错中止」相反：镜像坏了不能打断打开流程）。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 组装对话文件镜像（unit 即 data，无深拷贝；includeHistory=false 裁剪 history）。 */
export function createChatMirrorFile(
  unit: MemorySpaceBackup,
  spaceId: string,
  updatedAt: string,
  appVersion: string,
  includeHistory = true,
): ChatMirrorFile {
  return {
    format: CHAT_MIRROR_FORMAT,
    version: CHAT_MIRROR_VERSION,
    spaceId,
    updatedAt,
    appVersion,
    data: includeHistory ? unit : { ...unit, history: [] },
  };
}

/**
 * 校验并解码对话文件镜像：无法识别（未来版本/损坏/自相矛盾）→ null（忽略）。
 * 校验内容：信封（format/version）、结构（TypeBox schema，data 复用备份单元
 * schema）、spaceId 与单元空间一致、完整性（id 唯一 + 归属一致）。
 */
export function decodeChatMirrorFile(value: unknown): ChatMirrorFile | null {
  if (!isRecord(value)) return null;
  if (value.format !== CHAT_MIRROR_FORMAT) return null;
  if (value.version !== CHAT_MIRROR_VERSION) return null;
  if (!Value.Check(chatMirrorFileSchema, value)) return null;
  const file = value as unknown as ChatMirrorFile;
  if (file.spaceId !== file.data.space.id) return null;
  try {
    validateSpaceBackupUnit(file.data, createBackupSeenIds(), "对话文件镜像");
  } catch {
    return null;
  }
  return file;
}
