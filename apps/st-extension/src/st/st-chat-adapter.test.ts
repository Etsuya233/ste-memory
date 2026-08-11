import { describe, expect, it, vi } from "vitest";
import { createChatMirrorFile } from "@ste-memory/core/memory/chat-mirror";
import type { MemorySpaceBackup } from "@ste-memory/core/memory/export";
import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { ChatSpaceBinding } from "../space-binding/chat-space-manager.ts";
import {
  CHAT_METADATA_BINDING_KEY,
  CHAT_METADATA_MIRROR_KEY,
  StChatAdapter,
  type StContext,
  type StEventBridge,
} from "./st-chat-adapter.ts";

const BINDING: ChatSpaceBinding = {
  version: 1,
  spaceId: "space-1" as MemorySpaceId,
};

/** 建一个可变 fake ST 上下文（adapter 持有 getContext 工厂，测试可中途改字段模拟 ST 行为） */
function fakeContext(overrides: Partial<StContext> = {}): StContext & {
  chatMetadata: Record<string, unknown>;
} {
  const chatMetadata: Record<string, unknown> = {};
  return {
    chatId: "story",
    characterId: 3,
    groupId: null,
    name2: "爱丽丝",
    chat: [],
    chatMetadata,
    ...overrides,
  };
}

/** 稳定上下文 + 绑定其上的 adapter（每次访问都重取同一对象） */
function stableAdapter(overrides: Partial<StContext> = {}) {
  const context = fakeContext(overrides);
  return { context, adapter: new StChatAdapter(() => context) };
}

describe("StChatAdapter.getChatSnapshot（对话快照）", () => {
  it("映射 chatId / groupId / name2 / characterId", () => {
    const { adapter } = stableAdapter();
    expect(adapter.getChatSnapshot()).toEqual({
      chatId: "story",
      characterId: 3,
      groupId: null,
      characterName: "爱丽丝",
    });
  });

  it("每次调用重取上下文：切对话后快照跟随（ST getContext 每次构造新对象）", () => {
    const { context, adapter } = stableAdapter();
    context.chatId = "other";
    expect(adapter.getChatSnapshot().chatId).toBe("other");
  });

  it("空串 chatId 按未保存处理（undefined）", () => {
    const { adapter } = stableAdapter({ chatId: "" });
    expect(adapter.getChatSnapshot().chatId).toBeUndefined();
  });

  it("群聊快照：groupId 有值、characterId 为 undefined", () => {
    const { adapter } = stableAdapter({
      groupId: "g1",
      characterId: undefined,
      name2: undefined,
    });
    expect(adapter.getChatSnapshot()).toEqual({
      chatId: "story",
      characterId: undefined,
      groupId: "g1",
      characterName: undefined,
    });
  });
});

describe("StChatAdapter.bindingStore（chatMetadata 绑定读写）", () => {
  it("写入后读回同值（bound），且写入即触发 saveMetadataDebounced", () => {
    const saveMetadataDebounced = vi.fn();
    const { context, adapter } = stableAdapter({ saveMetadataDebounced });

    expect(adapter.bindingStore.read()).toEqual({ kind: "none" });
    adapter.bindingStore.write(BINDING);

    expect(context.chatMetadata[CHAT_METADATA_BINDING_KEY]).toEqual(BINDING);
    expect(adapter.bindingStore.read()).toEqual({ kind: "bound", binding: BINDING });
    expect(saveMetadataDebounced).toHaveBeenCalledTimes(1);
  });

  it("无 chatMetadata / 无 saveMetadataDebounced 时不报错", () => {
    const { adapter } = stableAdapter({ chatMetadata: undefined });
    expect(() => {
      adapter.bindingStore.write(BINDING);
      adapter.bindingStore.read();
    }).not.toThrow();
  });

  it("损坏的绑定值（version 不符 / spaceId 非字符串）= unrecognized，而非 none", () => {
    const { context, adapter } = stableAdapter();
    context.chatMetadata[CHAT_METADATA_BINDING_KEY] = { version: 2, spaceId: "space-1" };
    expect(adapter.bindingStore.read()).toEqual({ kind: "unrecognized" });

    context.chatMetadata[CHAT_METADATA_BINDING_KEY] = { version: 1, spaceId: 42 };
    expect(adapter.bindingStore.read()).toEqual({ kind: "unrecognized" });

    context.chatMetadata[CHAT_METADATA_BINDING_KEY] = "not-an-object";
    expect(adapter.bindingStore.read()).toEqual({ kind: "unrecognized" });
  });
});

