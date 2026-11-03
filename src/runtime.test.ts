import { presetUpdateChanges } from "./features/table-presets/preset-space-update.ts";
import { migrateMemoryView } from "./features/macros/macro-expression.ts";
import { SYSTEM_TABLE_TEMPLATES } from "./features/memory/index.ts";
import { describe, expect, it, vi } from "vitest";
// fake-indexeddb 必须先于 dexie 模块求值（test-support 第一行 import "fake-indexeddb/auto"），
// 因此 test-support 必须排在任何导入 dexie 的模块之前
import {
  createTestDatabase,
  createTestLogDatabase,
} from "./infrastructure/indexeddb/test-support.ts";
import { DexieFillTaskRepository } from "./infrastructure/indexeddb/index.ts";
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
    expect(context.chatMetadata![CHAT_METADATA_CLEANING_RULE_KEY]).toBeUndefined();
    context.chatMetadata![CHAT_METADATA_CLEANING_RULE_KEY] = { version: 3, ruleId: "new" };
    await handlers.get("chat_id_changed")?.();
    expect(context.chatMetadata![CHAT_METADATA_CLEANING_RULE_KEY]).toEqual({
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
    expect(context.chatMetadata![CHAT_METADATA_AGENT_PRESET_KEY]).toBeUndefined();
  });

  it("首次打开对话：建空间 + 写绑定 + 系统表就位；再次打开不重复建", async () => {
    const db = createTestDatabase();
    const { context, chatMetadata } = fakeStContext();

    const runtime = await startTestRuntime(() => context, { createDb: () => db, log: fakeLog() });

    const status = runtime.manager.getStatus();
    expect(status?.kind).toBe("active");
    if (status?.kind !== "active") {
      return;
    }
    expect(status.created).toBe(true);
    expect(status.space.name).toBe("爱丽丝 - story");
    expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toEqual({
      version: 2,
      spaceId: status.space.id,
      chatIdentity: "char:3:story",
    });

    expect(await runtime.tables.list(status.space.id)).toHaveLength(SYSTEM_TABLE_TEMPLATES.length);
    expect(await runtime.spaces.find(status.space.id)).toMatchObject({ id: status.space.id });

    // 独立 SQLite 实例从同一聊天文件重新加载，不创建第二份空间。
    const reopened = await startTestRuntime(() => context, { createDb: () => db, log: fakeLog() });
    const reopenedStatus = reopened.manager.getStatus();
    expect(reopenedStatus?.kind).toBe("active");
    if (reopenedStatus?.kind !== "active") {
      return;
    }
    expect(reopenedStatus.created).toBe(false);
    expect(reopenedStatus.space.id).toBe(status.space.id);
    expect(await reopened.tables.list(status.space.id)).toHaveLength(SYSTEM_TABLE_TEMPLATES.length);
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
    if (status?.kind !== "active") {
      throw new Error("expect active");
    }
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
    await handlers.get("chat_id_changed")!("other");

    const status = runtime.manager.getStatus();
    expect(status?.kind).toBe("active");
    if (status?.kind !== "active") {
      return;
    }
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
    if (status?.kind !== "active") {
      throw new Error("expect active");
    }
    const firstSpaceId = status.space.id;

    // 给空间一加一条记录（人物表），快照重建
    const characters = (await runtime.tables.list(firstSpaceId)).find(
      (t) => t.key === "characters",
    );
    if (!characters) {
      throw new Error("expect characters table");
    }
    const nameField = (await runtime.fields.list(firstSpaceId, characters.id)).find(
      (f) => f.key === "name",
    );
    if (!nameField) {
      throw new Error("expect name field");
    }
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
    await handlers.get("chat_id_changed")!("other");
    // 状态订阅触发 macro.kick，切换完成后立即撤下上一聊天的注入文本。
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
    expect(context.chatMetadata![CHAT_METADATA_MIRROR_KEY]).toBeUndefined();
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
    if (status?.kind !== "active") {
      throw new Error("expect active");
    }
    // 服务可列出系统表与字段（面板表格列表的数据来源）；系统表均带预置字段
    const tables = await runtime.tables.list(status.space.id);
    expect(tables.length).toBeGreaterThan(0);
    const firstTable = tables[0]!;
    expect((await runtime.fields.list(status.space.id, firstTable.id)).length).toBeGreaterThan(0);
  });

  it("插件总开关停用：启动不建空间、CHAT_CHANGED 不响应；重新启用后恢复同步", async () => {
    const db = createTestDatabase();
    const { context, handlers, chatMetadata } = fakeStContext();
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
    expect(context.chatMetadata![CHAT_METADATA_MIRROR_KEY]).toBeUndefined();
    expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toBeUndefined();

    // 停用期间 CHAT_CHANGED 被门控跳过（事件桥不排队同步，状态不发布）
    await handlers.get("chat_id_changed")!("other");
    expect(runtime.manager.getStatus()).toBeUndefined();
    expect(context.chatMetadata![CHAT_METADATA_MIRROR_KEY]).toBeUndefined();

    // 设置面板重新启用（写存储后触发同步，等价宿主行为）
    await runtime.settingsService.setPluginEnabled(true);
    const status = runtime.manager.getStatus();
    expect(status?.kind).toBe("active");
    expect(context.chatMetadata![CHAT_METADATA_MIRROR_KEY]).toBeDefined();

    // 启用后 CHAT_CHANGED 恢复响应
    context.chatId = "other";
    context.chatMetadata = {};
    await handlers.get("chat_id_changed")!("other");
    expect(runtime.manager.getStatus()?.kind).toBe("active");
    expect((await runtime.backup.exportCurrentSpace()).space.name).toBe("爱丽丝 - other");
  });

  it("初始化保存完整快照，插件停用仍可保存已提交内容", async () => {
    const db = createTestDatabase();
    const { context } = fakeStContext();
    let settings = { ...DEFAULT_SETTINGS };
    const settingsStore: SettingsStore = {
      read: () => settings,
      write: (next) => {
        settings = next;
      },
    };
    const ports = createRuntimeTestPorts(() => context);
    const runtime = await startTestRuntime(() => context, {
      createDb: () => db,
      log: fakeLog(),
      settingsStore,
      ...ports,
    });
    expect(runtime.persistence.getStatus("char:3:story")).toMatchObject({
      kind: "verified",
      identity: "char:3:story",
    });
    const spaceId = (await runtime.backup.exportCurrentSpace()).space.id;
    vi.spyOn(ports.snapshotFiles, "submit").mockRejectedValueOnce(new Error("file offline"));
    await expect(
      runtime.tables.create(spaceId, {
        key: "pending_table",
        name: "待保存表格",
        description: "",
        prompt: "",
        position: 100,
      }),
    ).rejects.toThrow("file offline");
    expect(runtime.persistence.hasPendingWrites()).toBe(true);
    await runtime.settingsService.setPluginEnabled(false);
    expect(runtime.persistence.getStatus("char:3:story")).toMatchObject({
      kind: "failed",
      operation: "update",
    });
    await runtime.retryMemorySave();
    expect(runtime.settings.read().enabled).toBe(false);
    expect(runtime.persistence.getStatus("char:3:story").kind).toBe("verified");
    expect(runtime.persistence.hasPendingWrites()).toBe(false);
    expect(
      ports.snapshotWrites
        .at(-1)!
        .file.data.tables.filter((table) => table.key === "pending_table"),
    ).toHaveLength(1);
  });

  it("预设比较读取期间切到同 ID 的另一聊天，不取消新聊天任务", async () => {
    const db = createTestDatabase();
    const { context, handlers } = fakeStContext();
    const ports = createRuntimeTestPorts(() => context);
    const createSqlite = vi.fn(ports.createSqlite);
    const runtime = await startTestRuntime(() => context, {
      createDb: () => db,
      log: fakeLog(),
      ...ports,
      createSqlite,
    });
    const original = await runtime.backup.exportCurrentSpace();
    const metadata = structuredClone(context.chatMetadata);
    const preset = { ...SYSTEM_TABLE_PRESET, prompt: "过期更新" };
    const plan = await runtime.presetUpdate.preview(original.space.id, preset, "char:3:story");
    const selected = presetUpdateChanges(plan.nodes).map((change) => change.id);
    const sqlite = await createSqlite.mock.results[0]!.value;
    const exportSpace = sqlite.exportSpace.bind(sqlite);
    let markStarted!: () => void;
    let releaseRead!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    vi.spyOn(sqlite, "exportSpace").mockImplementationOnce(async (...args) => {
      markStarted();
      await released;
      return exportSpace(...args);
    });
    const cancelTasks = vi.spyOn(runtime.tasks, "cancelAll");
    const updating = runtime.presetUpdate.apply(plan, selected, "char:3:story");
    // 先注册拒绝断言，迟到读取失败也不会成为未观察的 Promise 拒绝。
    const rejected = expect(updating).rejects.toThrow("对话已切换");
    await started;
    context.characterId = 0;
    context.chatMetadata = metadata;
    try {
      await handlers.get("chat_id_changed")!();
      expect(runtime.manager.getStatus()).toMatchObject({
        kind: "active",
        space: { id: original.space.id },
      });
    } finally {
      releaseRead();
    }
    await rejected;
    expect(cancelTasks).not.toHaveBeenCalled();
    expect((await runtime.backup.exportCurrentSpace()).space.prompt).toBe(original.space.prompt);
  });

  it.each(["apply", "retry"] as const)(
    "预设 %s 的文件保存等待期间允许切换聊天，迟到结果保留原归属",
    async (operation) => {
      const db = createTestDatabase();
      const { context, handlers } = fakeStContext();
      const ports = createRuntimeTestPorts(() => context);
      const runtime = await startTestRuntime(() => context, {
        createDb: () => db,
        log: fakeLog(),
        ...ports,
      });
      const original = await runtime.backup.exportCurrentSpace();
      const identity = "char:3:story";
      const preset = { ...SYSTEM_TABLE_PRESET, prompt: `gated-${operation}` };
      const plan = await runtime.presetUpdate.preview(original.space.id, preset, identity);
      const selected = presetUpdateChanges(plan.nodes).map((change) => change.id);
      if (operation === "retry") {
        vi.spyOn(ports.snapshotFiles, "submit").mockRejectedValueOnce(new Error("file offline"));
        const outcome = await runtime.presetUpdate.apply(plan, selected, identity);
        expect(outcome.issues).toContain("宿主提交或核验失败：file offline");
      }

      let markStarted!: () => void;
      let releaseWrite!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      const write = ports.snapshotFiles.submit;
      vi.spyOn(ports.snapshotFiles, "submit").mockImplementationOnce(async (...args) => {
        await write(...args);
        markStarted();
        await released;
      });
      const saving =
        operation === "apply"
          ? runtime.presetUpdate.apply(plan, selected, identity)
          : runtime.presetUpdate.retrySave(original.space.id, identity);
      await started;
      expect(runtime.persistence.getStatus(identity).kind).toBe("saving");

      context.chatId = `preset-${operation}-B`;
      context.chatMetadata = { otherPlugin: "B 独有数据" };
      // 真实切聊会等待原空间 whenIdle；文件 gate 未释放时必须完成卸载和 B 的初始化。
      // 有限竞速只用于失败断言，finally 仍释放网络，避免留下挂起任务影响后续用例。
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          handlers.get("chat_id_changed")!(),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("切聊被文件网络阻塞")), 2000);
          }),
        ]);
        const current = await runtime.publicRead.read();
        expect(current.context.chatIdentity).toBe(`char:3:preset-${operation}-B`);
        expect(current.snapshot.space.id).not.toBe(original.space.id);
        expect(await runtime.spaces.find(original.space.id)).toBeUndefined();
        expect(runtime.persistence.getStatus(identity).kind).toBe("saving");
      } finally {
        clearTimeout(timeout);
        releaseWrite();
      }
      await saving;
      const saved = ports.snapshotWrites
        .filter((entry) => entry.target.identity === identity)
        .at(-1)!;
      expect(saved.file.data.space.prompt).toBe(`gated-${operation}`);
      expect(context.chatMetadata.otherPlugin).toBe("B 独有数据");
      expect(runtime.publicRead.getContext().chatIdentity).toBe(`char:3:preset-${operation}-B`);
    },
  );

  it("绑定已存在时只从聊天文件加载空间到 SQLite", async () => {
    const db = createTestDatabase();
    const fileUnit: MemorySpaceBackup = {
      schemaVersion: 3 as const,
      floorLedger: [],
      space: {
        macros: [],
        id: "file-first" as MemorySpaceId,
        stableId: "file-first" as MemorySpaceId,
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
    expect(await runtime.spaces.find(fileUnit.space.id)).toEqual({
      ...fileUnit.space,
      macros: [],
    });
  });

  it("普通保存失败切聊后不后台补写，返回按宿主文件加载并可强制同步", async () => {
    const db = createTestDatabase();
    const { context, handlers } = fakeStContext();
    const ports = createRuntimeTestPorts(() => context);
    const runtime = await startTestRuntime(() => context, {
      createDb: () => db,
      log: fakeLog(),
      ...ports,
    });
    const original = await runtime.backup.exportCurrentSpace();
    const persistedMetadata = structuredClone(context.chatMetadata);
    const table = original.tables.find((item) => item.key === "characters")!;
    const name = original.fields.find((item) => item.tableId === table.id && item.key === "name")!;
    vi.spyOn(ports.snapshotFiles, "submit").mockRejectedValueOnce(new Error("file offline"));
    await expect(
      runtime.records.create(original.space.id, table.id, {
        payload: { [name.id]: "仅本次内存提交" },
      }),
    ).rejects.toThrow("file offline");
    expect((await runtime.backup.exportCurrentSpace()).records).toHaveLength(1);
    ports.snapshotWrites.length = 0;
    context.chatId = "B";
    context.chatMetadata = { otherPlugin: "B 独有数据" };
    await handlers.get("chat_id_changed")!();
    expect(ports.snapshotWrites.some((entry) => entry.target.chatId === "story")).toBe(false);
    expect(context.chatMetadata.otherPlugin).toBe("B 独有数据");

    // 模拟宿主重新载入原文件，普通失败输入不会被插件当作跨聊天缓存恢复。
    context.chatId = "story";
    context.chatMetadata = persistedMetadata;
    await handlers.get("chat_id_changed")!();
    expect((await runtime.backup.exportCurrentSpace()).records).toEqual([]);
    await runtime.forceSyncMemory();
    expect(runtime.persistence.getStatus("char:3:story").kind).toBe("verified");
    expect(ports.snapshotWrites.at(-1)!.target.identity).toBe("char:3:story");
  });

  it("候选核验失败保留新空间和旧辅助，切聊返回继续同一候选", async () => {
    const db = createTestDatabase();
    const { context, handlers } = fakeStContext();
    const ports = createRuntimeTestPorts(() => context);
    const runtime = await startTestRuntime(() => context, {
      createDb: () => db,
      log: fakeLog(),
      ...ports,
    });
    const original = await runtime.backup.exportCurrentSpace();
    const metadataBeforeImport = structuredClone(context.chatMetadata);
    const tasks = new DexieFillTaskRepository(db);
    await tasks.create({
      runId: "retained-task",
      memorySpaceId: original.space.id,
      from: 0,
      to: 0,
      blockSize: 1,
      kind: "floor",
      initText: null,
      chatId: "story",
      status: "succeeded",
      errorMessage: null,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    vi.spyOn(ports.snapshotFiles, "verify").mockRejectedValueOnce(new Error("readback offline"));
    await expect(runtime.manager.importSpace(original)).rejects.toThrow("readback offline");
    const candidate = await runtime.backup.exportCurrentSpace();
    expect(candidate.space.id).not.toBe(original.space.id);
    expect(await tasks.find("retained-task")).toBeDefined();
    await expect(
      runtime.tasks.markFloorStatuses(candidate.space.id, 0, 0, "processed"),
    ).rejects.toThrow("候选空间");

    context.chatId = "B";
    context.chatMetadata = {};
    await handlers.get("chat_id_changed")!();
    context.chatId = "story";
    context.chatMetadata = metadataBeforeImport;
    await handlers.get("chat_id_changed")!();
    expect((await runtime.backup.exportCurrentSpace()).space.id).toBe(candidate.space.id);
    await expect(
      runtime.tasks.markFloorStatuses(candidate.space.id, 0, 0, "processed"),
    ).rejects.toThrow("候选空间");
    await runtime.forceSyncMemory();
    expect(await tasks.find("retained-task")).toBeUndefined();
    expect((await runtime.backup.exportCurrentSpace()).space.id).toBe(candidate.space.id);
    await runtime.tasks.markFloorStatuses(candidate.space.id, 0, 0, "processed");
  });

  it.each([false, true])(
    "全量预设保存迟到时保留同 ID 新聊天的辅助数据（新聊天已卸载：%s）",
    async (unloadNewChat) => {
      const db = createTestDatabase();
      const { context, handlers } = fakeStContext();
      const ports = createRuntimeTestPorts(() => context);
      const runtime = await startTestRuntime(() => context, {
        createDb: () => db,
        log: fakeLog(),
        ...ports,
      });
      const original = await runtime.backup.exportCurrentSpace();
      const metadataA = structuredClone(context.chatMetadata);
      let markStarted!: () => void;
      let releaseWrite!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      const write = ports.snapshotFiles.submit;
      vi.spyOn(ports.snapshotFiles, "submit").mockImplementationOnce(async (...args) => {
        await write(...args);
        markStarted();
        await released;
      });
      const applying = runtime.presetApply.applyPreset(original.space.id, SYSTEM_TABLE_PRESET, {
        chatIdentity: "char:3:story",
        refreshMacros: async () => {},
      });
      await started;
      context.characterId = 0;
      context.chatMetadata = metadataA;
      let recordId: string;
      try {
        await handlers.get("chat_id_changed")!();
        const current = await runtime.backup.exportCurrentSpace();
        expect(current.space.id).toBe(original.space.id);
        const table = current.tables.find((table) => table.key === "characters")!;
        const field = current.fields.find(
          (field) => field.tableId === table.id && field.key === "name",
        )!;
        const record = await runtime.records.create(current.space.id, table.id, {
          payload: { [field.id]: "B 的记录" },
        });
        recordId = record!.id;
        await runtime.tasks.markFloorStatuses(current.space.id, 0, 0, "processed");
        await db.memoryFillTasks.put({
          runId: "B-full-rebuild-task",
          memorySpaceId: current.space.id,
          from: 0,
          to: 0,
          blockSize: 1,
          kind: "floor",
          initText: null,
          chatId: "story",
          status: "succeeded",
          errorMessage: null,
          createdAt: "2026-11-01T00:00:00Z",
          updatedAt: "2026-11-01T00:00:00Z",
        });
        await db.recordVectors.put({
          id: "B-full-rebuild-vector",
          memorySpaceId: current.space.id,
          tableId: table.id,
          recordId: record!.id,
          groupId: "B-group",
          fingerprint: "B-fingerprint",
          values: [1, 0],
          model: "test",
          version: "v1",
          updatedAt: "2026-11-01T00:00:00Z",
        });
        if (unloadNewChat) {
          context.chatId = "C";
          context.chatMetadata = {};
          await handlers.get("chat_id_changed")!();
        }
      } finally {
        releaseWrite();
      }
      await applying;
      expect(await db.memoryFillTasks.get("B-full-rebuild-task")).toBeDefined();
      if (!unloadNewChat) {
        expect(await runtime.tasks.ledgerStatuses(original.space.id, 0, 0)).toEqual([
          { floor: 0, status: "processed" },
        ]);
      }
      expect(await db.recordVectors.get("B-full-rebuild-vector")).toMatchObject({
        recordId: recordId!,
      });
      const savedB = ports.snapshotWrites
        .filter((entry) => entry.target.identity === "char:0:story")
        .at(-1)!;
      expect(savedB.file.data.records.some((record) => record.id === recordId!)).toBe(true);
      // 跳过失去归属的清理也必须结束原请求，返回 A 后可继续编辑。
      const savedA = ports.snapshotWrites
        .filter((entry) => entry.target.identity === "char:3:story")
        .at(-1)!;
      context.characterId = 3;
      context.chatId = "story";
      context.chatMetadata = { ...metadataA, [CHAT_METADATA_MIRROR_KEY]: savedA.file };
      await handlers.get("chat_id_changed")!();
      const restored = await runtime.backup.exportCurrentSpace();
      const table = restored.tables.find((table) => table.key === "characters")!;
      const name = restored.fields.find(
        (field) => field.tableId === table.id && field.key === "name",
      )!;
      expect(
        await runtime.records.create(restored.space.id, table.id, {
          payload: { [name.id]: "A 继续编辑" },
        }),
      ).toBeDefined();
    },
  );

  it("重复旧重建确认不会清理同 owner 的新重建请求或解除其门控", async () => {
    const db = createTestDatabase();
    const { context } = fakeStContext();
    const ports = createRuntimeTestPorts(() => context);
    const runtime = await startTestRuntime(() => context, {
      createDb: () => db,
      log: fakeLog(),
      ...ports,
    });
    const original = await runtime.backup.exportCurrentSpace();
    const saves = vi.spyOn(runtime.persistence, "replace");
    const sync = {
      chatIdentity: "char:3:story",
      refreshMacros: async () => {},
    };
    await runtime.presetApply.applyPreset(original.space.id, SYSTEM_TABLE_PRESET, sync);
    const oldConfirmation = saves.mock.calls.at(-1)![3]!;
    await db.memoryFillTasks.put({
      runId: "second-rebuild-old-task",
      memorySpaceId: original.space.id,
      from: 0,
      to: 0,
      blockSize: 1,
      kind: "floor",
      initText: null,
      chatId: "story",
      status: "succeeded",
      errorMessage: null,
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-01T00:00:00Z",
    });
    let markStarted!: () => void;
    let releaseWrite!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const write = ports.snapshotFiles.submit;
    vi.spyOn(ports.snapshotFiles, "submit").mockImplementationOnce(async (...args) => {
      await write(...args);
      markStarted();
      await released;
    });
    const applying = runtime.presetApply.applyPreset(original.space.id, SYSTEM_TABLE_PRESET, sync);
    await started;
    try {
      await oldConfirmation();
      expect(await db.memoryFillTasks.get("second-rebuild-old-task")).toBeDefined();
      await expect(
        runtime.tasks.markFloorStatuses(original.space.id, 0, 0, "processed"),
      ).rejects.toThrow("空间替换尚待核验");
    } finally {
      releaseWrite();
    }
    await applying;
    expect(await db.memoryFillTasks.get("second-rebuild-old-task")).toBeUndefined();
    await runtime.tasks.markFloorStatuses(original.space.id, 0, 0, "processed");
    expect(await runtime.tasks.ledgerStatuses(original.space.id, 0, 0)).toEqual([
      { floor: 0, status: "processed" },
    ]);
  });

  it("全量预设 SQL 替换失败保留旧内容并解除编辑门控", async () => {
    const db = createTestDatabase();
    const { context } = fakeStContext();
    const ports = createRuntimeTestPorts(() => context);
    const createSqlite = vi.fn(ports.createSqlite);
    const runtime = await startTestRuntime(() => context, {
      createDb: () => db,
      log: fakeLog(),
      ...ports,
      createSqlite,
    });
    const original = await runtime.backup.exportCurrentSpace();
    const sqlite = await createSqlite.mock.results[0]!.value;
    vi.spyOn(sqlite, "importSpace").mockRejectedValueOnce(new Error("invalid rebuild"));
    await expect(
      runtime.presetApply.applyPreset(original.space.id, SYSTEM_TABLE_PRESET, {
        chatIdentity: "char:3:story",
        refreshMacros: async () => {},
      }),
    ).rejects.toThrow("invalid rebuild");
    expect(await runtime.backup.exportCurrentSpace()).toEqual(original);
    const table = original.tables.find((table) => table.key === "characters")!;
    const name = original.fields.find(
      (field) => field.tableId === table.id && field.key === "name",
    )!;
    expect(
      await runtime.records.create(original.space.id, table.id, {
        payload: { [name.id]: "失败后可写" },
      }),
    ).toBeDefined();
  });

  it("全量预设未保存时拒绝新编辑、填表和楼层修改，重试确认后解除门控", async () => {
    const db = createTestDatabase();
    const { context } = fakeStContext();
    const ports = createRuntimeTestPorts(() => context);
    const runtime = await startTestRuntime(() => context, {
      createDb: () => db,
      log: fakeLog(),
      ...ports,
    });
    const original = await runtime.backup.exportCurrentSpace();
    await runtime.tasks.markFloorStatuses(original.space.id, 0, 0, "processed");
    await db.memoryFillTasks.put({
      runId: "old-rebuild-task",
      memorySpaceId: original.space.id,
      from: 0,
      to: 0,
      blockSize: 1,
      kind: "floor",
      initText: null,
      chatId: "story",
      status: "failed",
      nextFrom: 0,
      errorMessage: "old failure",
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-01T00:00:00Z",
    });
    vi.spyOn(ports.snapshotFiles, "submit").mockRejectedValueOnce(new Error("file offline"));
    const outcome = await runtime.presetApply.applyPreset(original.space.id, SYSTEM_TABLE_PRESET, {
      chatIdentity: "char:3:story",
      refreshMacros: async () => {},
    });
    expect(outcome.kind).toBe("applied-with-sync-issue");
    const rebuilt = await runtime.backup.exportCurrentSpace();
    const table = rebuilt.tables.find((table) => table.key === "characters")!;
    const name = rebuilt.fields.find(
      (field) => field.tableId === table.id && field.key === "name",
    )!;
    await expect(
      runtime.records.create(rebuilt.space.id, table.id, { payload: { [name.id]: "尚不可写" } }),
    ).rejects.toThrow("空间替换尚待核验");
    await expect(
      runtime.tasks.submit({ memorySpaceId: rebuilt.space.id, from: 0, to: 0 }),
    ).rejects.toThrow("空间替换尚待核验");
    await expect(
      runtime.tasks.submitInit({ memorySpaceId: rebuilt.space.id, text: "尚不可填" }),
    ).rejects.toThrow("空间替换尚待核验");
    await expect(runtime.tasks.retry(rebuilt.space.id, "old-rebuild-task")).rejects.toThrow(
      "空间替换尚待核验",
    );
    await expect(
      runtime.tasks.markFloorStatuses(rebuilt.space.id, 1, 1, "processed"),
    ).rejects.toThrow("空间替换尚待核验");
    expect(await db.memoryFillTasks.count()).toBe(1);
    expect(await runtime.tasks.ledgerStatuses(rebuilt.space.id, 0, 1)).toEqual([
      { floor: 0, status: "untracked" },
      { floor: 1, status: "untracked" },
    ]);
    await runtime.retryMemorySave();
    expect(await db.memoryFillTasks.count()).toBe(0);
    expect(await runtime.tasks.ledgerStatuses(rebuilt.space.id, 0, 1)).toEqual([
      { floor: 0, status: "untracked" },
      { floor: 1, status: "untracked" },
    ]);
    expect(
      await runtime.records.create(rebuilt.space.id, table.id, {
        payload: { [name.id]: "确认后可写" },
      }),
    ).toBeDefined();
    await runtime.tasks.markFloorStatuses(rebuilt.space.id, 1, 1, "processed");
    expect(await runtime.tasks.ledgerStatuses(rebuilt.space.id, 1, 1)).toEqual([
      { floor: 1, status: "processed" },
    ]);
  });

  it("同空间ID由另一聊天接管后，迟到的候选保存不得卸载当前空间或清理辅助数据", async () => {
    const db = createTestDatabase();
    const { context, handlers } = fakeStContext();
    const ports = createRuntimeTestPorts(() => context);
    const runtime = await startTestRuntime(() => context, {
      createDb: () => db,
      log: fakeLog(),
      ...ports,
    });
    const original = runtime.manager.getStatus();
    if (original?.kind !== "active") {
      throw new Error("expect original active");
    }
    const unit = await runtime.backup.exportCurrentSpace();
    const metadata = structuredClone(context.chatMetadata);
    let markWriteStarted!: () => void;
    let releaseWrite!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const write = ports.snapshotFiles.submit;
    vi.spyOn(ports.snapshotFiles, "submit").mockImplementationOnce(async (...args) => {
      await write(...args);
      markWriteStarted();
      await writeReleased;
    });
    const lateCandidate = runtime.manager.importSpace(unit);
    await writeStarted;

    // 同名文件导入到另一角色时沿用空间ID；文件身份已经变更。
    context.characterId = 0;
    context.name2 = "另一角色";
    context.chatMetadata = { ...metadata, otherPlugin: "B 独有数据" };
    await handlers.get("chat_id_changed")!("story");
    expect(runtime.manager.getStatus()).toMatchObject({
      kind: "active",
      binding: { spaceId: original.space.id, chatIdentity: "char:0:story" },
    });
    const table = unit.tables.find((table) => table.key === "characters")!;
    const name = unit.fields.find((field) => field.tableId === table.id && field.key === "name")!;
    const record = await runtime.records.create(original.space.id, table.id, {
      payload: { [name.id]: "B 的新记录" },
    });
    if (!record) {
      throw new Error("expect B record created");
    }
    const tasks = new DexieFillTaskRepository(db);
    await tasks.create({
      runId: "B-retained-task",
      memorySpaceId: original.space.id,
      from: 0,
      to: 0,
      blockSize: 1,
      kind: "floor",
      initText: null,
      chatId: "story",
      status: "succeeded",
      errorMessage: null,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    await runtime.tasks.markFloorStatuses(original.space.id, 0, 0, "processed");
    releaseWrite();
    const completed = await lateCandidate;
    if (completed.kind !== "active") {
      throw new Error("expect A candidate saved");
    }
    expect(completed.space.id).not.toBe(original.space.id);
    expect(runtime.manager.getStatus()).toMatchObject({
      kind: "active",
      binding: { spaceId: original.space.id, chatIdentity: "char:0:story" },
    });
    const current = await runtime.publicRead.read();
    expect(current.context.chatIdentity).toBe("char:0:story");
    expect(current.snapshot.space.id).toBe(original.space.id);
    expect(current.snapshot.records.find((item) => item.id === record.id)?.payload[name.id]).toBe(
      "B 的新记录",
    );
    expect(await tasks.find("B-retained-task")).toBeDefined();
    expect(await runtime.tasks.ledgerStatuses(original.space.id, 0, 0)).toEqual([
      { floor: 0, status: "processed" },
    ]);
    expect(context.chatMetadata.otherPlugin).toBe("B 独有数据");
  });

  it("分支从自己的文件克隆，原聊天文件保持原内容并可重新加载", async () => {
    const db = createTestDatabase();
    const { context, handlers } = fakeStContext();
    const ports = createRuntimeTestPorts(() => context);
    const runtime = await startTestRuntime(() => context, {
      createDb: () => db,
      log: fakeLog(),
      ...ports,
    });
    const original = runtime.manager.getStatus();
    if (original?.kind !== "active") {
      throw new Error("expect original active");
    }
    const table = (await runtime.tables.list(original.space.id)).find(
      (item) => item.key === "characters",
    )!;
    const field = (await runtime.fields.list(original.space.id, table.id)).find(
      (item) => item.key === "name",
    )!;
    const record = await runtime.records.create(original.space.id, table.id, {
      payload: { [field.id]: "原空间较新内容" },
    });
    if (!record) {
      throw new Error("expect record created");
    }
    const currentUnit = await runtime.backup.exportCurrentSpace();
    const originalMetadata = structuredClone(context.chatMetadata);
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
    expect(await runtime.spaces.find(original.space.id)).toBeUndefined();
    expect(
      ports.snapshotWrites.filter((write) => write.target.identity === "char:3:story").at(-1)!.file
        .data.records[0]!.payload[field.id],
    ).toBe("原空间较新内容");
    const cloned = await runtime.manager.resolveBranch({
      action: "clone",
      sourceSpaceId: original.space.id,
    });
    if (cloned.kind !== "active") {
      throw new Error("expect cloned active");
    }
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
    expect(context.chatMetadata![CHAT_METADATA_MIRROR_KEY]).toMatchObject({
      spaceId: cloned.space.id,
    });
    context.chatId = "story";
    context.chatMetadata = originalMetadata;
    await handlers.get("chat_id_changed")!("story");
    expect(
      (await runtime.records.find(original.space.id, table.id, record.id))?.payload[field.id],
    ).toBe("原空间较新内容");
  });

  it("已有绑定和完整聊天快照：启动从文件加载真实 SQLite", async () => {
    const db = createTestDatabase();
    const unit: MemorySpaceBackup = {
      schemaVersion: 3 as const,
      floorLedger: [],
      space: {
        macros: [],
        id: "space-ghost" as MemorySpaceId,
        stableId: "space-ghost" as MemorySpaceId,
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
    if (status?.kind !== "active") {
      return;
    }
    expect(await runtime.spaces.find(status.space.id)).toMatchObject({ name: "爱丽丝 - story" });
    expect(status.space.id).toBe("space-ghost");
    expect((await runtime.backup.exportCurrentSpace()).space.id).toBe("space-ghost");
    // v1 绑定已迁移为 v2
    expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toEqual({
      version: 2,
      spaceId: "space-ghost",
      chatIdentity: "char:3:story",
    });
  });

  it("已有绑定缺少聊天快照：报告加载失败并保留绑定", async () => {
    const db = createTestDatabase();
    const { context, chatMetadata } = fakeStContext();
    chatMetadata[CHAT_METADATA_BINDING_KEY] = { version: 1, spaceId: "space-ghost" };

    const runtime = await startTestRuntime(() => context, { createDb: () => db, log: fakeLog() });

    expect(runtime.manager.getStatus()).toMatchObject({
      kind: "load-error",
      humanMsg: expect.stringContaining("没有记忆快照"),
    });
    expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toEqual({ version: 1, spaceId: "space-ghost" });
    expect(context.chatMetadata![CHAT_METADATA_MIRROR_KEY]).toBeUndefined();
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
    if (status?.kind !== "active") {
      throw new Error("expect active");
    }
    const unit = await runtime.backup.exportCurrentSpace();
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
    if (status?.kind !== "active") {
      throw new Error("expect active");
    }

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
    if (!charactersTable) {
      throw new Error("expect characters table");
    }
    const nameField = (await runtime.fields.list(status.space.id, charactersTable.id)).find(
      (f) => f.key === "name",
    );
    if (!nameField) {
      throw new Error("expect name field");
    }
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
    expect(runtime.persistence.getStatus("char:3:story").kind).toBe("submitted");

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
    if (status?.kind !== "active") {
      throw new Error("expect active");
    }

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
    if (status?.kind !== "active") {
      throw new Error("expect active");
    }

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

describe("强制同步与快照内进度", () => {
  it("普通修改不回读，强制同步核验当前记忆与进度", async () => {
    const db = createTestDatabase();
    const { context } = fakeStContext();
    const ports = createRuntimeTestPorts(() => context);
    const runtime = await startTestRuntime(() => context, {
      createDb: () => db,
      log: fakeLog(),
      ...ports,
    });
    const verify = vi.spyOn(ports.snapshotFiles, "verify");
    const original = await runtime.backup.exportCurrentSpace();
    const table = original.tables.find((item) => item.key === "characters")!;
    const name = original.fields.find((item) => item.tableId === table.id && item.key === "name")!;
    await runtime.records.create(original.space.id, table.id, {
      payload: { [name.id]: "已提交人物" },
    });
    await runtime.tasks.markFloorStatuses(original.space.id, 0, 0, "processed");
    expect(verify).not.toHaveBeenCalled();
    expect(runtime.persistence.getStatus("char:3:story").kind).toBe("submitted");
    await runtime.forceSyncMemory();
    expect(verify).toHaveBeenCalledOnce();
    expect(runtime.persistence.getStatus("char:3:story").kind).toBe("verified");
    expect(ports.snapshotWrites.at(-1)!.file.data).toMatchObject({
      records: [{ payload: { [name.id]: "已提交人物" } }],
      floorLedger: [{ floor: 0, status: "processed" }],
    });
  });

  it("强制同步等待已有 SQLite 提交及导出，核验包含该次修改", async () => {
    const db = createTestDatabase();
    const { context } = fakeStContext();
    const ports = createRuntimeTestPorts(() => context);
    const createSqlite = vi.fn(ports.createSqlite);
    const runtime = await startTestRuntime(() => context, {
      createDb: () => db,
      log: fakeLog(),
      ...ports,
      createSqlite,
    });
    const original = await runtime.backup.exportCurrentSpace();
    const table = original.tables.find((item) => item.key === "characters")!;
    const name = original.fields.find((item) => item.tableId === table.id && item.key === "name")!;
    const sqlite = await createSqlite.mock.results[0]!.value;
    const exportSpace = sqlite.exportSpace.bind(sqlite);
    let signalStarted!: () => void;
    let releaseExport!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseExport = resolve;
    });
    vi.spyOn(sqlite, "exportSpace").mockImplementationOnce(async (id) => {
      signalStarted();
      await released;
      return exportSpace(id);
    });
    const verify = vi.spyOn(ports.snapshotFiles, "verify");
    const editing = runtime.records.create(original.space.id, table.id, {
      payload: { [name.id]: "同步开始前已经提交" },
    });
    await started;
    const syncing = runtime.forceSyncMemory();
    try {
      expect(verify).not.toHaveBeenCalled();
    } finally {
      releaseExport();
    }
    await Promise.all([editing, syncing]);
    expect(verify).toHaveBeenCalledOnce();
    expect(ports.snapshotWrites.at(-1)!.file.data.records).toMatchObject([
      { payload: { [name.id]: "同步开始前已经提交" } },
    ]);
    expect(runtime.persistence.getStatus("char:3:story").kind).toBe("verified");
  });

  it("远端核验不一致后解除同步门控，下一次捕获最新提交", async () => {
    const db = createTestDatabase();
    const { context } = fakeStContext();
    const ports = createRuntimeTestPorts(() => context);
    const runtime = await startTestRuntime(() => context, {
      createDb: () => db,
      log: fakeLog(),
      ...ports,
    });
    const original = await runtime.backup.exportCurrentSpace();
    vi.spyOn(ports.snapshotFiles, "verify").mockResolvedValueOnce({
      steMemory: {},
      steMemoryMirror: {},
    });
    await expect(runtime.forceSyncMemory()).rejects.toThrow("完整记忆元数据与本次提交不一致");
    expect(runtime.persistence.getStatus("char:3:story")).toMatchObject({
      kind: "failed",
      operation: "force-sync",
    });
    await runtime.tasks.markFloorStatuses(original.space.id, 0, 0, "processed");
    await runtime.forceSyncMemory();
    expect(runtime.persistence.getStatus("char:3:story").kind).toBe("verified");
    expect(ports.snapshotWrites.at(-1)!.file.data.floorLedger).toMatchObject([
      { floor: 0, status: "processed" },
    ]);
  });

  it.each([false, true])(
    "核验期间阻止原聊天写入，切聊结果隔离（相同空间 ID：%s）",
    async (sameSpaceId) => {
      const db = createTestDatabase();
      const { context, handlers } = fakeStContext();
      const ports = createRuntimeTestPorts(() => context);
      const runtime = await startTestRuntime(() => context, {
        createDb: () => db,
        log: fakeLog(),
        ...ports,
      });
      const original = await runtime.backup.exportCurrentSpace();
      let signalStarted!: () => void;
      let releaseVerify!: () => void;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releaseVerify = resolve;
      });
      const verify = ports.snapshotFiles.verify;
      vi.spyOn(ports.snapshotFiles, "verify").mockImplementationOnce(async (target) => {
        const persisted = await verify(target);
        signalStarted();
        await released;
        return persisted;
      });
      const syncing = runtime.forceSyncMemory();
      // 同一轮事件中发起的新编辑也必须被挡住，不能等到回读阶段才建立门控。
      const table = original.tables.find((item) => item.key === "characters")!;
      const name = original.fields.find(
        (item) => item.tableId === table.id && item.key === "name",
      )!;
      await expect(
        runtime.records.create(original.space.id, table.id, {
          payload: { [name.id]: "同步期间不可提交" },
        }),
      ).rejects.toThrow("强制同步");
      await started;
      try {
        await expect(
          runtime.tasks.markFloorStatuses(original.space.id, 0, 0, "processed"),
        ).rejects.toThrow("强制同步");
        await expect(runtime.forceSyncMemory()).rejects.toThrow("强制同步");
        await expect(runtime.sqlConsole.execute(original.space.id, "SELECT 1")).rejects.toThrow(
          "强制同步",
        );
        if (sameSpaceId) {
          context.characterId = 0;
          context.chatMetadata = {
            ...structuredClone(context.chatMetadata),
            otherPlugin: "B 独有数据",
          };
        } else {
          context.chatId = "force-sync-B";
          context.chatMetadata = { otherPlugin: "B 独有数据" };
        }
        await handlers.get("chat_id_changed")!();
        const newSpace = await runtime.backup.exportCurrentSpace();
        expect(newSpace.space.id === original.space.id).toBe(sameSpaceId);
        await runtime.tasks.markFloorStatuses(newSpace.space.id, 0, 0, "processed");
        await runtime.forceSyncMemory();
      } finally {
        releaseVerify();
      }
      await syncing;
      expect(runtime.publicRead.getContext().chatIdentity).toBe(
        sameSpaceId ? "char:0:story" : "char:3:force-sync-B",
      );
      expect(context.chatMetadata.otherPlugin).toBe("B 独有数据");
      expect(context.chatMetadata[CHAT_METADATA_MIRROR_KEY]).toMatchObject({
        spaceId: runtime.publicRead.getContext().spaceId,
      });
    },
  );

  it("返回聊天时从快照恢复进度，其他聊天的楼层状态不混入", async () => {
    const db = createTestDatabase();
    const { context, handlers } = fakeStContext();
    const runtime = await startTestRuntime(() => context, { createDb: () => db, log: fakeLog() });
    const original = await runtime.backup.exportCurrentSpace();
    await runtime.tasks.markFloorStatuses(original.space.id, 0, 0, "processed");
    const metadataA = structuredClone(context.chatMetadata);
    context.chatId = "progress-B";
    context.chatMetadata = {};
    await handlers.get("chat_id_changed")!();
    const other = await runtime.backup.exportCurrentSpace();
    expect(await runtime.tasks.ledgerStatuses(other.space.id, 0, 0)).toEqual([
      { floor: 0, status: "untracked" },
    ]);
    await runtime.tasks.markFloorStatuses(other.space.id, 0, 0, "error");
    context.chatId = "story";
    context.chatMetadata = metadataA;
    await handlers.get("chat_id_changed")!();
    expect(await runtime.tasks.ledgerStatuses(original.space.id, 0, 0)).toEqual([
      { floor: 0, status: "processed" },
    ]);
  });
});

describe("关键清理与填表同步交错", () => {
  it.each(["clear-records", "apply-preset"] as const)(
    "%s 核验失败保留助手历史，继续强制同步后才清理",
    async (operation) => {
      const db = createTestDatabase();
      const { context } = fakeStContext();
      const ports = createRuntimeTestPorts(() => context);
      const runtime = await startTestRuntime(() => context, {
        createDb: () => db,
        log: fakeLog(),
        ...ports,
      });
      const original = await runtime.backup.exportCurrentSpace();
      const store = runtime.queryChat.store;
      await store.ready;
      const session = store.create({ chatKey: "char:3:story", spaceId: original.space.id });
      await store.flush();
      vi.spyOn(ports.snapshotFiles, "verify").mockRejectedValueOnce(new Error("readback offline"));
      if (operation === "clear-records") {
        await expect(runtime.spaceMaintenance.clearRecords(original.space.id)).rejects.toThrow(
          "readback offline",
        );
      } else {
        const outcome = await runtime.presetApply.applyPreset(
          original.space.id,
          SYSTEM_TABLE_PRESET,
          {
            chatIdentity: "char:3:story",
            refreshMacros: async () => {},
          },
        );
        expect(outcome.kind).toBe("applied-with-sync-issue");
      }
      expect(store.get(session.id)).toBeDefined();
      await runtime.forceSyncMemory();
      expect(() => store.get(session.id)).toThrow("会话已不存在");
      expect(runtime.persistence.getStatus("char:3:story").kind).toBe("verified");
    },
  );

  it("多批填表在强制核验边界等待，完成后续跑且不重放前批", async () => {
    const db = createTestDatabase();
    const { context } = fakeStContext({
      chat: [
        { name: "用户", is_user: true, mes: "第一楼剧情" },
        { name: "角色", mes: "第二楼剧情" },
      ],
      chatCompletionSettings: { chat_completion_source: "openai" },
      getChatCompletionModel: () => "test-model",
    });
    const ports = createRuntimeTestPorts(() => context);
    const runtime = await startTestRuntime(() => context, {
      createDb: () => db,
      log: fakeLog(),
      ...ports,
    });
    const original = await runtime.backup.exportCurrentSpace();
    const firstSaveStarted = Promise.withResolvers<void>();
    const firstSaveReleased = Promise.withResolvers<void>();
    const verifyStarted = Promise.withResolvers<void>();
    const verifyReleased = Promise.withResolvers<void>();
    const submit = ports.snapshotFiles.submit;
    const verify = ports.snapshotFiles.verify;
    vi.spyOn(ports.snapshotFiles, "submit").mockImplementationOnce(async (...args) => {
      await submit(...args);
      firstSaveStarted.resolve();
      await firstSaveReleased.promise;
    });
    vi.spyOn(ports.snapshotFiles, "verify").mockImplementationOnce(async (target) => {
      const persisted = await verify(target);
      verifyStarted.resolve();
      await verifyReleased.promise;
      return persisted;
    });
    let generationCount = 0;
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url) === "/csrf-token") {
        return Response.json({ token: "test-token" });
      }
      if (String(url) !== "/api/backends/chat-completions/generate") {
        throw new Error("unexpected test request: " + String(url));
      }
      generationCount++;
      const event = {
        choices: [{ index: 0, delta: { content: "本批无需新增记忆" }, finish_reason: "stop" }],
      };
      return new Response("data: " + JSON.stringify(event) + "\n\ndata: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    try {
      const task = await runtime.tasks.submit({
        memorySpaceId: original.space.id,
        from: 0,
        to: 1,
        blockSize: 1,
      });
      await firstSaveStarted.promise;
      // 第一批已提交而原生保存调用尚未返回，此时同步先建立门控。
      const syncing = runtime.forceSyncMemory();
      firstSaveReleased.resolve();
      await verifyStarted.promise;
      expect(generationCount).toBe(1);
      expect((await db.memoryFillTasks.get(task.runId))!.status).toBe("running");
      expect(await runtime.tasks.ledgerStatuses(original.space.id, 0, 1)).toEqual([
        { floor: 0, status: "processed" },
        { floor: 1, status: "untracked" },
      ]);
      verifyReleased.resolve();
      await syncing;
      await vi.waitFor(
        async () => {
          expect((await db.memoryFillTasks.get(task.runId))!.status).toBe("succeeded");
        },
        { timeout: 5000 },
      );
      expect(generationCount).toBe(2);
      expect(await runtime.tasks.ledgerStatuses(original.space.id, 0, 1)).toEqual([
        { floor: 0, status: "processed" },
        { floor: 1, status: "processed" },
      ]);
    } finally {
      firstSaveReleased.resolve();
      verifyReleased.resolve();
      await runtime.tasks.cancelAll(original.space.id);
      request.mockRestore();
    }
  });
});

describe("已激活候选的核验恢复", () => {
  it("新聊天核验失败仍完成聊天就绪，强制同步后无需再次切聊", async () => {
    const db = createTestDatabase();
    const { context, handlers } = fakeStContext();
    const ports = createRuntimeTestPorts(() => context);
    const runtime = await startTestRuntime(() => context, {
      createDb: () => db,
      log: fakeLog(),
      ...ports,
    });
    const ready = vi.spyOn(runtime.autoFill, "chatReady");
    vi.spyOn(ports.snapshotFiles, "verify").mockRejectedValueOnce(
      new Error("new chat verify offline"),
    );
    context.chatId = "new-chat";
    context.chatMetadata = {};
    await handlers.get("chat_id_changed")!();
    expect(runtime.manager.getStatus()?.kind).toBe("active");
    expect(ready).toHaveBeenCalledOnce();
    await runtime.forceSyncMemory();
    expect(runtime.persistence.getStatus("char:3:new-chat").kind).toBe("verified");
  });

  it("首次聊天核验失败仍保持活动候选，设置页可强制同步恢复", async () => {
    const db = createTestDatabase();
    const { context } = fakeStContext();
    const ports = createRuntimeTestPorts(() => context);
    vi.spyOn(ports.snapshotFiles, "verify").mockRejectedValueOnce(
      new Error("initial verify offline"),
    );
    const runtime = await startTestRuntime(() => context, {
      createDb: () => db,
      log: fakeLog(),
      ...ports,
    });
    const candidate = runtime.manager.getStatus();
    expect(candidate?.kind).toBe("active");
    const snapshot = await runtime.backup.exportCurrentSpace();
    expect(runtime.persistence.getStatus("char:3:story")).toMatchObject({
      kind: "failed",
      operation: "replacement",
    });
    await runtime.forceSyncMemory();
    expect((await runtime.backup.exportCurrentSpace()).space.id).toBe(snapshot.space.id);
    expect(runtime.persistence.getStatus("char:3:story").kind).toBe("verified");
  });

  it("导入核验后辅助清理失败保留活动候选，同页重试不重复导入", async () => {
    const db = createTestDatabase();
    const { context } = fakeStContext();
    const runtime = await startTestRuntime(() => context, { createDb: () => db, log: fakeLog() });
    const original = await runtime.backup.exportCurrentSpace();
    vi.spyOn(runtime.queryChat.store, "clearSpaceHistory").mockRejectedValueOnce(
      new Error("history cleanup failed"),
    );
    await expect(runtime.manager.importSpace(original)).rejects.toThrow("history cleanup failed");
    expect(runtime.manager.getStatus()?.kind).toBe("active");
    const candidate = await runtime.backup.exportCurrentSpace();
    expect(candidate.space.id).not.toBe(original.space.id);
    await runtime.forceSyncMemory();
    expect((await runtime.backup.exportCurrentSpace()).space.id).toBe(candidate.space.id);
    expect(runtime.persistence.getStatus("char:3:story").kind).toBe("verified");
  });
});

it("真实 ST 事件桥进入时只通知，收到有效 AI 楼层并结束生成后才申请自动入队", async () => {
  const db = createTestDatabase();
  const { context, handlers } = fakeStContext({
    chat: [
      { mes: "旧用户消息", is_user: true },
      { mes: "旧回复" },
      { mes: "下一问", is_user: true },
    ],
    eventTypes: {
      CHAT_CHANGED: "chat_id_changed",
      MESSAGE_SENT: "message_sent",
      MESSAGE_RECEIVED: "message_received",
      GENERATION_STARTED: "generation_started",
      GENERATION_ENDED: "generation_ended",
      GENERATION_STOPPED: "generation_stopped",
    },
  });
  const show = vi.fn();
  const runtime = await startTestRuntime(() => context, {
    createDb: () => db,
    log: fakeLog(),
    settingsStore: {
      read: () => ({
        ...DEFAULT_SETTINGS,
        autoFill: { ...DEFAULT_SETTINGS.autoFill, mode: "auto", interval: 1, delayFloors: 0 },
      }),
      write() {},
    },
    autoFillNotifications: { show, dismissReminder() {} },
  });
  const submit = vi.spyOn(runtime.tasks, "submit").mockRejectedValue(new Error("测试截断模型执行"));
  try {
    await vi.waitFor(() =>
      expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: "reminder" })),
    );
    expect(submit).not.toHaveBeenCalled();
    await handlers.get("generation_started")!("quiet", {}, false);
    handlers.get("generation_ended")!();
    await handlers.get("generation_started")!("normal", {}, true);
    handlers.get("generation_ended")!();
    await handlers.get("generation_started")!("normal", {}, false);
    handlers.get("generation_ended")!(); // 请求失败，没有收到 AI 消息。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(submit).not.toHaveBeenCalled();
    await handlers.get("generation_started")!("normal", {}, false);
    context.chat = [...context.chat!, { mes: "新的有效回复" }];
    handlers.get("message_received")!(3, "normal");
    expect(submit).not.toHaveBeenCalled();
    handlers.get("generation_ended")!();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0]![0]).toMatchObject({ from: 0, to: 3 });
    handlers.get("generation_ended")!();
    runtime.autoFill.kick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(submit).toHaveBeenCalledOnce();
  } finally {
    runtime.autoFill.stop();
  }
});
