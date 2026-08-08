import { describe, expect, it, vi } from "vitest";
import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { ChatSpaceBinding } from "../space-binding/chat-space-manager.ts";
import {
  CHAT_METADATA_BINDING_KEY,
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

describe("StChatAdapter.registerEventBridge（事件桥）", () => {
  function fakeEventSource() {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    return {
      handlers,
      eventSource: {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) =>
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
