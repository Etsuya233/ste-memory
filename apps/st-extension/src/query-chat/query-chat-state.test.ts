import { describe, expect, it, vi } from "vitest";
import type { MemorySpaceId } from "@ste-memory/core/memory";
import {
  QueryChatStore,
  applyQueryChatEvent,
  chatHistoryMessages,
  createPendingAssistantMessage,
  createUserMessage,
  isTerminalQueryChatEvent,
  queryChatHistoryKey,
} from "./query-chat-state.ts";

const SPACE_A = "space-a" as MemorySpaceId;
const SPACE_B = "space-b" as MemorySpaceId;
const KEY_A_QUERY = queryChatHistoryKey(SPACE_A, "query");
const KEY_A_FILL = queryChatHistoryKey(SPACE_A, "fill");
const KEY_B_QUERY = queryChatHistoryKey(SPACE_B, "query");

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
      text: "",
      thinking: "",
      toolCalls: [],
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

describe("applyQueryChatEvent（事件 → 消息增量）", () => {
  const pending = createPendingAssistantMessage("a1");
  const base = [createUserMessage("u1", "谁受伤了？"), pending] as const;

  it("thinking/message 增量累积到对应 pending 消息", () => {
    const afterThinking = applyQueryChatEvent(base, "a1", { type: "thinking_delta", text: "先查" });
    const afterText = applyQueryChatEvent(afterThinking, "a1", {
      type: "message_delta",
      text: "云烬",
    });
    const assistant = afterText[1]!;
    expect(assistant.kind).toBe("assistant");
    if (assistant.kind !== "assistant") throw new Error("unreachable");
    expect(assistant.thinking).toBe("先查");
    expect(assistant.text).toBe("云烬");
    expect(assistant.status).toBe("streaming");
  });

  it("tool_start 追加调用卡（执行中）；tool_result 按 callId 配对结果/错误", () => {
    const afterStart = applyQueryChatEvent(base, "a1", {
      type: "tool_start",
      callId: "call-1",
      name: "query_records",
      args: { table: "characters" },
    });
    const assistant = afterStart[1]!;
    if (assistant.kind !== "assistant") throw new Error("unreachable");
    expect(assistant.toolCalls).toEqual([
      {
        callId: "call-1",
        name: "query_records",
        args: { table: "characters" },
        result: undefined,
        isError: false,
      },
    ]);

    const afterResult = applyQueryChatEvent(afterStart, "a1", {
      type: "tool_result",
      callId: "call-1",
      name: "query_records",
      result: { total: 2 },
      isError: false,
    });
    const done = afterResult[1]!;
    if (done.kind !== "assistant") throw new Error("unreachable");
    expect(done.toolCalls[0]!.result).toEqual({ total: 2 });
  });

  it("done 携带提交结果；error 落错误文案", () => {
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

    const errored = applyQueryChatEvent(base, "a1", { type: "error", message: "模型调用失败" });
    const errorAssistant = errored[1]!;
    if (errorAssistant.kind !== "assistant") throw new Error("unreachable");
    expect(errorAssistant.status).toBe("error");
    expect(errorAssistant.error).toBe("模型调用失败");
  });

  it("pending 不存在时原样返回（迟到事件防御）", () => {
    const next = applyQueryChatEvent(base, "nope", { type: "message_delta", text: "x" });
    expect(next).toBe(base);
  });
});

describe("chatHistoryMessages（无状态多轮回传）", () => {
  it("只回传 user 文本与 done 的 assistant 文本", () => {
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
    const messages = [
      createUserMessage("u1", "第一条"),
      doneWithTextFinal,
      createUserMessage("u2", "第二条"),
      streaming,
      errored,
    ];
    expect(chatHistoryMessages(messages)).toEqual([
      { role: "user", text: "第一条" },
      { role: "assistant", text: "回答一" },
      { role: "user", text: "第二条" },
    ]);
  });

  it("空文本的 done assistant 不回传", () => {
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
    expect(assistantA.kind === "assistant" && assistantA.text).toBe("回答 A");
    const assistantB = store.getHistory(KEY_A_FILL)[1]!;
    expect(assistantB.kind === "assistant" && assistantB.text).toBe("");
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
