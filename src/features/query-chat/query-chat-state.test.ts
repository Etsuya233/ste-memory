import { describe, expect, it } from "vitest";
import {
  applyQueryChatEvent,
  assistantPlainText,
  createPendingAssistantMessage,
  createUserMessage,
  isTerminalQueryChatEvent,
  type QueryChatEvent,
  type QueryChatMessage,
} from "./query-chat-state.ts";

function segmentsOf(messages: readonly QueryChatMessage[], index: number) {
  const message = messages[index]!;
  if (message.kind !== "assistant") throw new Error("expected assistant");
  return message.segments;
}

describe("纯消息函数", () => {
  it("createUserMessage / createPendingAssistantMessage 初始形状", () => {
    expect(createUserMessage("u1", "你好")).toEqual({ kind: "user", id: "u1", text: "你好" });
    expect(createPendingAssistantMessage("a1")).toEqual({
      kind: "assistant",
      id: "a1",
      status: "streaming",
      segments: [],
    });
  });

  it("isTerminalQueryChatEvent：只有 done/error 是终态", () => {
    expect(isTerminalQueryChatEvent({ type: "done", stopReason: "stop", errorMessage: null })).toBe(
      true,
    );
    expect(isTerminalQueryChatEvent({ type: "error", message: "x" })).toBe(true);
    expect(isTerminalQueryChatEvent({ type: "message_delta", text: "x" })).toBe(false);
    expect(isTerminalQueryChatEvent({ type: "thinking_delta", text: "x" })).toBe(false);
  });
});

