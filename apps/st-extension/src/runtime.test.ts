import { SYSTEM_TABLE_TEMPLATES } from "@ste-memory/memory-host-shared";
import { describe, expect, it, vi } from "vitest";
// fake-indexeddb 必须先于 dexie 模块求值（test-support 第一行 import "fake-indexeddb/auto"），
// 因此 test-support 必须排在任何导入 dexie 的模块之前
import { createTestDatabase } from "./db/test-support.ts";
import { DexieMemorySpaceRepository, DexieMemoryTableRepository } from "./db/index.ts";
import { startSteMemory } from "./runtime.ts";
import { DEFAULT_SETTINGS, type SettingsStore } from "./settings/plugin-settings.ts";
import {
  CHAT_METADATA_BINDING_KEY,
  CHAT_METADATA_MIRROR_KEY,
  type StContext,
} from "./st/st-chat-adapter.ts";
import { createChatMirrorFile } from "@ste-memory/core/memory/chat-mirror";
import type { MemorySpaceBackup } from "@ste-memory/core/memory/export";
import type { MemorySpaceId } from "@ste-memory/core/memory";
import { UNSAVED_CHAT_MESSAGE } from "./space-binding/chat-space-manager.ts";

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fakeStContext(overrides: Partial<StContext> = {}): {
  context: StContext;
  chatMetadata: Record<string, unknown>;
  handlers: Map<string, (...args: unknown[]) => void>;
} {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const chatMetadata: Record<string, unknown> = {};
  const context: StContext = {
    chatId: "story",
    characterId: 3,
    groupId: null,
    name2: "爱丽丝",
    chat: [{}, {}],
    chatMetadata,
    saveMetadataDebounced: vi.fn(),
    eventSource: {
      on: (event, handler) => void handlers.set(event, handler),
    },
    eventTypes: {
      CHAT_CHANGED: "chat_id_changed",
      MESSAGE_SENT: "message_sent",
      MESSAGE_RECEIVED: "message_received",
    },
    ...overrides,
  };
  return { context, chatMetadata, handlers };
}

