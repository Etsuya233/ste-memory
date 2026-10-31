import { migrateMemoryView } from "./features/macros/macro-expression.ts";
import { SYSTEM_TABLE_TEMPLATES } from "./features/memory/index.ts";
import { describe, expect, it, vi } from "vitest";
// fake-indexeddb 必须先于 dexie 模块求值（test-support 第一行 import "fake-indexeddb/auto"），
// 因此 test-support 必须排在任何导入 dexie 的模块之前
import {
  createTestDatabase,
  createTestLogDatabase,
} from "./infrastructure/indexeddb/test-support.ts";
import {
  DexieFillTaskRepository,
  DexieMemoryBackupRepository,
  DexieMemorySpaceRepository,
  DexieMemoryTableRepository,
} from "./infrastructure/indexeddb/index.ts";
import { startSteMemory, type StartSteMemoryOptions, type SteMemoryRuntime } from "./runtime.ts";
import type { StBackendsModel } from "./infrastructure/sillytavern/llm/st-completion-settings.ts";
import {
  DEFAULT_SETTINGS,
  type PluginSettings,
  type SettingsStore,
} from "./features/settings/plugin-settings.ts";
import {
  CHAT_METADATA_AGENT_PRESET_KEY,
  CHAT_METADATA_BINDING_KEY,
  CHAT_METADATA_CLEANING_RULE_KEY,
  CHAT_METADATA_MIRROR_KEY,
  type StContext,
} from "./infrastructure/sillytavern/chat-adapter.ts";
import { createChatMirrorFile } from "./features/chat-mirror/index.ts";
import { CHAT_METADATA_CHAT_SCOPE_MACROS_KEY } from "./infrastructure/sillytavern/chat-adapter.ts";
import { SYSTEM_TABLE_PRESET } from "./features/table-presets/system-preset.ts";
import type { MemorySpaceBackup } from "./features/backup/index.ts";
import type { MemoryMacro, MemorySpaceId } from "./features/memory/index.ts";
import { UNSAVED_CHAT_MESSAGE } from "./features/chat-binding/chat-space-manager.ts";
import { createRuntimeTestPorts } from "./infrastructure/memory-runtime/test-support.ts";

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
    characters: [
      { avatar: "other0.png" },
      { avatar: "other1.png" },
      { avatar: "other2.png" },
      { avatar: "alice.png" },
    ],
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

/** 组合根测试启动：独立日志库也注入一次性测试库（afterEach 统一删除）。 */
function startTestRuntime(
  getContext: () => unknown,
  options: StartSteMemoryOptions,
): Promise<SteMemoryRuntime> {
  return startSteMemory(getContext, {
    createLogDb: () => createTestLogDatabase(),
    ...createRuntimeTestPorts(getContext),
    ...options,
  });
}

