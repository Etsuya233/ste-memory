/**
 * 证据楼层 chip（ticket 11 签名元素）的纯逻辑 seam：证据 → chip 视图模型、
 * 消息原文摘录提取、楼层跳转结果 → 提示文案。组件只做 DOM 投影与事件接线。
 *
 * 证据来源语义（ADR 0003）：同步楼层证据 source_type = "sync_floor"、
 * source_id = ST 消息数组下标；未知 source_type 渲染中性徽标（未来扩展，
 * 如快照证据）。
 */
import type { MemoryEvidence } from "@ste-memory/core/memory";

/** 同步楼层证据的来源类型（ADR 0003：source_id = ST 消息数组下标） */
export const EVIDENCE_FLOOR_SOURCE_TYPE = "sync_floor";

export type EvidenceChipViewModel =
  | { readonly kind: "floor"; readonly floor: number }
  | { readonly kind: "generic"; readonly sourceType: string };

export function evidenceChipViewModels(
  evidence: readonly MemoryEvidence[],
): EvidenceChipViewModel[] {
  return evidence.map((entry) => {
    if (entry.source_type === EVIDENCE_FLOOR_SOURCE_TYPE) {
      const floor = typeof entry.source_id === "number" ? entry.source_id : Number(entry.source_id);
      if (Number.isInteger(floor) && floor >= 0) return { kind: "floor", floor };
    }
    return { kind: "generic", sourceType: entry.source_type };
  });
}

/** 楼层跳转结果（与 StChatAdapter.scrollToFloor 返回同构；seam 不依赖适配器模块） */
export type FloorJumpOutcome =
  | { readonly kind: "jumped" }
  | { readonly kind: "out-of-range"; readonly chatLength: number }
  | { readonly kind: "not-loaded" };

/** 跳转结果 → 提示文案：成功返回 null（无提示），失败返回 warning 文案 */
export function floorJumpHint(result: FloorJumpOutcome): string | null {
  if (result.kind === "jumped") return null;
  if (result.kind === "out-of-range") {
    return `楼层已越界（当前对话共 ${result.chatLength} 条消息）`;
  }
  return "对应消息尚未加载，无法跳转";
}

export interface ChatMessageExcerpt {
  readonly floor: number;
  readonly name: string;
  readonly isUser: boolean;
  readonly content: string;
  readonly truncated: boolean;
}

export interface StChatMessageLike {
  readonly floor: number;
  readonly content: string;
  readonly name: string;
  readonly isUser: boolean;
}

/** 原文摘录：超过 maxLength 截断并附省略号（悬停/长按浮出内容） */
export function buildMessageExcerpt(
  message: StChatMessageLike,
  maxLength = 120,
): ChatMessageExcerpt {
  const truncated = message.content.length > maxLength;
  return {
    floor: message.floor,
    name: message.name,
    isUser: message.isUser,
    content: truncated ? `${message.content.slice(0, maxLength)}…` : message.content,
    truncated,
  };
}

/** 记录是否携带任何字段证据（无证据的手动记录在详情明确标注） */
export function recordHasEvidence(
  fieldEvidence: Readonly<Record<string, readonly MemoryEvidence[]>> | undefined,
): boolean {
  return Object.values(fieldEvidence ?? {}).some((entries) => entries.length > 0);
}
