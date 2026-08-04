import { describe, expect, it } from "vitest";
import {
  applyChatEvent,
  chatHistoryMessages,
  createPendingAssistantMessage,
  createUserMessage,
  finalizeInFlight,
  type ChatUiMessage,
} from "./query-chat-state.ts";

const USER = "user-1";
const PENDING = "assistant-1";

function pendingState(): ChatUiMessage[] {
  return [createUserMessage(USER, "谁受伤了？"), createPendingAssistantMessage(PENDING)];
}

function doneAssistant(id: string, text: string): ChatUiMessage {
  const pending = createPendingAssistantMessage(id);
  return pending.kind === "assistant" ? { ...pending, status: "done", text } : pending;
}

function erroredAssistant(id: string, error: string): ChatUiMessage {
  const pending = createPendingAssistantMessage(id);
  return pending.kind === "assistant" ? { ...pending, status: "error", error } : pending;
}

function assistantOf(
  messages: readonly ChatUiMessage[],
): Extract<ChatUiMessage, { kind: "assistant" }> {
  const message = messages[1];
  if (!message || message.kind !== "assistant") {
    throw new Error("expected assistant message");
  }
  return message;
}

describe("applyChatEvent", () => {
  it("累积思考与回答增量", () => {
    let messages = pendingState();
    messages = applyChatEvent(messages, PENDING, { type: "thinking_delta", text: "先查表" });
    messages = applyChatEvent(messages, PENDING, { type: "thinking_delta", text: "再过滤" });
    messages = applyChatEvent(messages, PENDING, { type: "message_delta", text: "云烬" });
    messages = applyChatEvent(messages, PENDING, { type: "message_delta", text: "受伤" });

    const assistant = assistantOf(messages);
    expect(assistant).toMatchObject({
      kind: "assistant",
      thinking: "先查表再过滤",
      text: "云烬受伤",
    });
  });

  it("工具调用开始推入卡片，结果按 callId 回填", () => {
    let messages = pendingState();
    messages = applyChatEvent(messages, PENDING, {
      type: "tool_start",
      callId: "call-1",
      name: "query_records",
      args: { table: "characters" },
    });
    const started = assistantOf(messages);
    expect(started).toMatchObject({
      kind: "assistant",
      toolCalls: [{ callId: "call-1", name: "query_records", isError: false }],
    });
    expect(started.toolCalls[0]!.result).toBeUndefined();

    messages = applyChatEvent(messages, PENDING, {
      type: "tool_result",
      callId: "call-1",
      name: "query_records",
      result: { table: "characters", total: 1, records: [] },
      isError: false,
    });
    expect(assistantOf(messages).toolCalls[0]).toMatchObject({
      result: { table: "characters", total: 1, records: [] },
      isError: false,
    });
  });

  it("done / error 切换终态，未知 callId 的结果不生效", () => {
    let messages = pendingState();
    messages = applyChatEvent(messages, PENDING, {
      type: "done",
      stopReason: "stop",
      errorMessage: null,
    });
    expect(messages[1]).toMatchObject({ status: "done" });

    messages = applyChatEvent(messages, PENDING, {
      type: "tool_result",
      callId: "ghost",
      name: "query_records",
      result: null,
      isError: true,
    });
    expect(messages[1]).toMatchObject({ status: "done", toolCalls: [] });

    messages = applyChatEvent(messages, "other-pending", { type: "error", message: "超时" });
    expect(messages[1]).toMatchObject({ status: "done" });

    messages = applyChatEvent(messages, PENDING, { type: "error", message: "鉴权失败" });
    expect(messages[1]).toMatchObject({ status: "error", error: "鉴权失败" });
  });
});

describe("chatHistoryMessages", () => {
  it("只回传 user 与正常完成的 assistant 文本（工具结果与未完成消息不回传）", () => {
    const messages: ChatUiMessage[] = [
      createUserMessage("1", "第一问"),
      doneAssistant("2", "第一答"),
      createUserMessage("3", "第二问"),
      {
        ...createPendingAssistantMessage("4"),
        status: "streaming",
        text: "答到一半",
      } as ChatUiMessage,
      erroredAssistant("5", "失败"),
    ];
    expect(chatHistoryMessages(messages)).toEqual([
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
      { role: "user", content: "第二问" },
    ]);
  });
});

describe("finalizeInFlight", () => {
  it("把进行中的流标记为中断，已完成/已出错的不动", () => {
    const messages: ChatUiMessage[] = [
      createPendingAssistantMessage("2"),
      doneAssistant("3", "好"),
      erroredAssistant("4", "x"),
    ];
    const finalized = finalizeInFlight(messages);
    expect(finalized[0]).toMatchObject({ status: "error", error: "已中断（切换了记忆空间）" });
    expect(finalized[1]).toMatchObject({ status: "done" });
    expect(finalized[2]).toMatchObject({ status: "error", error: "x" });
  });
});
