import { Value } from "typebox/value";
import type { MemorySpaceBackup } from "../backup/backup-file.ts";
import {
  createBackupSeenIds,
  normalizeBackupData,
  validateSpaceBackupUnit,
} from "../backup/backup-codec.ts";
import { CHAT_MIRROR_FORMAT, CHAT_MIRROR_VERSION } from "./chat-mirror-file.ts";
import type { ChatMirrorFile } from "./chat-mirror-file.ts";
import { chatMirrorFileSchema } from "./chat-mirror-file.ts";

/** 对话文件镜像编解码（纯函数，ADR 0023）：信封 ↔ 对象。
 *
 * - createChatMirrorFile：组装信封；保留旧调用的 includeHistory 裁剪参数，
 *   当前 SQLite 保存入口固定包含完整历史。
 * - decodeChatMirrorFile：format/version 不匹配、结构损坏、空间 id 不一致、
 *   完整性违规一律返回 null；当前初始化和保存调用方据此报告错误并停止覆盖。
 *   旧版镜像缺初始化来源/表格顺序键，解码时做与备份文件同一套归一化。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 组装对话文件镜像（unit 即 data，无深拷贝；includeHistory=false 裁剪 history）。
 *  镜像只承载记忆内容六要素：填表任务、楼层进度与对话级宏跟随对话文件本身的
 *  既有键存放，镜像不带（镜像恢复因此不触碰本地任务/进度/宏，保持既有行为）。 */
export function createChatMirrorFile(
  unit: MemorySpaceBackup,
  spaceId: string,
  updatedAt: string,
  appVersion: string,
  includeHistory = true,
): ChatMirrorFile {
  const content = mirrorContent(unit);
  return {
    format: CHAT_MIRROR_FORMAT,
    version: CHAT_MIRROR_VERSION,
    spaceId,
    updatedAt,
    appVersion,
    data: includeHistory ? content : { ...content, history: [] },
  };
}

/** 镜像内容 = 记忆内容六要素（结构 / 记录 / 修订历史 / 证据）；其余键不带走。 */
function mirrorContent(unit: MemorySpaceBackup): MemorySpaceBackup {
  return {
    space: unit.space,
    tables: unit.tables,
    fields: unit.fields,
    records: unit.records,
    history: unit.history,
    evidence: unit.evidence,
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
  // 旧版镜像（表格预设之前）缺初始化来源与表格顺序键：恢复前归一化为当前形状
  const data = normalizeBackupData({ spaces: [file.data] }).spaces[0]!;
  return file.data === data ? file : { ...file, data };
}