describe("startSteMemory（组合根：持久层 + 事件桥 + 首次同步）", () => {
  it("公开聊天按当前对话清洗配置读取，并拒绝悬空规则和旧对话", async () => {
    const db = createTestDatabase();
    const { context } = fakeStContext({
      chat: [
        { name: "用户", is_user: true, mes: "<story>用户原文</story>" },
        { name: "角色", mes: "<story>剧情正文</story><panel>附加面板</panel>" },
      ],
    });
    const runtime = await startTestRuntime(() => context, {
      createDb: () => db,
      log: fakeLog(),
      settingsStore: {
        read: () => ({
          ...DEFAULT_SETTINGS,
          cleaningRules: [
            {
              id: "story",
              name: "剧情正文",
              enabled: true,
              keepTags: [{ pre: "<story>", post: "</story>" }],
              excludeTags: [],
            },
          ],
        }),
        write: () => {},
      },
    });
    const chat = runtime.publicRead.chat!;
    const request = { chatIdentity: runtime.publicRead.getContext().chatIdentity!, count: 20 };
    expect((await chat.readRecent(request)).cleaning.enabled).toBe(false);
    runtime.cleaning.writeSelection("story");
    const snapshot = await chat.readRecent(request);
    expect(snapshot.messages.map((message) => message.content)).toEqual([
      "<story>用户原文</story>",
      "剧情正文",
    ]);
    expect(snapshot.cleaning).toEqual({ enabled: true, ruleId: "story", ruleName: "剧情正文" });
    runtime.cleaning.writeSelection("deleted");
    await expect(chat.readRecent(request)).rejects.toThrow("清洗规则已不存在");
    context.chatId = "other";
    await expect(chat.readRecent(request)).rejects.toThrow("对话已变化");
  });

  it("公共读取在提交后通知，切换聊天立即拒绝旧空间归属", async () => {
    const db = createTestDatabase();
    const { context, handlers } = fakeStContext();
    const runtime = await startTestRuntime(() => context, { createDb: () => db, log: fakeLog() });
    const initial = await runtime.publicRead.read();
    const changed = vi.fn();
    const unsubscribe = runtime.publicRead.subscribe(changed);
    await runtime.tables.create(initial.snapshot.space.id, {
      key: "read_probe",
      name: "读取测试",
      description: "",
      prompt: "",
      position: 100,
    });
    expect(changed).toHaveBeenCalled();
    const latest = await runtime.publicRead.read();
    expect(latest.context.revision).toBeGreaterThan(initial.context.revision);
    expect(latest.snapshot.tables.some((table) => table.key === "read_probe")).toBe(true);
    const database = runtime.publicRead.database!;
    const binding = {
      chatIdentity: latest.context.chatIdentity!,
      spaceId: latest.snapshot.space.id,
    };
    const schema = await database.describe(binding);
    const queryBinding = { ...binding, schemaKey: schema.schemaKey, namespace: "public_probe" };
    await database.registerViews({
      ...queryBinding,
      views: [{ name: "probe_counts", select: "SELECT count(*) total FROM characters" }],
    });
    const characters = schema.tables.find((table) => table.key === "characters")!;
    const name = schema.fields.find(
      (field) => field.tableId === characters.id && field.key === "name",
    )!;
    await runtime.records.create(latest.snapshot.space.id, characters.id, {
      payload: { [name.id]: "SQL读取测试" },
    });
    expect(
      (await database.query({ ...queryBinding, sql: "SELECT * FROM probe_counts" })).rows,
    ).toEqual([[1]]);
    expect((await database.describe(binding)).schemaKey).toBe(schema.schemaKey);
    context.chatId = "other-read-chat";
    expect(runtime.publicRead.getContext().available).toBe(false);
    await expect(
      database.query({ ...queryBinding, sql: "SELECT * FROM probe_counts" }),
    ).rejects.toThrow("对话");
    context.chatMetadata = {};
    await handlers.get("chat_id_changed")?.();
    expect((await runtime.publicRead.read()).context.chatIdentity).toContain("other-read-chat");
    await expect(database.describe(binding)).rejects.toThrow("对话");
    unsubscribe();
  });
  it("启动和切对话时清除旧清洗选择，保留 v3 选择", async () => {
    const db = createTestDatabase();
    const { context, chatMetadata, handlers } = fakeStContext();
    chatMetadata[CHAT_METADATA_CLEANING_RULE_KEY] = { version: 1, listId: "old" };
    const runtime = await startTestRuntime(() => context, { createDb: () => db, log: fakeLog() });
    expect(chatMetadata[CHAT_METADATA_CLEANING_RULE_KEY]).toBeUndefined();
    context.chatId = "other";
    context.chatMetadata = {
      [CHAT_METADATA_CLEANING_RULE_KEY]: { version: 2, listId: "other-old" },
    };
    await handlers.get("chat_id_changed")?.();
    expect(context.chatMetadata[CHAT_METADATA_CLEANING_RULE_KEY]).toBeUndefined();
    context.chatMetadata[CHAT_METADATA_CLEANING_RULE_KEY] = { version: 3, ruleId: "new" };
    await handlers.get("chat_id_changed")?.();
    expect(context.chatMetadata[CHAT_METADATA_CLEANING_RULE_KEY]).toEqual({
      version: 3,
      ruleId: "new",
    });
    expect(runtime.cleaning.readSelection()).toBe("new");
  });

  it("对话级 Agent 预设覆盖读写 chatMetadata，清除后回到跟随全局", async () => {
    const db = createTestDatabase();
    const { context, chatMetadata, handlers } = fakeStContext();
    const runtime = await startTestRuntime(() => context, { createDb: () => db, log: fakeLog() });
    expect(runtime.agentPresetOverride.read()).toBeUndefined();
    runtime.agentPresetOverride.write("preset-1");
    expect(chatMetadata[CHAT_METADATA_AGENT_PRESET_KEY]).toEqual({
      version: 1,
      presetId: "preset-1",
    });
    expect(runtime.agentPresetOverride.read()).toBe("preset-1");
    context.chatId = "other";
    context.chatMetadata = {};
    await handlers.get("chat_id_changed")?.();
    expect(runtime.agentPresetOverride.read()).toBeUndefined();
    context.chatMetadata = { [CHAT_METADATA_AGENT_PRESET_KEY]: { version: 1, presetId: "p2" } };
    expect(runtime.agentPresetOverride.read()).toBe("p2");
    runtime.agentPresetOverride.write(undefined);
    expect(context.chatMetadata[CHAT_METADATA_AGENT_PRESET_KEY]).toBeUndefined();
  });

  it("首次打开对话：建空间 + 写绑定 + 系统表就位；再次打开不重复建", async () => {
    const db = createTestDatabase();
    const { context, chatMetadata } = fakeStContext();

    const runtime = await startTestRuntime(() => context, { createDb: () => db, log: fakeLog() });

    const status = runtime.manager.getStatus();
    expect(status?.kind).toBe("active");
    if (status?.kind !== "active") return;
    expect(status.created).toBe(true);
    expect(status.space.name).toBe("爱丽丝 - story");
    expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toEqual({
      version: 2,
      spaceId: status.space.id,
      chatIdentity: "char:3:story",
    });

    const spaceRepository = new DexieMemorySpaceRepository(db);
    const tableRepository = new DexieMemoryTableRepository(db);
    expect(await spaceRepository.list()).toHaveLength(1);
    expect(await tableRepository.list(status.space.id)).toHaveLength(SYSTEM_TABLE_TEMPLATES.length);

    // 再次打开（同库同 metadata）：直接激活，不重复建
    const reopened = await startTestRuntime(() => context, { createDb: () => db, log: fakeLog() });
    const reopenedStatus = reopened.manager.getStatus();
    expect(reopenedStatus?.kind).toBe("active");
    if (reopenedStatus?.kind !== "active") return;
    expect(reopenedStatus.created).toBe(false);
    expect(reopenedStatus.space.id).toBe(status.space.id);
    expect(await spaceRepository.list()).toHaveLength(1);
  });

  it("表格预设：新空间按默认预设初始化并记录来源；应用预设重建当前空间（spec table-presets）", async () => {
    const db = createTestDatabase();
    const { context, chatMetadata } = fakeStContext();
    const userPreset = {
      id: "p1",
      name: "我的结构",
      description: "",
      createdAt: "2026-10-18T00:00:00.000Z",
      updatedAt: "2026-10-18T00:00:00.000Z",
      tables: [
        {
          key: "people",
          name: "人物",
          description: "",
          prompt: "",
          enabled: true,
          displayStrategy: { type: "field" as const, fieldKey: "name" },
          fields: [
            {
              key: "name",
              name: "名称",
              type: "short_text" as const,
              required: true,
              prompt: "",
              enabled: true,
              options: [],
              referenceTableKey: null,
              maxChars: 30,
              valuePattern: null,
              valuePatternMessage: null,
            },
          ],
        },
      ],
    };
    let settings: PluginSettings = {
      ...DEFAULT_SETTINGS,
      tablePresets: { userPresets: [userPreset], defaultPresetId: "p1" },
    };
    const settingsStore: SettingsStore = {
      read: () => settings,
      write: (next) => {
        settings = next;
      },
    };

    const runtime = await startTestRuntime(() => context, {
      createDb: () => db,
      log: fakeLog(),
      settingsStore,
    });

    const status = runtime.manager.getStatus();
    if (status?.kind !== "active") throw new Error("expect active");
    // 新空间按默认用户预设初始化，并记录初始化来源
    expect((await runtime.tables.list(status.space.id)).map((table) => table.key)).toEqual([
      "people",
    ]);
    expect((await runtime.spaces.find(status.space.id))?.initializationSource).toMatchObject({
      presetId: "p1",
      presetName: "我的结构",
    });
    // 对话级宏 = 针对旧结构的局部配置
    chatMetadata[CHAT_METADATA_CHAT_SCOPE_MACROS_KEY] = {
      version: 1,
      macros: [
        {
          name: "旧宏",
          tableKey: "people",
          condition: { fieldKey: "name", values: ["林夏"] },
          limit: 20,
        },
      ],
    };

    // 应用到当前空间：系统自带预设（原子重建 + 清除对话级宏）
    const outcome = await runtime.presetApply.applyPreset(status.space.id, SYSTEM_TABLE_PRESET, {
      chatIdentity: status.binding.version === 2 ? status.binding.chatIdentity : "",
      refreshMacros: () => runtime.macro.kick(),
      syncMirror: () =>
        runtime.mirror.flushRebuiltSpace(
          status.space.id,
          status.binding.version === 2 ? status.binding.chatIdentity : "",
        ),
    });
    expect(outcome).toEqual({ kind: "applied" });
    const tables = await runtime.tables.list(status.space.id);
    expect(tables).toHaveLength(SYSTEM_TABLE_TEMPLATES.length);
    expect((await runtime.spaces.find(status.space.id))?.initializationSource).toMatchObject({
      presetId: "systemDefault",
      presetName: "系统默认",
    });
    expect(chatMetadata[CHAT_METADATA_CHAT_SCOPE_MACROS_KEY]).toEqual({ version: 1, macros: [] });
  });

  it("CHAT_CHANGED 切换空间上下文；消息事件已注册但无消费方", async () => {
    const db = createTestDatabase();
    const { context, handlers } = fakeStContext();
    const runtime = await startTestRuntime(() => context, { createDb: () => db, log: fakeLog() });

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

  it("记忆宏仅在生成时计算，切对话立即撤下本次文本", async () => {
    const db = createTestDatabase();
    const { context, handlers } = fakeStContext({
      extensionSettings: {},
      macros: {
        register: () => {},
        registry: { unregisterMacro: () => false },
      },
    });
    const runtime = await startTestRuntime(() => context, { createDb: () => db, log: fakeLog() });
    const status = runtime.manager.getStatus();
    if (status?.kind !== "active") throw new Error("expect active");
    const firstSpaceId = status.space.id;

    // 给空间一加一条记录（人物表），快照重建
    const characters = (await runtime.tables.list(firstSpaceId)).find(
      (t) => t.key === "characters",
    );
    if (!characters) throw new Error("expect characters table");
    const nameField = (await runtime.fields.list(firstSpaceId, characters.id)).find(
      (f) => f.key === "name",
    );
    if (!nameField) throw new Error("expect name field");
    await runtime.records.create(firstSpaceId, characters.id, {
      payload: { [nameField.id]: "张三" },
    });
    await runtime.macro.kick();
    expect(runtime.macro.getSnapshot()).toBe("");
    await runtime.macro.prepare("测试");
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

    const runtime = await startTestRuntime(() => context, { createDb: () => db, log: fakeLog() });

    expect(runtime.manager.getStatus()).toEqual({
      kind: "unsaved-chat",
      humanMsg: UNSAVED_CHAT_MESSAGE,
    });
    expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toBeUndefined();
    expect(await new DexieMemorySpaceRepository(db).list()).toHaveLength(0);
  });

  it("运行时暴露 Memory 服务、设置存储与版本（面板 UI 的访问点）", async () => {
    const db = createTestDatabase();
    const { context } = fakeStContext();
    const runtime = await startTestRuntime(() => context, {
      createDb: () => db,
      log: fakeLog(),
      version: "9.9.9",
    });

    expect(runtime.version).toBe("9.9.9");
    expect(runtime.settings.read()).toEqual(DEFAULT_SETTINGS);
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

    const runtime = await startTestRuntime(() => context, {
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
    const runtime = await startTestRuntime(() => context, {
      createDb: () => db,
      log: fakeLog(),
      settingsStore,
    });

    // 默认设置镜像启用：新空间初始化完成后立即保存完整快照。
    const status = runtime.mirror.getStatus();
    expect(status.kind).toBe("idle");
    if (status.kind !== "idle") return;
    expect(status.lastWrittenAt).toEqual(expect.any(String));
    expect(context.chatMetadata?.[CHAT_METADATA_MIRROR_KEY]).toBeDefined();

    // 设置关闭镜像：kick 后回到 disabled
    settingsStore.write({ ...settings, mirror: { enabled: false, includeHistory: true } });
    await runtime.mirror.kick();
    expect(runtime.mirror.getStatus()).toEqual({ kind: "disabled" });
  });

  it("本地已有较新空间时，同步开启仍以较旧文件快照初始化 SQLite", async () => {
    const db = createTestDatabase();
    const fileUnit: MemorySpaceBackup = {
      space: {
        id: "file-first" as MemorySpaceId,
        name: "文件中的旧版本",
        initializationSource: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
      tables: [],
      fields: [],
      records: [],
      history: [],
      evidence: [],
    };
    await new DexieMemoryBackupRepository(db).restoreSpace({
      ...fileUnit,
      space: { ...fileUnit.space, name: "本地较新版本", updatedAt: "2026-10-24T00:00:00.000Z" },
    });
    const { context, chatMetadata } = fakeStContext();
    chatMetadata[CHAT_METADATA_BINDING_KEY] = {
      version: 2,
      spaceId: "file-first",
      chatIdentity: "char:3:story",
    };
    chatMetadata[CHAT_METADATA_MIRROR_KEY] = createChatMirrorFile(
      fileUnit,
      "file-first",
      fileUnit.space.updatedAt,
      "test",
    );
    const runtime = await startTestRuntime(() => context, { createDb: () => db, log: fakeLog() });
    expect(runtime.manager.getStatus()).toMatchObject({
      kind: "active",
      created: false,
      space: { id: "file-first", name: "文件中的旧版本" },
    });
    expect(await runtime.spaces.find(fileUnit.space.id)).toEqual({ ...fileUnit.space, macros: [] });
    expect(await new DexieMemorySpaceRepository(db).find(fileUnit.space.id)).toEqual({
      ...fileUnit.space,
      macros: [],
    });
  });

  it("切换对话立即重试 A 已提交但未保存的数据，B 初始化不会串写", async () => {
    const db = createTestDatabase();
    const { context, handlers } = fakeStContext();
    const ports = createRuntimeTestPorts(() => context);
    let failNextSave = false;
    const write = vi.fn<typeof ports.snapshotFiles.write>(async (target, file, binding) => {
      if (failNextSave) {
        failNextSave = false;
        throw new Error("file offline");
      }
      await ports.snapshotFiles.write(target, file, binding);
    });
    const runtime = await startTestRuntime(() => context, {
      createDb: () => db,
      log: fakeLog(),
      ...ports,
      snapshotFiles: { read: ports.snapshotFiles.read, write },
    });
    const first = runtime.manager.getStatus();
    if (first?.kind !== "active") throw new Error("expect A active");
    const table = (await runtime.tables.list(first.space.id)).find(
      (item) => item.key === "characters",
    )!;
    const field = (await runtime.fields.list(first.space.id, table.id)).find(
      (item) => item.key === "name",
    )!;
    failNextSave = true;
    await expect(
      runtime.records.create(first.space.id, table.id, {
        payload: { [field.id]: "切换时仍需保存" },
      }),
    ).rejects.toThrow("file offline");
    expect(runtime.mirror.getStatus()).toMatchObject({ kind: "failed" });
    ports.snapshotWrites.length = 0;
    context.chatId = "B";
    context.chatMetadata = { otherPlugin: "B 独有数据" };
    await handlers.get("chat_id_changed")!("B");
    const second = runtime.manager.getStatus();
    if (second?.kind !== "active") throw new Error("expect B active");
    expect(second.space.id).not.toBe(first.space.id);
    const savedA = ports.snapshotWrites.find((saved) => saved.target.chatId === "story");
    expect(savedA?.target).toMatchObject({ identity: "char:3:story", avatarUrl: "alice.png" });
    expect(savedA?.file.spaceId).toBe(first.space.id);
    expect(
      savedA?.file.data.records.some((record) => record.payload[field.id] === "切换时仍需保存"),
    ).toBe(true);
    const savedB = ports.snapshotWrites.find((saved) => saved.target.chatId === "B");
    expect(savedB?.file.spaceId).toBe(second.space.id);
    expect(savedB?.file.data.records).toEqual([]);
    expect(context.chatMetadata.otherPlugin).toBe("B 独有数据");
    expect(context.chatMetadata[CHAT_METADATA_MIRROR_KEY]).toMatchObject({
      spaceId: second.space.id,
    });
  });

  it("分支文件只作为克隆来源，不覆盖原空间的本地缓存和 SQLite 数据", async () => {
    const db = createTestDatabase();
    const { context, handlers } = fakeStContext();
    const ports = createRuntimeTestPorts(() => context);
    const runtime = await startTestRuntime(() => context, {
      createDb: () => db,
      log: fakeLog(),
      ...ports,
    });
    const original = runtime.manager.getStatus();
    if (original?.kind !== "active") throw new Error("expect original active");
    const table = (await runtime.tables.list(original.space.id)).find(
      (item) => item.key === "characters",
    )!;
    const field = (await runtime.fields.list(original.space.id, table.id)).find(
      (item) => item.key === "name",
    )!;
    const record = await runtime.records.create(original.space.id, table.id, {
      payload: { [field.id]: "原空间较新内容" },
    });
    if (!record) throw new Error("expect record created");
    const currentUnit = (await runtime.backup.loadSnapshot()).spaces.find(
      (item) => item.space.id === original.space.id,
    )!;
    const branchUnit = structuredClone(currentUnit);
    Object.assign(branchUnit.records[0]!, {
      payload: { [field.id]: "分支文件旧内容" },
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    context.chatId = "branch-story";
    context.chatMetadata = {
      [CHAT_METADATA_BINDING_KEY]: structuredClone(original.binding),
      [CHAT_METADATA_MIRROR_KEY]: createChatMirrorFile(
        branchUnit,
        original.space.id,
        "2026-08-01T00:00:00.000Z",
        "test",
      ),
    };
    await handlers.get("chat_id_changed")!("branch-story");
    expect(runtime.manager.getStatus()).toMatchObject({ kind: "branch-detected" });
    expect((await db.memoryRecords.get(record.id))?.payload[field.id]).toBe("原空间较新内容");
    expect(
      (await runtime.records.find(original.space.id, table.id, record.id))?.payload[field.id],
    ).toBe("原空间较新内容");
    const cloned = await runtime.manager.resolveBranch({
      action: "clone",
      sourceSpaceId: original.space.id,
    });
    if (cloned.kind !== "active") throw new Error("expect cloned active");
    const clonedTable = (await runtime.tables.list(cloned.space.id)).find(
      (item) => item.key === "characters",
    )!;
    const clonedField = (await runtime.fields.list(cloned.space.id, clonedTable.id)).find(
      (item) => item.key === "name",
    )!;
    const records = (await runtime.records.list(cloned.space.id, clonedTable.id, {
      page: 1,
      pageSize: 100,
    }))!.records;
    expect(records).toHaveLength(1);
    expect(records[0]!.id).not.toBe(record.id);
    expect(records[0]!.payload[clonedField.id]).toBe("分支文件旧内容");
    expect((await db.memoryRecords.get(record.id))?.payload[field.id]).toBe("原空间较新内容");
    expect(
      (await runtime.records.find(original.space.id, table.id, record.id))?.payload[field.id],
    ).toBe("原空间较新内容");
    expect(context.chatMetadata[CHAT_METADATA_MIRROR_KEY]).toMatchObject({
      spaceId: cloned.space.id,
    });
  });

  it("绑定在、空间缺失、文件里有有效镜像：启动即从镜像恢复（active/restored，数据落地）", async () => {
    const db = createTestDatabase();
    const unit: MemorySpaceBackup = {
      space: {
        id: "space-ghost" as MemorySpaceId,
        name: "爱丽丝 - story",
        initializationSource: null,
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

    const runtime = await startTestRuntime(() => context, { createDb: () => db, log: fakeLog() });

    const status = runtime.manager.getStatus();
    expect(status?.kind).toBe("active");
    if (status?.kind !== "active") return;
    expect(status.restored).toBe(true);
    expect(status.space.id).toBe("space-ghost");
    // 数据真实落地（restoreSpace 写入），绑定原样保留
    const spaceRepository = new DexieMemorySpaceRepository(db);
    expect(await spaceRepository.list()).toHaveLength(1);
    // v1 绑定已迁移为 v2
    expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toEqual({
      version: 2,
      spaceId: "space-ghost",
      chatIdentity: "char:3:story",
    });
  });

  it("绑定在、空间缺失、文件里无有效镜像：保持 space-missing（等待镜像恢复/用户处理）", async () => {
    const db = createTestDatabase();
    const { context, chatMetadata } = fakeStContext();
    chatMetadata[CHAT_METADATA_BINDING_KEY] = { version: 1, spaceId: "space-ghost" };

    const runtime = await startTestRuntime(() => context, { createDb: () => db, log: fakeLog() });

    expect(runtime.manager.getStatus()?.kind).toBe("space-missing");
    const spaceRepository = new DexieMemorySpaceRepository(db);
    expect(await spaceRepository.list()).toHaveLength(0);
  });

  it("旧语义宏依赖失效后允许改名停用，表达式变化和新副本仍重新编译", async () => {
    const db = createTestDatabase();
    const { context } = fakeStContext();
    const legacy = {
      id: "legacy-broken",
      name: "旧语义",
      enabled: true,
      expression: {
        language: "sql",
        sql: "SELECT * FROM old_scores",
        sources: [
          {
            name: "old_scores",
            table: "deleted_table",
            groups: ["deleted_group"],
            query: { text: "线索" },
          },
        ],
      },
      output: { format: "json", maxChars: null },
    } satisfies MemoryMacro;
    let stored: PluginSettings = { ...structuredClone(DEFAULT_SETTINGS), macros: [legacy] };
    const runtime = await startTestRuntime(() => context, {
      createDb: () => db,
      log: fakeLog(),
      settingsStore: {
        read: () => stored,
        write: (next) => {
          stored = next;
        },
      },
    });
    const changed: MemoryMacro = {
      ...legacy,
      name: "已失效停用",
      enabled: false,
      expression: { ...legacy.expression, usesSemantic: false },
      output: { format: "markdown", maxChars: 200 },
    };
    await runtime.settingsService.setMacros([changed]);
    expect(runtime.settings.read().macros).toEqual([
      {
        ...changed,
        expression: { ...legacy.expression, usesSemantic: true },
      },
    ]);
    await expect(
      runtime.settingsService.setMacros([
        {
          ...changed,
          expression: { ...legacy.expression, sql: "SELECT record_id FROM old_scores" },
        },
      ]),
    ).rejects.toThrow("不存在");
    await expect(
      runtime.settingsService.setMacros([
        {
          ...changed,
          id: "new-copy",
        },
      ]),
    ).rejects.toThrow("不存在");
    expect(runtime.settings.read().macros[0]!.name).toBe("已失效停用");
    expect(runtime.settings.read().macros[0]!.enabled).toBe(false);
    await expect(runtime.settingsService.setChatScopeMacros([changed])).rejects.toThrow("不存在");
    const status = runtime.manager.getStatus();
    if (status?.kind !== "active") throw new Error("expect active");
    const unit = (await runtime.backup.loadSnapshot()).spaces.find(
      (unit) => unit.space.id === status.space.id,
    )!;
    await expect(
      runtime.normalizeImportedSpace({
        ...unit,
        space: { ...unit.space, macros: [changed] },
      }),
    ).rejects.toThrow("不存在");
  });

  it("无当前空间时已有SQL分类支持元数据编辑，新SQL仍须打开空间验证", async () => {
    const db = createTestDatabase();
    const { context } = fakeStContext({ chatId: undefined });
    const macro = {
      id: "known-inline",
      name: "已分类",
      enabled: true,
      expression: {
        language: "sql",
        sql: "SELECT * FROM semantic_scores('missing', '[\"missing\"]', '线索')",
        usesSemantic: true,
      },
      output: { format: "json", maxChars: null },
    } satisfies MemoryMacro;
    let stored: PluginSettings = { ...structuredClone(DEFAULT_SETTINGS), macros: [macro] };
    const runtime = await startTestRuntime(() => context, {
      createDb: () => db,
      log: fakeLog(),
      settingsStore: {
        read: () => stored,
        write: (next) => {
          stored = next;
        },
      },
    });
    const changed: MemoryMacro = {
      ...macro,
      enabled: false,
      name: "暂停",
      expression: { ...macro.expression, usesSemantic: false },
    };
    await runtime.settingsService.setMacros([changed]);
    expect(runtime.settings.read().macros[0]).toMatchObject({
      name: "暂停",
      enabled: false,
      expression: { usesSemantic: true },
    });
    await expect(
      runtime.settingsService.setMacros([{ ...changed, id: "new-inline" }]),
    ).rejects.toThrow("请先打开");
    await expect(
      runtime.settingsService.setMacros([
        { ...changed, expression: { language: "sql", sql: "SELECT 1", usesSemantic: true } },
      ]),
    ).rejects.toThrow("请先打开");
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
    const runtime = await startTestRuntime(() => context, { createDb: () => db, log: fakeLog() });
    const status = runtime.manager.getStatus();
    if (status?.kind !== "active") throw new Error("expect active");

    // 默认前缀 {{ste}} 解析为裸标识符注册；ticket 17 追加 tablesDigest /
    // systemDefaultPrompt（Agent 预设宏）；内置/视图/对话宏全部走 {{前缀::名字}} 分发
    const registeredKeys = [...registered.keys()].sort();
    expect(registeredKeys).toEqual(["ste", "systemDefaultPrompt", "tablesDigest"]);
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
    expect(registered.get("ste")!({})).toBe("");
    await runtime.macro.prepare("测试");
    const snapshot = registered.get("ste")!({});
    expect(snapshot).toContain("【人物】");
    expect(snapshot).toContain("张三");
    expect(runtime.macro.getSnapshot()).toBe(snapshot);

    // {{前缀::full}} / {{前缀::表Key}} 分发：完整 Markdown 含人物表与新记录
    const full = registered.get("ste")!({ unnamedArgs: ["full"] });
    expect(full).toContain("## 人物");
    expect(full).toContain("张三");
    const tableMacro = registered.get("ste")!({ unnamedArgs: ["characters"] });
    expect(tableMacro).toContain("## 人物");
    expect(tableMacro).not.toContain("角色");

    // 设置服务负责保存和联动；调用方不再安排宏刷新。
    await runtime.settingsService.setMacroName("{{myMemory}}");
    expect([...registered.keys()].sort()).toEqual(
      ["myMemory", "tablesDigest", "systemDefaultPrompt"].sort(),
    );

    // 插件总开关关闭：注销（无注入）
    await runtime.settingsService.setPluginEnabled(false);
    expect([...registered.keys()]).toEqual([]);
    expect(registered.has("memoryRecall")).toBe(false);
    expect(runtime.mirror.getStatus().kind).toBe("disabled");

    await runtime.settingsService.setPluginEnabled(true);
    expect([...registered.keys()].sort()).toEqual(
      ["myMemory", "tablesDigest", "systemDefaultPrompt"].sort(),
    );
  });

  it("宏预览数据源（issue 01 UI 改版）：macroOverview 聚合记忆宏与 Agent 预设宏快照（每行预览的读口）", async () => {
    const db = createTestDatabase();
    const { context } = fakeStContext({
      extensionSettings: {},
      macros: {
        register: () => {},
        registry: { unregisterMacro: () => false },
      },
    });
    const runtime = await startTestRuntime(() => context, { createDb: () => db, log: fakeLog() });
    const status = runtime.manager.getStatus();
    if (status?.kind !== "active") throw new Error("expect active");

    // 默认前缀 {{ste}} → 行名花括号形态；记忆宏家族 + Agent 预设宏两行
    expect(runtime.macro.getRecentResults()).toEqual([]);
    await runtime.macro.prepare("测试");
    const overview = runtime.macroOverview();
    const names = overview.map((row) => row.name);
    expect(names[0]).toBe("{{ste}}");
    expect(names).toContain("{{tablesDigest}}");
    expect(names).toContain("{{systemDefaultPrompt}}");
    // 展开文本 = 快照实际值（与宏 handler / agentMacro 快照同源）
    const digestRow = overview.find((row) => row.name === "{{tablesDigest}}")!;
    expect(digestRow.text).toBe(runtime.agentMacro.getSnapshot().digestText);
    expect(digestRow.text).toContain("【characters｜人物】");
    expect(overview.find((row) => row.name === "{{ste}}")!.text).toBe(runtime.macro.getSnapshot());

    // 内置宏行：full + 每启用表 Key（快照只读口与分发同源）
    const fullRow = overview.find((row) => row.name === "{{ste::full}}")!;
    expect(fullRow.text).toBe(runtime.macro.getBuiltinSnapshot("full"));
    expect(fullRow.text).toContain("## 人物");

    // 编辑记忆视图后 kick：一览读取即最新（快照随设置变化重建）
    const view = {
      name: "人物速览",
      tableKey: "characters",
      condition: null,
      limit: 50,
      projection: [] as readonly string[],
    };
    await runtime.settingsService.setMacros([migrateMemoryView(view, "global-preview")]);
    const refreshed = runtime.macroOverview();
    expect(refreshed.some((row) => row.name === "{{ste::人物速览}}")).toBe(true);
  });

  it("预设预览端口（issue 01）：ST 上下文快照 / 活动空间 / digest 即时构建；旧版 ST 世界书扫描 = failed", async () => {
    const db = createTestDatabase();
    const { context } = fakeStContext();
    const runtime = await startTestRuntime(() => context, { createDb: () => db, log: fakeLog() });
    const status = runtime.manager.getStatus();
    if (status?.kind !== "active") throw new Error("expect active");

    // ST 上下文快照：对话双方名字 / 角色卡（与任务提交同源同构）；msgText 由调用方填
    const snapshot = runtime.presetPreview.getPromptSnapshot();
    expect(snapshot.names).toEqual({ user: "", char: "爱丽丝" });
    expect(runtime.presetPreview.readSpaceId()).toBe(status.space.id);

    // digest 即时构建：含启用表摘要
    const digest = await runtime.presetPreview.readDigest(status.space.id);
    expect(digest.tables.some((t) => t.key === "characters")).toBe(true);

    // 旧版 ST（无 getWorldInfoPrompt）：扫描 = failed + 空文本（展开空串语义）
    const scan = await runtime.presetPreview.scanWorldbook("测试文本");
    expect(scan).toEqual({ text: "", status: "failed" });
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
      kind: "floor",
      initText: null,
      chatId: null,
      status: "running",
      errorMessage: null,
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    });

    const runtime = await startTestRuntime(() => context, { createDb: () => db, log: fakeLog() });

    // 启动即中断：不自动重放、不占用活动名额
    const leftover = await tasks.find("run-leftover");
    expect(leftover).toMatchObject({ status: "interrupted", errorMessage: null });
    expect(runtime.tasks).toBeDefined();
    expect(await runtime.tasks.activeTask("space-leftover" as MemorySpaceId)).toBeUndefined();
    // 任务服务从 ST 上下文读消息数（触发 UI 的数据源接线）
    expect(runtime.adapter.chatMessageCount()).toBe(1);
  });
});

describe("startSteMemory → Agent 连接分流（ADR 0010）", () => {
  const connectionA = {
    id: "cA",
    name: "连接A",
    baseUrl: "https://a.example.com/v1",
    apiKey: "sk-a",
    model: "model-a",
  };
  const connectionB = {
    id: "cB",
    name: "连接B",
    baseUrl: "https://b.example.com/v1/chat/completions/",
    apiKey: "",
    model: "model-b",
  };

  async function startRuntime(settings: PluginSettings) {
    const db = createTestDatabase();
    const { context } = fakeStContext({
      chatCompletionSettings: {
        chat_completion_source: "openai",
        temp_openai: 0.6,
        openai_max_tokens: 1500,
        openai_max_context: 16_384,
      },
      getChatCompletionModel: () => "st-model",
    });
    const settingsStore: SettingsStore = { read: () => settings, write: () => undefined };
    return startTestRuntime(() => context, { createDb: () => db, log: fakeLog(), settingsStore });
  }

  it("缺省（未选择连接）：填表与问答都跟随 ST 当前连接（旧行为零变化）", async () => {
    const runtime = await startRuntime({ ...DEFAULT_SETTINGS, agentConnections: [connectionA] });
    expect(runtime.createLlm().model.id).toBe("st-model");
    expect(runtime.createQueryChatLlm().model.id).toBe("st-model");
  });

  it("填表选择连接：createLlm 用连接模型；问答仍跟随 ST", async () => {
    const runtime = await startRuntime({
      ...DEFAULT_SETTINGS,
      agentConnections: [connectionA],
      fillTaskConnectionId: "cA",
    });
    const port = runtime.createLlm();
    expect(port.model.id).toBe("model-a");
    expect((port.model as StBackendsModel).customUrl).toBe("https://a.example.com/v1");
    expect(runtime.createQueryChatLlm().model.id).toBe("st-model");
  });

  it("问答选择连接：createQueryChatLlm 用连接；填表仍跟随 ST", async () => {
    const runtime = await startRuntime({
      ...DEFAULT_SETTINGS,
      agentConnections: [connectionA],
      queryChatConnectionId: "cA",
    });
    expect(runtime.createLlm().model.id).toBe("st-model");
    const port = runtime.createQueryChatLlm();
    expect(port.model.id).toBe("model-a");
    expect((port.model as StBackendsModel).customIncludeHeaders).toBe(
      JSON.stringify({ Authorization: "Bearer sk-a" }),
    );
  });

  it("两个 Agent 各选不同连接：各自生效（URL 规范化在工厂完成）", async () => {
    const runtime = await startRuntime({
      ...DEFAULT_SETTINGS,
      agentConnections: [connectionA, connectionB],
      fillTaskConnectionId: "cA",
      queryChatConnectionId: "cB",
    });
    expect(runtime.createLlm().model.id).toBe("model-a");
    const queryPort = runtime.createQueryChatLlm();
    expect(queryPort.model.id).toBe("model-b");
    expect((queryPort.model as StBackendsModel).customUrl).toBe("https://b.example.com/v1");
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
    const runtime = await startTestRuntime(() => context, { createDb: () => db, log: fakeLog() });
    const port = runtime.createLlm();
    expect(port.model.id).toBe("my-model");
    expect(port.model.contextWindow).toBe(16_384);
    expect(port.model.maxTokens).toBe(1500);
    // ST 配置缺失（非 ST 环境）→ 端口构造抛中文错误而非静默
    const bare = fakeStContext({ chatCompletionSettings: undefined });
    const runtimeBare = await startTestRuntime(() => bare.context, {
      createDb: () => db,
      log: fakeLog(),
    });
    expect(() => runtimeBare.createLlm()).toThrow(/Chat Completion 源未知/);
  });
});
