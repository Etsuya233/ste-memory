/**
 * 聊天面板的纯状态变换：消息列表构建 / SSE 事件应用 / 历史收尾。
 * 与 React 无关，便于单测（见 query-chat-state.test.ts）。
 */
import type { ChatEvent, ChatHistoryMessage } from "./api/chat.ts";

export interface ToolCallCard {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
  readonly result?: unknown;
  readonly isError: boolean;
}

export type ChatUiMessage =
  | { readonly kind: "user"; readonly id: string; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly id: string;
      readonly status: "streaming" | "done" | "error";
      readonly text: string;
      readonly thinking: string;
      readonly toolCalls: readonly ToolCallCard[];
      readonly error?: string;
    };

export function createUserMessage(id: string, text: string): ChatUiMessage {
  return { kind: "user", id, text };
}

export function createPendingAssistantMessage(id: string): ChatUiMessage {
  return { kind: "assistant", id, status: "streaming", text: "", thinking: "", toolCalls: [] };
}

/**
 * 把一条 SSE 聊天事件应用到消息列表（作用在 pendingId 对应的 assistant 消息上；
 * 找不到该消息时原样返回，避免流结束/空间切换后的竞态更新）。
 */
export function applyChatEvent(
  messages: readonly ChatUiMessage[],
  pendingId: string,
  event: ChatEvent,
): ChatUiMessage[] {
  return messages.map((message) => {
    if (message.kind !== "assistant" || message.id !== pendingId) return message;
    switch (event.type) {
      case "thinking_delta":
        return { ...message, thinking: message.thinking + event.text };
      case "message_delta":
        return { ...message, text: message.text + event.text };
      case "tool_start":
        return {
          ...message,
          toolCalls: [
            ...message.toolCalls,
            { callId: event.callId, name: event.name, args: event.args, isError: false },
          ],
        };
      case "tool_result":
        return {
          ...message,
          toolCalls: message.toolCalls.map((card) =>
            card.callId === event.callId
              ? { ...card, result: event.result, isError: event.isError }
              : card,
          ),
        };
      case "done":
        return { ...message, status: "done" };
      case "error":
        return { ...message, status: "error", error: event.message };
    }
  });
}

/** 把进行中的流标记为中断（空间切换时收尾用）。 */
export function finalizeInFlight(messages: readonly ChatUiMessage[]): ChatUiMessage[] {
  return messages.map((message) =>
    message.kind === "assistant" && message.status === "streaming"
      ? { ...message, status: "error", error: "已中断（切换了记忆空间）" }
      : message,
  );
}

/** 回传历史：user 文本 + 正常完成的 assistant 文本（error/streaming 不回传）。 */
export function chatHistoryMessages(messages: readonly ChatUiMessage[]): ChatHistoryMessage[] {
  return messages.flatMap<ChatHistoryMessage>((message) => {
    if (message.kind === "user") return [{ role: "user", content: message.text }];
    if (message.status !== "done") return [];
    return message.text.length > 0 ? [{ role: "assistant", content: message.text }] : [];
  });
}
