import { SYSTEM_TABLE_TEMPLATES } from "@ste-memory/memory-host-shared";
import { describe, expect, it, vi } from "vitest";
// fake-indexeddb 必须先于 dexie 模块求值（test-support 第一行 import "fake-indexeddb/auto"），
// 因此 test-support 必须排在任何导入 dexie 的模块之前
import { createTestDatabase } from "./db/test-support.ts";
import {
  DexieFillTaskRepository,
  DexieMemorySpaceRepository,
  DexieMemoryTableRepository,
} from "./db/index.ts";
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

  it("记忆宏：切对话（空间切换）后快照立即重建，不等指纹轮询", async () => {
    const db = createTestDatabase();
    const { context, handlers } = fakeStContext({
      extensionSettings: {},
      macros: {
        register: () => {},
        registry: { unregisterMacro: () => false },
      },
    });
    const runtime = await startSteMemory(() => context, { createDb: () => db, log: fakeLog() });
    const status = runtime.manager.getStatus();
    if (status?.kind !== "active") throw new Error("expect active");
    const firstSpaceId = status.space.id;

    // 给空间一加一条记录（人物表），快照重建
    const characters = (await runtime.tables.list(firstSpaceId)).find((t) => t.key === "characters");
    if (!characters) throw new Error("expect characters table");
    const nameField = (await runtime.fields.list(firstSpaceId, characters.id)).find((f) => f.key === "name");
    if (!nameField) throw new Error("expect name field");
    await runtime.records.create(firstSpaceId, characters.id, {
      payload: { [nameField.id]: "张三" },
    });
    await runtime.macro.kick();
    expect(runtime.macro.getSnapshot()).toContain("张三");

    // 切到对话二（新空间）：CHAT_CHANGED → 状态发布 → 快照立即清空重建
    context.chatId = "other";
    context.chatMetadata = {};
    handlers.get("chat_id_changed")!("other");
    await runtime.manager.syncToCurrentChat();
    // 状态订阅触发 macro.kick（异步：指纹查询走 IndexedDB，非纯微任务）；
    // 500ms 内快照切到新空间即证明 kick 生效——轮询间隔 2s，不可能在此窗口内
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && runtime.macro.getSnapshot() !== "") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(runtime.macro.getSnapshot()).toBe("");
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

  it("记忆宏接线（ticket 15）：默认宏名注册；数据变更后快照含最新记忆；改名/停用注销", async () => {
    const db = createTestDatabase();
    const registered = new Map<string, (context: unknown) => string>();
    const { context } = fakeStContext({
      // 设置写入需要 extensionSettings 对象（缺失时 StSettingsStore 静默跳过写入）
      extensionSettings: {},
      macros: {
        register: (name, options) => void registered.set(name, options.handler),
        registry: { unregisterMacro: (name) => registered.delete(name) },
      },
    });
    const runtime = await startSteMemory(() => context, { createDb: () => db, log: fakeLog() });
    const status = runtime.manager.getStatus();
    if (status?.kind !== "active") throw new Error("expect active");

    // 默认名 {{memoryContext}} 解析为裸标识符注册；ticket 17 追加 tablesDigest /
    // systemDefaultPrompt（Agent 预设宏）；空库无记录：空表省略 → 快照为空串
    expect([...registered.keys()].sort()).toEqual(
      ["memoryContext", "tablesDigest", "systemDefaultPrompt"].sort(),
    );
    expect(runtime.macro.getSnapshot()).toBe("");
    // Agent 预设宏（ticket 17）：{{tablesDigest}} 快照 = 已激活空间的启用表摘要
    expect(runtime.agentMacro.getSnapshot().digestText).toContain("可用表与字段");
    expect(runtime.agentMacro.getSnapshot().digestText).toContain("【characters｜人物】");
    expect(runtime.agentMacro.getSnapshot().defaultPromptText).toContain("你是记忆表格填写助手");

    // 手动创建一条记录（人物表，必填 name）：kick 后快照重建，handler 展开最新记忆
    const charactersTable = status.space
      ? (await runtime.tables.list(status.space.id)).find((t) => t.key === "characters")
      : undefined;
    if (!charactersTable) throw new Error("expect characters table");
    const nameField = (await runtime.fields.list(status.space.id, charactersTable.id)).find(
      (f) => f.key === "name",
    );
    if (!nameField) throw new Error("expect name field");
    await runtime.records.create(status.space.id, charactersTable.id, {
      payload: { [nameField.id]: "张三" },
    });
    await runtime.macro.kick();
    const snapshot = registered.get("memoryContext")!({});
    expect(snapshot).toContain("【人物】");
    expect(snapshot).toContain("张三");
    expect(runtime.macro.getSnapshot()).toBe(snapshot);

    // 设置面板改名：写设置 + kick → 注销旧名、注册新名（Agent 预设宏不变）
    const next = { ...runtime.settings.read(), macroName: "{{myMemory}}" };
    runtime.settings.write(next);
    await runtime.macro.kick();
    expect([...registered.keys()].sort()).toEqual(
      ["myMemory", "tablesDigest", "systemDefaultPrompt"].sort(),
    );

    // 插件总开关关闭：注销（无注入）
    runtime.settings.write({ ...next, enabled: false });
    await runtime.macro.kick();
    await runtime.agentMacro.kick();
    expect(registered.size).toBe(0);
  });

  it("填表任务接线（ticket 13）：启动把非终态任务标记 interrupted（关页不自动重放）；tasks 暴露可用", async () => {
    const db = createTestDatabase();
    const { context } = fakeStContext({ chat: [{ mes: "hi" }] });
    // 预置一个 running 任务（模拟上一页会话遗留）：启动后应被标记 interrupted
    const tasks = new DexieFillTaskRepository(db);
    await tasks.create({
      runId: "run-leftover",
      memorySpaceId: "space-leftover" as MemorySpaceId,
      from: 0,
      to: 0,
      blockSize: 20,
      chatId: null,
      status: "running",
      errorMessage: null,
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    });

    const runtime = await startSteMemory(() => context, { createDb: () => db, log: fakeLog() });

    // 启动即中断：不自动重放、不占用活动名额
    const leftover = await tasks.find("run-leftover");
    expect(leftover).toMatchObject({ status: "interrupted", errorMessage: null });
    expect(runtime.tasks).toBeDefined();
    expect(await runtime.tasks.activeTask("space-leftover" as MemorySpaceId)).toBeUndefined();
    // 任务服务从 ST 上下文读消息数（触发 UI 的数据源接线）
    expect(runtime.adapter.chatMessageCount()).toBe(1);
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
    const runtimeBare = await startSteMemory(() => bare.context, {
      createDb: () => db,
      log: fakeLog(),
    });
    expect(() => runtimeBare.createLlm()).toThrow(/Chat Completion 源未知/);
  });
});