describe("startSteMemory（组合根：持久层 + 事件桥 + 首次同步）", () => {
  it("首次打开对话：建空间 + 写绑定 + 系统表就位；再次打开不重复建", async () => {
    const db = createTestDatabase();
    const { context, chatMetadata } = fakeStContext();

    const runtime = await startSteMemory(() => context, { createDb: () => db, log: fakeLog() });

    const status = runtime.manager.getStatus();
    expect(status?.kind).toBe("active");
    if (status?.kind !== "active") return;
    expect(status.created).toBe(true);
    expect(status.space.name).toBe("爱丽丝 - story");
    expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toEqual({
      version: 1,
      spaceId: status.space.id,
    });

    const spaceRepository = new DexieMemorySpaceRepository(db);
    const tableRepository = new DexieMemoryTableRepository(db);
    expect(await spaceRepository.list()).toHaveLength(1);
    expect(await tableRepository.list(status.space.id)).toHaveLength(SYSTEM_TABLE_TEMPLATES.length);

    // 再次打开（同库同 metadata）：直接激活，不重复建
    const reopened = await startSteMemory(() => context, { createDb: () => db, log: fakeLog() });
    const reopenedStatus = reopened.manager.getStatus();
    expect(reopenedStatus?.kind).toBe("active");
    if (reopenedStatus?.kind !== "active") return;
    expect(reopenedStatus.created).toBe(false);
    expect(reopenedStatus.space.id).toBe(status.space.id);
    expect(await spaceRepository.list()).toHaveLength(1);
  });

  it("CHAT_CHANGED 切换空间上下文；消息事件已注册但无消费方", async () => {
    const db = createTestDatabase();
    const { context, handlers } = fakeStContext();
    const runtime = await startSteMemory(() => context, { createDb: () => db, log: fakeLog() });

    // ST 切对话：CHAT_CHANGED（payload = 新 chatId，事件桥重读快照）；
    // chatMetadata 被整体替换（载入新对话文件，无绑定）
    context.chatId = "other";
    context.chatMetadata = {};
    handlers.get("chat_id_changed")!("other");
    await runtime.manager.syncToCurrentChat(); // 排在事件触发的同步之后

    const status = runtime.manager.getStatus();
    expect(status?.kind).toBe("active");
    if (status?.kind !== "active") return;
    expect(status.space.name).toBe("爱丽丝 - other");

    // 消息事件：已注册，调用不报错、不改变状态（未来自动填表触发点）
    expect(() => {
      handlers.get("message_sent")!(1);
      handlers.get("message_received")!(2, "normal");
    }).not.toThrow();
    expect(runtime.manager.getStatus()).toBe(status);
  });

  it("临时/未保存对话：状态 unsaved-chat，不建空间、不报错", async () => {
    const db = createTestDatabase();
    const { context, chatMetadata } = fakeStContext({ chatId: undefined });

    const runtime = await startSteMemory(() => context, { createDb: () => db, log: fakeLog() });

    expect(runtime.manager.getStatus()).toEqual({
      kind: "unsaved-chat",
      humanMsg: UNSAVED_CHAT_MESSAGE,
    });
    expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toBeUndefined();
    expect(await new DexieMemorySpaceRepository(db).list()).toHaveLength(0);
  });

  it("运行时暴露 core 服务、设置存储与版本（面板 UI 的访问点）", async () => {
    const db = createTestDatabase();
    const { context } = fakeStContext();
    const runtime = await startSteMemory(() => context, {
      createDb: () => db,
      log: fakeLog(),
      version: "9.9.9",
    });

    expect(runtime.version).toBe("9.9.9");
    expect(runtime.settings.read()).toEqual(DEFAULT_SETTINGS);
    // 云同步协调器就位：未配置 R2 时状态 unconfigured、无任何云端活动
    expect(runtime.sync.getStatus()).toEqual({ kind: "unconfigured" });
    const status = runtime.manager.getStatus();
    if (status?.kind !== "active") throw new Error("expect active");
    // 服务可列出系统表与字段（面板表格列表的数据来源）；系统表均带预置字段
    const tables = await runtime.tables.list(status.space.id);
    expect(tables.length).toBeGreaterThan(0);
    const firstTable = tables[0]!;
    expect((await runtime.fields.list(status.space.id, firstTable.id)).length).toBeGreaterThan(0);
  });

  it("插件总开关停用：启动不建空间、CHAT_CHANGED 不响应；重新启用后恢复同步", async () => {
    const db = createTestDatabase();
    const { context, handlers, chatMetadata } = fakeStContext();
    const spaceRepository = new DexieMemorySpaceRepository(db);
    let settings = { ...DEFAULT_SETTINGS, enabled: false };
    const settingsStore: SettingsStore = {
      read: () => settings,
      write: (next) => {
        settings = next;
      },
    };

    const runtime = await startSteMemory(() => context, {
      createDb: () => db,
      log: fakeLog(),
      settingsStore,
    });

    // 停用：无空间、无绑定、状态未发布
    expect(runtime.manager.getStatus()).toBeUndefined();
    expect(await spaceRepository.list()).toHaveLength(0);
    expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toBeUndefined();

    // 停用期间 CHAT_CHANGED 被门控跳过（事件桥不排队同步，状态不发布）
    handlers.get("chat_id_changed")!("other");
    expect(runtime.manager.getStatus()).toBeUndefined();
    expect(await spaceRepository.list()).toHaveLength(0);

    // 设置面板重新启用（写存储后触发同步，等价宿主行为）
    settingsStore.write({ ...settings, enabled: true });
    await runtime.manager.syncToCurrentChat();
    const status = runtime.manager.getStatus();
    expect(status?.kind).toBe("active");
    expect(await spaceRepository.list()).toHaveLength(1);

    // 启用后 CHAT_CHANGED 恢复响应
    context.chatId = "other";
    context.chatMetadata = {};
    handlers.get("chat_id_changed")!("other");
    await runtime.manager.syncToCurrentChat();
    expect(runtime.manager.getStatus()?.kind).toBe("active");
    expect(await spaceRepository.list()).toHaveLength(2);
  });

  it("对话文件镜像：默认启用（idle 状态），设置关闭后 disabled 且不写", async () => {
    const db = createTestDatabase();
    const { context } = fakeStContext();
    let settings = { ...DEFAULT_SETTINGS };
    const settingsStore: SettingsStore = {
      read: () => settings,
      write: (next) => {
        settings = next;
      },
    };
    const runtime = await startSteMemory(() => context, {
      createDb: () => db,
      log: fakeLog(),
      settingsStore,
    });

    // 默认设置镜像启用：启动评估后为 idle（尚未写回），写回由轮询+防抖驱动（seam 已测）
    const status = runtime.mirror.getStatus();
    expect(status.kind).toBe("idle");
    if (status.kind !== "idle") return;
    expect(status.lastWrittenAt).toBeUndefined();

    // 设置关闭镜像：kick 后回到 disabled
    settingsStore.write({ ...settings, mirror: { enabled: false, includeHistory: true } });
    await runtime.mirror.kick();
    expect(runtime.mirror.getStatus()).toEqual({ kind: "disabled" });
  });

  it("绑定在、空间缺失、文件里有有效镜像：启动即从镜像恢复（active/restored，数据落地）", async () => {
    const db = createTestDatabase();
    const unit: MemorySpaceBackup = {
      space: {
        id: "space-ghost" as MemorySpaceId,
        name: "爱丽丝 - story",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
      tables: [],
      fields: [],
      records: [],
      history: [],
      evidence: [],
    };
    const { context, chatMetadata } = fakeStContext();
    chatMetadata[CHAT_METADATA_BINDING_KEY] = { version: 1, spaceId: "space-ghost" };
    chatMetadata[CHAT_METADATA_MIRROR_KEY] = createChatMirrorFile(
      unit,
      "space-ghost",
      "2026-08-10T00:00:00.000Z",
      "0.1.0",
    );

    const runtime = await startSteMemory(() => context, { createDb: () => db, log: fakeLog() });

    const status = runtime.manager.getStatus();
    expect(status?.kind).toBe("active");
    if (status?.kind !== "active") return;
    expect(status.restored).toBe(true);
    expect(status.space.id).toBe("space-ghost");
    // 数据真实落地（restoreSpace 写入），绑定原样保留
    const spaceRepository = new DexieMemorySpaceRepository(db);
    expect(await spaceRepository.list()).toHaveLength(1);
    expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toEqual({ version: 1, spaceId: "space-ghost" });
  });

  it("绑定在、空间缺失、文件里无有效镜像：保持 space-missing（等待云同步/用户处理）", async () => {
    const db = createTestDatabase();
    const { context, chatMetadata } = fakeStContext();
    chatMetadata[CHAT_METADATA_BINDING_KEY] = { version: 1, spaceId: "space-ghost" };

    const runtime = await startSteMemory(() => context, { createDb: () => db, log: fakeLog() });

    expect(runtime.manager.getStatus()?.kind).toBe("space-missing");
    const spaceRepository = new DexieMemorySpaceRepository(db);
    expect(await spaceRepository.list()).toHaveLength(0);
  });
});

describe("startSteMemory → createLlm（ticket 12 接线）", () => {
  it("端口读 ST 当前配置：模型名/source 与 getChatCompletionModel 映射一致", async () => {
    const db = createTestDatabase();
    const { context } = fakeStContext({
      chatCompletionSettings: {
        chat_completion_source: "custom",
        temp_openai: 0.6,
        openai_max_tokens: 1500,
        openai_max_context: 16_384,
      },
      getChatCompletionModel: (settings) =>
        settings.chat_completion_source === "custom" ? "my-model" : "",
    });
    const runtime = await startSteMemory(() => context, { createDb: () => db, log: fakeLog() });
    const port = runtime.createLlm();
    expect(port.model.id).toBe("my-model");
    expect(port.model.contextWindow).toBe(16_384);
    expect(port.model.maxTokens).toBe(1500);
    // ST 配置缺失（非 ST 环境）→ 端口构造抛中文错误而非静默
    const bare = fakeStContext({ chatCompletionSettings: undefined });
    const runtimeBare = await startSteMemory(() => bare.context, { createDb: () => db, log: fakeLog() });
    expect(() => runtimeBare.createLlm()).toThrow(/Chat Completion 源未知/);
  });
});