describe("StChatAdapter.mirrorStore（chatMetadata 镜像读写，ticket 16）", () => {
  it("读返回原始值（无 = undefined）；写入即触发 saveMetadataDebounced 且键独立于绑定键", () => {
    const saveMetadataDebounced = vi.fn();
    const { context, adapter } = stableAdapter({ saveMetadataDebounced });
    const mirror = createChatMirrorFile(
      {
        space: {
          id: "space-1" as MemorySpaceId,
          name: "爱丽丝 - story",
          createdAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T01:00:00.000Z",
        },
        tables: [],
        fields: [],
        records: [],
        history: [],
        evidence: [],
      } as MemorySpaceBackup,
      "space-1",
      "2026-08-10T01:00:00.000Z",
      "0.1.0",
    );

    expect(adapter.mirrorStore.read()).toBeUndefined();
    adapter.mirrorStore.write(mirror);

    expect(context.chatMetadata[CHAT_METADATA_MIRROR_KEY]).toBe(mirror);
    expect(context.chatMetadata[CHAT_METADATA_BINDING_KEY]).toBeUndefined(); // 键独立
    expect(adapter.mirrorStore.read()).toBe(mirror);
    expect(saveMetadataDebounced).toHaveBeenCalledTimes(1);
  });

  it("无 chatMetadata / 无 saveMetadataDebounced 时不报错", () => {
    const { adapter } = stableAdapter({ chatMetadata: undefined });
    expect(() => {
      adapter.mirrorStore.write(
        createChatMirrorFile(
          {
            space: {
              id: "space-1" as MemorySpaceId,
              name: "爱丽丝 - story",
              createdAt: "2026-08-10T00:00:00.000Z",
              updatedAt: "2026-08-10T01:00:00.000Z",
            },
            tables: [],
            fields: [],
            records: [],
            history: [],
            evidence: [],
          } as MemorySpaceBackup,
          "space-1",
          "2026-08-10T01:00:00.000Z",
          "0.1.0",
        ),
      );
      adapter.mirrorStore.read();
    }).not.toThrow();
  });
});

describe("StChatAdapter.registerEventBridge（事件桥）", () => {
  function fakeEventSource() {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    return {
      handlers,
      eventSource: {
        on: vi.fn(
          (event: string, handler: (...args: unknown[]) => void) =>
            void handlers.set(event, handler),
        ),
      },
      eventTypes: {
        CHAT_CHANGED: "chat_id_changed",
        MESSAGE_SENT: "message_sent",
        MESSAGE_RECEIVED: "message_received",
      },
    };
  }

  it("注册 CHAT_CHANGED / MESSAGE_SENT / MESSAGE_RECEIVED 三个事件", () => {
    const { handlers, eventSource, eventTypes } = fakeEventSource();
    const { adapter } = stableAdapter({ eventSource, eventTypes });
    const bridge: StEventBridge = { onChatChanged: vi.fn(), onMessageEvent: vi.fn() };

    adapter.registerEventBridge(bridge);

    expect(eventSource.on).toHaveBeenCalledTimes(3);
    expect(handlers.has("chat_id_changed")).toBe(true);
    expect(handlers.has("message_sent")).toBe(true);
    expect(handlers.has("message_received")).toBe(true);
  });

  it("CHAT_CHANGED 触发 onChatChanged；消息事件触发 onMessageEvent（payload 被忽略）", () => {
    const { handlers, eventSource, eventTypes } = fakeEventSource();
    const { adapter } = stableAdapter({ eventSource, eventTypes });
    const bridge: StEventBridge = { onChatChanged: vi.fn(), onMessageEvent: vi.fn() };
    adapter.registerEventBridge(bridge);

    handlers.get("chat_id_changed")!("story");
    handlers.get("message_sent")!(3);
    handlers.get("message_received")!(4, "normal");

    expect(bridge.onChatChanged).toHaveBeenCalledTimes(1);
    expect(bridge.onMessageEvent).toHaveBeenCalledWith("message_sent");
    expect(bridge.onMessageEvent).toHaveBeenCalledWith("message_received");
    expect(bridge.onMessageEvent).toHaveBeenCalledTimes(2);
  });

  it("缺 eventSource / eventTypes（异常 ST 环境）时静默跳过注册", () => {
    const { adapter } = stableAdapter({ eventSource: undefined });
    expect(() =>
      adapter.registerEventBridge({ onChatChanged: vi.fn(), onMessageEvent: vi.fn() }),
    ).not.toThrow();
  });
});

