import type { MemorySpaceBackup } from "../backup/index.ts";
import type { MemorySpace, MemorySpaceId } from "../memory/index.ts";
export interface ChatSnapshot {
  /** 对话文件名（无 .jsonl）；临时/未保存对话为 undefined */
  readonly chatId: string | undefined;
  /** 角色索引；群聊为 undefined */
  readonly characterId?: number | string | undefined;
  /** 群聊 id；非群聊为 null */
  readonly groupId: string | number | null | undefined;
  /** 角色名（ST name2）；群聊为 undefined */
  readonly characterName: string | undefined;
}

/** 记忆空间绑定指针（v1）：只存 spaceId，随对话文件（chatMetadata）走（ADR 0002） */
export interface ChatSpaceBindingV1 {
  readonly version: 1;
  readonly spaceId: MemorySpaceId;
}

/** 记忆空间绑定指针（v2）：新增 chatIdentity 标识绑定归属的对话，用于分支检测 */
export interface ChatSpaceBindingV2 {
  readonly version: 2;
  readonly spaceId: MemorySpaceId;
  readonly chatIdentity: string;
}

export type ChatSpaceBinding = ChatSpaceBindingV1 | ChatSpaceBindingV2;

/**
 * 绑定读取的三态结果：区分「无绑定」与「绑定值存在但无法识别」。
 * 无法识别（损坏 / 来自更新版本插件）时绝不能当作无绑定去新建覆盖——那会丢掉
 * 原指针（如插件降级场景），必须原样保留等待处理。
 */
export type ChatBindingStoreRead =
  | { readonly kind: "bound"; readonly binding: ChatSpaceBinding }
  | { readonly kind: "unrecognized" }
  | { readonly kind: "none" };

/** chatMetadata 读写端口（宿主 = StChatAdapter.bindingStore） */
export interface ChatBindingStore {
  read(): ChatBindingStoreRead;
}

export type SpaceContextStatus =
  | {
      readonly kind: "active";
      readonly binding: ChatSpaceBinding;
      readonly space: MemorySpace;
      readonly created: boolean;
      readonly restored: boolean;
    }
  | {
      readonly kind: "branch-detected";
      readonly binding: ChatSpaceBinding;
      readonly space: MemorySpace;
      readonly originalChatIdentity: string;
      readonly source: MemorySpaceBackup;
    }
  | {
      readonly kind: "unsaved-chat" | "binding-unrecognized" | "load-error";
      readonly humanMsg: string;
    };
export const UNSAVED_CHAT_MESSAGE = "当前对话未保存，暂不支持记忆";
export const BINDING_UNRECOGNIZED_MESSAGE = "记忆空间绑定无法识别，已原样保留未做改动";

/** 空间显示名：群聊 = 「群聊 - 对话文件名」；单人 = 「角色名 - 对话文件名」（spec 决策 3）。
 * 名字只是显示，创建后不随对话重命名变化。Memory 的 memorySpaceName 上限 120 字符按
 * UTF-16 长度计（features/memory/domain/memory-space.ts），此处按同样口径截断——
 * 保证空间一定能创建；可能切断代理对，显示层可容忍。 */
export function buildChatSpaceName(chat: ChatSnapshot): string {
  const prefix =
    chat.groupId != null ? "群聊 - " : chat.characterName ? `${chat.characterName} - ` : "对话 - ";
  const full = `${prefix}${chat.chatId ?? ""}`;
  return full.length > 120 ? full.slice(0, 120) : full;
}

/** 对话身份键：群聊与单人对话可存在同名对话文件，身份必须区分（groupId / characterId 双轨）；
 * 临时/未保存对话（chatId 无值）→ undefined。镜像写侧用同一键跟踪「每个文件最后写回」
 * （复制的对话文件可共享同一空间，跟踪键必须是文件身份而非空间）。 */
export function chatIdentityKey(chat: ChatSnapshot): string | undefined {
  if (chat.chatId === undefined) {
    return undefined;
  }
  return chat.groupId != null
    ? `group:${String(chat.groupId)}:${chat.chatId}`
    : `char:${String(chat.characterId)}:${chat.chatId}`;
}