describe("applyQueryChatEvent（事件 → 片段时间线）", () => {
  const pending = createPendingAssistantMessage("a1");
  const base = [createUserMessage("u1", "谁受伤了？"), pending] as const;

  it("thinking/message 增量合并进同类型片段；类型切换开启新片段", () => {
    const afterT1 = applyQueryChatEvent(base, "a1", { type: "thinking_delta", text: "先查" });
    const afterT2 = applyQueryChatEvent(afterT1, "a1", { type: "thinking_delta", text: "一下" });
    const afterText = applyQueryChatEvent(afterT2, "a1", { type: "message_delta", text: "云烬" });
    const afterT3 = applyQueryChatEvent(afterText, "a1", {
      type: "thinking_delta",
      text: "再确认",
    });
    const segments = segmentsOf(afterT3, 1);
    expect(segments).toEqual([
      { kind: "thinking", text: "先查一下" },
      { kind: "text", text: "云烬" },
      { kind: "thinking", text: "再确认" },
    ]);
    const assistant = afterT3[1]!;
    if (assistant.kind !== "assistant") throw new Error("unreachable");
    expect(assistant.status).toBe("streaming");
  });

  it("交错事件序列保序：工具卡出现在触发位置，结果回填同一张卡", () => {
    const events: QueryChatEvent[] = [
      { type: "thinking_delta", text: "先回忆" },
      { type: "message_delta", text: "让我查一下" },
      {
        type: "tool_start",
        callId: "call-1",
        name: "query_records",
        args: { table: "characters" },
      },
      {
        type: "tool_result",
        callId: "call-1",
        name: "query_records",
        result: { total: 2 },
        isError: false,
      },
      { type: "thinking_delta", text: "结果有 2 条" },
      { type: "message_delta", text: "云烬与墨渊" },
    ];
    let messages: readonly QueryChatMessage[] = base;
    for (const event of events) {
      messages = applyQueryChatEvent(messages, "a1", event);
    }
    expect(segmentsOf(messages, 1)).toEqual([
      { kind: "thinking", text: "先回忆" },
      { kind: "text", text: "让我查一下" },
      {
        kind: "tool",
        callId: "call-1",
        name: "query_records",
        args: { table: "characters" },
        running: false,
        result: { total: 2 },
        isError: false,
      },
      { kind: "thinking", text: "结果有 2 条" },
      { kind: "text", text: "云烬与墨渊" },
    ]);
  });

  it("tool_start 插入独立卡片且不合并进其他片段；多卡按 callId 各自回填", () => {
    const afterStart1 = applyQueryChatEvent(base, "a1", {
      type: "tool_start",
      callId: "call-1",
      name: "query_records",
      args: { table: "characters" },
    });
    const afterText = applyQueryChatEvent(afterStart1, "a1", {
      type: "message_delta",
      text: "同时查一下物品",
    });
    const afterStart2 = applyQueryChatEvent(afterText, "a1", {
      type: "tool_start",
      callId: "call-2",
      name: "query_records",
      args: { table: "items" },
    });
    let segments = segmentsOf(afterStart2, 1);
    expect(segments).toEqual([
      {
        kind: "tool",
        callId: "call-1",
        name: "query_records",
        args: { table: "characters" },
        running: true,
        result: undefined,
        isError: false,
      },
      { kind: "text", text: "同时查一下物品" },
      {
        kind: "tool",
        callId: "call-2",
        name: "query_records",
        args: { table: "items" },
        running: true,
        result: undefined,
        isError: false,
      },
    ]);

    // 只回填 call-2，call-1 保持执行中
    const afterResult2 = applyQueryChatEvent(afterStart2, "a1", {
      type: "tool_result",
      callId: "call-2",
      name: "query_records",
      result: { total: 5 },
      isError: true,
    });
    segments = segmentsOf(afterResult2, 1);
    expect(segments[2]).toEqual({
      kind: "tool",
      callId: "call-2",
      name: "query_records",
      args: { table: "items" },
      running: false,
      result: { total: 5 },
      isError: true,
    });
    expect(segments[0]).toEqual({
      kind: "tool",
      callId: "call-1",
      name: "query_records",
      args: { table: "characters" },
      running: true,
      result: undefined,
      isError: false,
    });
  });

  it("未知/迟到 callId 的 tool_result 不产生新条目，消息引用不变", () => {
    const afterStart = applyQueryChatEvent(base, "a1", {
      type: "tool_start",
      callId: "call-1",
      name: "query_records",
      args: { table: "characters" },
    });
    const next = applyQueryChatEvent(afterStart, "a1", {
      type: "tool_result",
      callId: "call-unknown",
      name: "query_records",
      result: { total: 1 },
      isError: false,
    });
    expect(next[1]).toBe(afterStart[1]);
  });

  it("工具合法返回 undefined 时仍结束执行中（running 为显式标记，不靠 result 推断）", () => {
    const afterStart = applyQueryChatEvent(base, "a1", {
      type: "tool_start",
      callId: "call-1",
      name: "update_record",
      args: { table: "characters", key: 1 },
    });
    const done = applyQueryChatEvent(afterStart, "a1", {
      type: "tool_result",
      callId: "call-1",
      name: "update_record",
      result: undefined,
      isError: false,
    });
    expect(segmentsOf(done, 1)).toEqual([
      {
        kind: "tool",
        callId: "call-1",
        name: "update_record",
        args: { table: "characters", key: 1 },
        running: false,
        result: undefined,
        isError: false,
      },
    ]);
  });

  it("无思考事件时消息不含思考片段（模型不支持思考的静默降级）", () => {
    const afterText = applyQueryChatEvent(base, "a1", { type: "message_delta", text: "直接回答" });
    const done = applyQueryChatEvent(afterText, "a1", {
      type: "done",
      stopReason: "stop",
      errorMessage: null,
    });
    const segments = segmentsOf(done, 1);
    expect(segments).toEqual([{ kind: "text", text: "直接回答" }]);
  });

  it("done 携带提交结果；error 落错误文案且已生成片段保持原状", () => {
    const committed = applyQueryChatEvent(base, "a1", {
      type: "done",
      stopReason: "stop",
      errorMessage: null,
      commit: { status: "committed", created: 1, updated: 0, deleted: 0 },
    });
    const doneAssistant = committed[1]!;
    if (doneAssistant.kind !== "assistant") throw new Error("unreachable");
    expect(doneAssistant.status).toBe("done");
    expect(doneAssistant.commit).toEqual({
      status: "committed",
      created: 1,
      updated: 0,
      deleted: 0,
    });

    const withText = applyQueryChatEvent(base, "a1", { type: "message_delta", text: "部分回答" });
    const errored = applyQueryChatEvent(withText, "a1", { type: "error", message: "模型调用失败" });
    const errorAssistant = errored[1]!;
    if (errorAssistant.kind !== "assistant") throw new Error("unreachable");
    expect(errorAssistant.status).toBe("error");
    expect(errorAssistant.error).toBe("模型调用失败");
    expect(errorAssistant.segments).toEqual([{ kind: "text", text: "部分回答" }]);
  });

  it("pending 不存在时原样返回（迟到事件防御）", () => {
    const next = applyQueryChatEvent(base, "nope", { type: "message_delta", text: "x" });
    expect(next).toBe(base);
  });
});

describe("assistantPlainText（聚合回答纯文本推导）", () => {
  it("全部文本片段拼接；思考与工具内容不参与", () => {
    const message: Extract<QueryChatMessage, { kind: "assistant" }> = {
      kind: "assistant",
      id: "a1",
      status: "streaming",
      segments: [
        { kind: "thinking", text: "思考" },
        { kind: "text", text: "第一段" },
        {
          kind: "tool",
          callId: "c1",
          name: "query_records",
          args: {},
          running: false,
          result: undefined,
          isError: false,
        },
        { kind: "text", text: "第二段" },
      ],
    };
    expect(assistantPlainText(message)).toBe("第一段第二段");
  });

  it("无文本片段时为空串", () => {
    const empty: Extract<QueryChatMessage, { kind: "assistant" }> = {
      kind: "assistant",
      id: "a1",
      status: "streaming",
      segments: [],
    };
    expect(assistantPlainText(empty)).toBe("");
    const withThinking: Extract<QueryChatMessage, { kind: "assistant" }> = {
      kind: "assistant",
      id: "a1",
      status: "streaming",
      segments: [{ kind: "thinking", text: "只有思考" }],
    };
    expect(assistantPlainText(withThinking)).toBe("");
  });
});