describe("StChatAdapter.scrollToFloor（楼层跳转）", () => {
  it("越界楼层（含空对话/负数）→ out-of-range 带 chatLength", () => {
    const { adapter } = stableAdapter({ chat: [{}, {}, {}] });
    expect(adapter.scrollToFloor(3)).toEqual({ kind: "out-of-range", chatLength: 3 });
    expect(adapter.scrollToFloor(-1)).toEqual({ kind: "out-of-range", chatLength: 3 });

    const { adapter: empty } = stableAdapter({ chat: [] });
    expect(empty.scrollToFloor(0)).toEqual({ kind: "out-of-range", chatLength: 0 });
  });

  it("范围内楼层：非浏览器环境不触碰 DOM，返回 not-loaded", () => {
    const { adapter } = stableAdapter({ chat: [{}, {}, {}] });
    expect(adapter.scrollToFloor(1)).toEqual({ kind: "not-loaded" });
  });

  it("无 chat 数组时按空对话处理", () => {
    const { adapter } = stableAdapter({ chat: undefined });
    expect(adapter.scrollToFloor(0)).toEqual({ kind: "out-of-range", chatLength: 0 });
  });
});

describe("StChatAdapter.getMessageAt（楼层消息读取，ticket 11）", () => {
  it("映射 ST 消息 mes/name/is_user → content/name/isUser（含用户消息）", () => {
    const { adapter } = stableAdapter({
      chat: [
        { mes: "你好", name: "User", is_user: true },
        { mes: "你好呀，今天过得怎么样？", name: "爱丽丝", is_user: false },
      ],
    });
    expect(adapter.getMessageAt(0)).toEqual({
      floor: 0,
      content: "你好",
      name: "User",
      isUser: true,
    });
    expect(adapter.getMessageAt(1)).toEqual({
      floor: 1,
      content: "你好呀，今天过得怎么样？",
      name: "爱丽丝",
      isUser: false,
    });
  });

  it("楼层越界 / 负楼层 / 非整数 → undefined", () => {
    const { adapter } = stableAdapter({ chat: [{ mes: "hi" }] });
    expect(adapter.getMessageAt(1)).toBeUndefined();
    expect(adapter.getMessageAt(-1)).toBeUndefined();
    expect(adapter.getMessageAt(0.5)).toBeUndefined();
  });

  it("chat 缺失 / 非数组 / 消息缺 mes 正文 → undefined（不抛错）", () => {
    const { adapter: noChat } = stableAdapter({ chat: undefined });
    expect(noChat.getMessageAt(0)).toBeUndefined();

    const { adapter: empty } = stableAdapter({ chat: [] });
    expect(empty.getMessageAt(0)).toBeUndefined();

    const { adapter: noMes } = stableAdapter({ chat: [{ name: "x" }, null, "text"] });
    expect(noMes.getMessageAt(0)).toBeUndefined();
    expect(noMes.getMessageAt(1)).toBeUndefined();
    expect(noMes.getMessageAt(2)).toBeUndefined();
  });
});

describe("StChatAdapter 填表任务消息来源（chatMessageCount / messagesInRange，ticket 13）", () => {
  it("chatMessageCount：消息数组长度；chat 缺失/非数组按 0", () => {
    const { adapter } = stableAdapter({ chat: [{}, {}, {}] });
    expect(adapter.chatMessageCount()).toBe(3);
    expect(stableAdapter({ chat: undefined }).adapter.chatMessageCount()).toBe(0);
    expect(
      stableAdapter({ chat: "nope" as unknown as readonly unknown[] }).adapter.chatMessageCount(),
    ).toBe(0);
  });

  it("chatId：ST chatId 原样返回；未保存对话（空串/缺失）为 undefined", () => {
    expect(stableAdapter().adapter.chatId()).toBe("story");
    expect(stableAdapter({ chatId: undefined }).adapter.chatId()).toBeUndefined();
    expect(stableAdapter({ chatId: "" }).adapter.chatId()).toBeUndefined();
  });

  it("messagesInRange：闭区间楼层升序映射（floor/content/name），越界楼层跳过，缺正文跳过", () => {
    const { adapter } = stableAdapter({
      chat: [
        { mes: "消息 0", name: "User", is_user: true },
        { mes: "[reg] 原始 **标记**", name: "爱丽丝", is_user: false },
        { name: "无正文" },
        { mes: "消息 3" },
      ],
    });
    expect(adapter.messagesInRange(0, 3)).toEqual([
      { floor: 0, content: "消息 0", name: "User", isUser: true },
      { floor: 1, content: "[reg] 原始 **标记**", name: "爱丽丝", isUser: false },
      { floor: 3, content: "消息 3", name: "", isUser: false },
    ]);
    // 越界楼层（chat 只有 4 条）：跳过缺失楼层
    expect(adapter.messagesInRange(2, 5)).toEqual([
      { floor: 3, content: "消息 3", name: "", isUser: false },
    ]);
    expect(stableAdapter({ chat: undefined }).adapter.messagesInRange(0, 1)).toEqual([]);
  });
});
