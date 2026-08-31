import { describe, expect, it, vi } from "vitest";
import type { MemorySpaceId } from "@ste-memory/core/memory";
import {
  QueryChatStore,
  applyQueryChatEvent,
  assistantPlainText,
  chatHistoryMessages,
  createPendingAssistantMessage,
  createUserMessage,
  isTerminalQueryChatEvent,
  queryChatHistoryKey,
  type QueryChatEvent,
  type QueryChatMessage,
} from "./query-chat-state.ts";

const SPACE_A = "space-a" as MemorySpaceId;
const SPACE_B = "space-b" as MemorySpaceId;
const KEY_A_QUERY = queryChatHistoryKey(SPACE_A, "query");
const KEY_A_FILL = queryChatHistoryKey(SPACE_A, "fill");
const KEY_B_QUERY = queryChatHistoryKey(SPACE_B, "query");

function segmentsOf(messages: readonly QueryChatMessage[], index: number) {
  const message = messages[index]!;
  if (message.kind !== "assistant") throw new Error("expected assistant");
  return message.segments;
}

describe("queryChatHistoryKey / 纯消息函数", () => {
  it("历史键按（空间 × 模式）区分", () => {
    expect(KEY_A_QUERY).not.toBe(KEY_A_FILL);
    expect(KEY_A_QUERY).not.toBe(KEY_B_QUERY);
    expect(queryChatHistoryKey(SPACE_A, "query")).toBe(KEY_A_QUERY);
  });

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
    const afterT3 = applyQueryChatEvent(afterText, "a1", { type: "thinking_delta", text: "再确认" });
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
      { kind: "tool", callId: "call-1", name: "query_records", args: { table: "characters" }, running: true, result: undefined, isError: false },
      { kind: "text", text: "同时查一下物品" },
      { kind: "tool", callId: "call-2", name: "query_records", args: { table: "items" }, running: true, result: undefined, isError: false },
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

describe("chatHistoryMessages（无状态多轮回传）", () => {
  it("只回传 user 文本与 done 的 assistant 文本（纯文本 = 文本片段拼接）", () => {
    const streaming = createPendingAssistantMessage("a2");
    const errored = applyQueryChatEvent([createPendingAssistantMessage("a3")], "a3", {
      type: "error",
      message: "炸了",
    })[0]!;
    const doneWithText = applyQueryChatEvent([createPendingAssistantMessage("a5")], "a5", {
      type: "message_delta",
      text: "回答一",
    });
    const doneWithTextFinal = applyQueryChatEvent(doneWithText, "a5", {
      type: "done",
      stopReason: "stop",
      errorMessage: null,
    })[0]!;
    // 思考片段与工具卡不跨轮回传：done 消息含思考+文本，回传的仍是纯文本
    let withThinking: readonly QueryChatMessage[] = [createPendingAssistantMessage("a6")];
    withThinking = applyQueryChatEvent(withThinking, "a6", {
      type: "thinking_delta",
      text: "思考一下",
    });
    withThinking = applyQueryChatEvent(withThinking, "a6", {
      type: "message_delta",
      text: "回答二",
    });
    const doneWithThinkingFinal = applyQueryChatEvent(withThinking, "a6", {
      type: "done",
      stopReason: "stop",
      errorMessage: null,
    })[0]!;
    const messages = [
      createUserMessage("u1", "第一条"),
      doneWithTextFinal,
      createUserMessage("u2", "第二条"),
      streaming,
      errored,
      doneWithThinkingFinal,
    ];
    expect(chatHistoryMessages(messages)).toEqual([
      { role: "user", text: "第一条" },
      { role: "assistant", text: "回答一" },
      { role: "user", text: "第二条" },
      { role: "assistant", text: "回答二" },
    ]);
  });

  it("无文本片段的 done assistant 不回传", () => {
    const done = applyQueryChatEvent([createPendingAssistantMessage("a1")], "a1", {
      type: "done",
      stopReason: "stop",
      errorMessage: null,
    })[0]!;
    expect(chatHistoryMessages([createUserMessage("u1", "问"), done])).toEqual([
      { role: "user", text: "问" },
    ]);
  });
});

describe("QueryChatStore（按 key 历史 + run 状态）", () => {
  it("无历史 key 的快照引用稳定（useSyncExternalStore 契约：getSnapshot 必须缓存）", () => {
    const store = new QueryChatStore();
    expect(store.getHistory(KEY_A_QUERY)).toBe(store.getHistory(KEY_A_QUERY));
    expect(store.getRun(KEY_A_QUERY)).toBeUndefined();
  });

  it("模式初始为查询；setMode 通知监听者", () => {
    const store = new QueryChatStore();
    expect(store.getMode()).toBe("query");
    const listener = vi.fn();
    store.onStoreChange(listener);
    store.setMode("fill");
    expect(store.getMode()).toBe("fill");
    expect(listener).toHaveBeenCalledTimes(1);
    store.setMode("fill");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("beginRun 追加用户 + 待流式消息并记录可取消 run", () => {
    const store = new QueryChatStore();
    const controller = new AbortController();
    store.beginRun(
      KEY_A_QUERY,
      createUserMessage("u1", "问"),
      createPendingAssistantMessage("a1"),
      controller,
    );
    expect(store.getHistory(KEY_A_QUERY).map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(store.getRun(KEY_A_QUERY)).toEqual({ pendingId: "a1", controller });
  });

  it("事件写到对应 key；done 终止 run；error 终止 run", () => {
    const store = new QueryChatStore();
    const controller = new AbortController();
    store.beginRun(
      KEY_A_QUERY,
      createUserMessage("u1", "问"),
      createPendingAssistantMessage("a1"),
      controller,
    );
    store.applyEvent(KEY_A_QUERY, { type: "message_delta", text: "云烬" });
    store.applyEvent(KEY_A_QUERY, { type: "done", stopReason: "stop", errorMessage: null });
    const history = store.getHistory(KEY_A_QUERY);
    expect(history).toHaveLength(2);
    const assistant = history[1]!;
    expect(assistant.kind === "assistant" && assistant.status).toBe("done");
    expect(store.getRun(KEY_A_QUERY)).toBeUndefined();
  });

  it("各 key 历史独立；在途 run 不受切换影响（决策 7）", () => {
    const store = new QueryChatStore();
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    store.beginRun(
      KEY_A_QUERY,
      createUserMessage("u1", "问 A"),
      createPendingAssistantMessage("a1"),
      controllerA,
    );
    store.setMode("fill");
    store.beginRun(
      KEY_A_FILL,
      createUserMessage("u2", "记一下"),
      createPendingAssistantMessage("a2"),
      controllerB,
    );

    // A 的 run 在途时切换 key，事件继续写进 A 的历史
    store.applyEvent(KEY_A_QUERY, { type: "message_delta", text: "回答 A" });
    expect(store.getRun(KEY_A_QUERY)).toBeDefined();
    expect(store.getRun(KEY_A_FILL)).toBeDefined();

    const assistantA = store.getHistory(KEY_A_QUERY)[1]!;
    expect(assistantA.kind === "assistant" && assistantA.segments).toEqual([
      { kind: "text", text: "回答 A" },
    ]);
    const assistantB = store.getHistory(KEY_A_FILL)[1]!;
    expect(assistantB.kind === "assistant" && assistantB.segments).toEqual([]);
  });

  it("无 run 时 applyEvent 是防御性 no-op（迟到事件不污染历史）", () => {
    const store = new QueryChatStore();
    store.applyEvent(KEY_A_QUERY, { type: "message_delta", text: "x" });
    expect(store.getHistory(KEY_A_QUERY)).toEqual([]);
  });

  it("cancel 中止对应 run 的 controller；run 在终态事件前仍存在（停止后可见「已取消」）", () => {
    const store = new QueryChatStore();
    const controller = new AbortController();
    const onAbort = vi.fn();
    controller.signal.addEventListener("abort", onAbort);
    store.beginRun(
      KEY_A_QUERY,
      createUserMessage("u1", "问"),
      createPendingAssistantMessage("a1"),
      controller,
    );
    expect(store.cancel(KEY_A_QUERY)).toBe(true);
    expect(onAbort).toHaveBeenCalledTimes(1);
    // 重复取消无害：run 仍在（等服务的「已取消」终态事件收尾）
    expect(store.cancel(KEY_A_QUERY)).toBe(true);
    store.applyEvent(KEY_A_QUERY, { type: "error", message: "已取消" });
    expect(store.getRun(KEY_A_QUERY)).toBeUndefined();
    expect(store.cancel(KEY_A_QUERY)).toBe(false);
  });

  it("clearSpaceHistory 清空该空间两种模式历史并中断在途 run，其他空间不受影响（spec reset-space）", () => {
    const store = new QueryChatStore();
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    store.beginRun(
      KEY_A_QUERY,
      createUserMessage("u1", "问 A"),
      createPendingAssistantMessage("a1"),
      controllerA,
    );
    store.beginRun(
      KEY_A_FILL,
      createUserMessage("u2", "填 A"),
      createPendingAssistantMessage("a2"),
      controllerA,
    );
    store.beginRun(
      KEY_B_QUERY,
      createUserMessage("u3", "问 B"),
      createPendingAssistantMessage("a3"),
      controllerB,
    );
    const abortSpyA = vi.spyOn(controllerA, "abort");

    store.clearSpaceHistory(SPACE_A);

    expect(store.getHistory(KEY_A_QUERY)).toEqual([]);
    expect(store.getHistory(KEY_A_FILL)).toEqual([]);
    expect(store.getRun(KEY_A_QUERY)).toBeUndefined();
    expect(store.getRun(KEY_A_FILL)).toBeUndefined();
    expect(abortSpyA).toHaveBeenCalled();
    // 其他空间历史与在途 run 不受影响
    expect(store.getHistory(KEY_B_QUERY)).toHaveLength(2);
    expect(store.getRun(KEY_B_QUERY)).toEqual({ pendingId: "a3", controller: controllerB });
    expect(controllerB.signal.aborted).toBe(false);
  });

  it("订阅/退订（useSyncExternalStore 契约）", () => {
    const store = new QueryChatStore();
    const listener = vi.fn();
    const unsubscribe = store.onStoreChange(listener);
    store.setMode("fill");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.setMode("query");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});