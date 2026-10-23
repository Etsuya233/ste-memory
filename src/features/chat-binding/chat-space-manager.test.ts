import { SYSTEM_TABLE_TEMPLATES } from "../memory/index.ts";
import type {
  MemoryFieldId,
  MemoryFieldKey,
  MemoryRecordId,
  MemoryRevisionId,
  MemorySpaceId,
  MemoryTableId,
  MemoryTableKey,
} from "../memory/index.ts";
import type { MemorySpaceBackup } from "../backup/index.ts";
import { describe, expect, it, vi } from "vitest";
import { DexieMemoryBackupRepository } from "../../infrastructure/indexeddb/backup/memory-backup-repository.ts";
import { DexieMemoryChangeSource } from "../../infrastructure/indexeddb/memory-change-source.ts";
import { createChatMirrorFile } from "../chat-mirror/index.ts";
import { ChatMetadataMirrorSync } from "../chat-mirror/chat-metadata-mirror-sync.ts";
import {
  createServices,
  createTestDatabase,
  installDefaultPreset,
} from "../../infrastructure/indexeddb/test-support.ts";
import {
  StChatAdapter,
  CHAT_METADATA_BINDING_KEY,
  CHAT_METADATA_MIRROR_KEY,
  type StContext,
} from "../../infrastructure/sillytavern/chat-adapter.ts";
import {
  BINDING_UNRECOGNIZED_MESSAGE,
  ChatSpaceManager,
  SPACE_MISSING_MESSAGE,
  UNSAVED_CHAT_MESSAGE,
  buildChatSpaceName,
  type ChatSpaceManagerPorts,
  type SpaceContextStatus,
  type SpaceStructureInstallerPort,
} from "./chat-space-manager.ts";

type ActiveStatus = Extract<SpaceContextStatus, { kind: "active" }>;

/** 建一个互不冲突的测试对话上下文；metadata 随对话文件走（重命名模拟 = 改 chatId） */
function chatContext(
  chatId: string | undefined,
  characterName: string | undefined,
  characterId: number | undefined,
  overrides: Partial<StContext> = {},
): { context: StContext; chatMetadata: Record<string, unknown> } {
  const chatMetadata: Record<string, unknown> = {};
  const context: StContext = {
    chatId,
    characterId,
    groupId: null,
    name2: characterName,
    chat: [],
    chatMetadata,
    ...overrides,
  };
  return { context, chatMetadata };
}

function createHarness() {
  const db = createTestDatabase();
  const services = createServices(db);
  const installer: SpaceStructureInstallerPort = {
    installDefaultStructure: (id) => installDefaultPreset(db, id),
  };
  return {
    db,
    services,
    /** 同一套 Dexie 服务上再建一个 manager（模拟刷新/另一角色等场景） */
    createManager(
      context: StContext,
      options: {
        installer?: SpaceStructureInstallerPort;
        log?: ChatSpaceManagerPorts["log"];
        mirrorRestore?: ChatSpaceManagerPorts["mirrorRestore"];
      } = {},
    ) {
      // adapter 持有 getContext 工厂：模拟 ST 每次调用构造新上下文（切对话重取）
      const adapter = new StChatAdapter(() => context);
      const manager = new ChatSpaceManager({
        getChat: () => adapter.getChatSnapshot(),
        bindingStore: adapter.bindingStore,
        spaces: services.spaces,
        installer: options.installer ?? installer,
        mirrorRestore: options.mirrorRestore,
        log: options.log,
      });
      return { adapter, manager };
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("ChatSpaceManager（对话 → 记忆空间上下文）", () => {
  it("首次打开对话：自动建空间 + 按默认预设初始化结构 + 写绑定，状态 active(created)", async () => {
    const h = createHarness();
    const { context, chatMetadata } = chatContext("story", "爱丽丝", 3);
    const { manager } = h.createManager(context);

    const status = await manager.syncToCurrentChat();

    expect(status.kind).toBe("active");
    if (status.kind !== "active") return;
    expect(status.created).toBe(true);
    expect(status.space.name).toBe("爱丽丝 - story");
    expect(manager.getStatus()).toBe(status);

    const binding = chatMetadata[CHAT_METADATA_BINDING_KEY] as {
      version: number;
      spaceId: string;
      chatIdentity: string;
    };
    expect(binding).toEqual({ version: 2, spaceId: status.space.id, chatIdentity: "char:3:story" });
    // 默认预设结构全部就位（表格预设：系统默认）
    const tables = await h.services.tables.list(status.space.id);
    expect(tables).toHaveLength(SYSTEM_TABLE_TEMPLATES.length);
    expect(tables.every((t) => t.enabled)).toBe(true);
  });

  it("再次打开（页面刷新语义）不重复建：绑定存在 → 直接激活", async () => {
    const h = createHarness();
    const { context, chatMetadata } = chatContext("story", "爱丽丝", 3);
    const { manager } = h.createManager(context);
    await manager.syncToCurrentChat();
    const first = manager.getStatus() as ActiveStatus;

    // 刷新：ST 从对话文件重载 chatMetadata（含绑定），chatId 与空间不变
    const reopenedContext = chatContext("story", "爱丽丝", 3, {
      chatMetadata: JSON.parse(JSON.stringify(chatMetadata)) as Record<string, unknown>,
    });
    const { manager: reopened } = h.createManager(reopenedContext.context);
    const status = await reopened.syncToCurrentChat();

    expect(status.kind).toBe("active");
    if (status.kind !== "active") return;
    expect(status.created).toBe(false);
    expect(status.space.id).toBe(first.space.id);
    expect(await h.services.spaces.list()).toHaveLength(1);
    expect(await h.services.tables.list(status.space.id)).toHaveLength(
      SYSTEM_TABLE_TEMPLATES.length,
    );
  });

  it("对话重命名后触发分支检测：chatIdentity 变化导致绑定不匹配", async () => {
    const h = createHarness();
    const { context } = chatContext("story", "爱丽丝", 3);
    const { manager } = h.createManager(context);
    await manager.syncToCurrentChat();
    const before = manager.getStatus() as ActiveStatus;

    // ST 重命名 = 对话文件改名 → chatId 变，chatMetadata（含绑定）随文件走
    // chatIdentityKey 变化触发分支检测（spec 决策：分支检测依赖 chatIdentity 匹配）
    context.chatId = "story-改";
    const status = await manager.syncToCurrentChat();

    expect(status.kind).toBe("branch-detected");
    if (status.kind !== "branch-detected") return;
    expect(status.space.id).toBe(before.space.id);
    expect(status.originalChatIdentity).toBe("char:3:story");
    expect(await h.services.spaces.list()).toHaveLength(1);
  });

  it("切对话切换空间上下文：新空间 + 新绑定，旧空间保留", async () => {
    const h = createHarness();
    const { context } = chatContext("story", "爱丽丝", 3);
    const { manager } = h.createManager(context);
    await manager.syncToCurrentChat();
    const first = manager.getStatus() as ActiveStatus;

    // ST 切对话：chatId 换成新对话，chatMetadata 被整体替换（载入新对话文件，无绑定）
    context.chatId = "other";
    context.chatMetadata = {};
    const status = await manager.syncToCurrentChat();

    expect(status.kind).toBe("active");
    if (status.kind !== "active") return;
    expect(status.created).toBe(true);
    expect(status.space.id).not.toBe(first.space.id);
    expect(status.space.name).toBe("爱丽丝 - other");
    expect(manager.getStatus()).toBe(status);
    expect(await h.services.spaces.list()).toHaveLength(2);
  });

  it("群聊：按对话文件绑定，空间名 = 「群聊 - 对话文件名」（群聊无角色名）", async () => {
    const h = createHarness();
    const { context, chatMetadata } = chatContext("group-story", undefined, undefined, {
      groupId: "g1",
    });
    const { manager } = h.createManager(context);

    const status = await manager.syncToCurrentChat();

    expect(status.kind).toBe("active");
    if (status.kind !== "active") return;
    expect(status.space.name).toBe("群聊 - group-story");
    expect((chatMetadata[CHAT_METADATA_BINDING_KEY] as { spaceId: string }).spaceId).toBe(
      status.space.id,
    );
  });

  it("chatId 为 undefined（临时/未保存对话）：跳过绑定、不建空间、不报错", async () => {
    const h = createHarness();
    const { context, chatMetadata } = chatContext(undefined, "爱丽丝", 3);
    const { manager } = h.createManager(context);

    const status = await manager.syncToCurrentChat();

    expect(status).toEqual({ kind: "unsaved-chat", humanMsg: UNSAVED_CHAT_MESSAGE });
    expect(manager.getStatus()).toBe(status);
    expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toBeUndefined();
    expect(await h.services.spaces.list()).toHaveLength(0);
  });

  it("绑定存在但空间不在本地库（新设备/本地库被清）：保持绑定、不重建", async () => {
    const h = createHarness();
    const { context, chatMetadata } = chatContext("story", "爱丽丝", 3);
    chatMetadata[CHAT_METADATA_BINDING_KEY] = { version: 1, spaceId: "space-ghost" };
    const { manager } = h.createManager(context);

    const status = await manager.syncToCurrentChat();

    if (status.kind !== "space-missing") {
      expect.fail(`预期 space-missing，实际 ${status.kind}`);
      return;
    }
    expect(status.binding.spaceId).toBe("space-ghost");
    expect(status.humanMsg).toBe(SPACE_MISSING_MESSAGE);
    // v1 绑定已迁移为 v2（对话文件镜像恢复后自动恢复），空间不重建
    expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toEqual({
      version: 2,
      spaceId: "space-ghost",
      chatIdentity: "char:3:story",
    });
    expect(await h.services.spaces.list()).toHaveLength(0);
  });

  it("绑定在、空间缺失、镜像恢复成功：active(restored)，空间数据落地", async () => {
    const h = createHarness();
    const { context, chatMetadata } = chatContext("story", "爱丽丝", 3);
    chatMetadata[CHAT_METADATA_BINDING_KEY] = { version: 1, spaceId: "space-ghost" };
    // 镜像恢复端口：落地一个空间（模拟 restoreSpace 写入）后返回 true
    const restore = vi.fn(async () => {
      await h.db.memorySpaces.add({
        id: "space-ghost" as MemorySpaceId,
        name: "爱丽丝 - story",
        initializationSource: null,
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      });
      return true;
    });
    const { manager } = h.createManager(context, { mirrorRestore: { restore } });

    const status = await manager.syncToCurrentChat();

    expect(restore).toHaveBeenCalledWith({
      version: 2,
      spaceId: "space-ghost",
      chatIdentity: "char:3:story",
    });
    expect(status.kind).toBe("active");
    if (status.kind !== "active") return;
    expect(status.restored).toBe(true);
    expect(status.created).toBe(false);
    expect(status.space.id).toBe("space-ghost");
    // 绑定已迁移为 v2，不重复建空间
    expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toEqual({
      version: 2,
      spaceId: "space-ghost",
      chatIdentity: "char:3:story",
    });
  });

  it("绑定在、空间缺失、镜像恢复失败：维持 space-missing（不报错）", async () => {
    const h = createHarness();
    const { context, chatMetadata } = chatContext("story", "爱丽丝", 3);
    chatMetadata[CHAT_METADATA_BINDING_KEY] = { version: 1, spaceId: "space-ghost" };
    const restore = vi.fn(async () => false);
    const { manager } = h.createManager(context, { mirrorRestore: { restore } });

    const status = await manager.syncToCurrentChat();

    expect(restore).toHaveBeenCalled();
    if (status.kind !== "space-missing") {
      expect.fail(`预期 space-missing，实际 ${status.kind}`);
      return;
    }
    expect(status.humanMsg).toBe(SPACE_MISSING_MESSAGE);
    // v1 已迁移为 v2
    expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toEqual({
      version: 2,
      spaceId: "space-ghost",
      chatIdentity: "char:3:story",
    });
    expect(await h.services.spaces.list()).toHaveLength(0);
  });

  it.each(["char:3:story", "char:10:story"])(
    "镜像恢复期间切走对话：不发布旧状态或重写绑定（%s）",
    async (originalIdentity) => {
      const h = createHarness();
      const { context, chatMetadata } = chatContext("story", "爱丽丝", 3);
      const originalBinding = {
        version: 2,
        spaceId: "space-ghost",
        chatIdentity: originalIdentity,
      };
      chatMetadata[CHAT_METADATA_BINDING_KEY] = originalBinding;
      const gate = deferred<boolean>();
      const restore = vi.fn(async () => {
        await gate.promise;
        await h.db.memorySpaces.add({
          id: "space-ghost" as MemorySpaceId,
          name: "爱丽丝 - story",
          initializationSource: null,
          createdAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:00.000Z",
        });
        return true;
      });
      const { manager } = h.createManager(context, { mirrorRestore: { restore } });

      const pending = manager.syncToCurrentChat();
      // 等恢复端口被调用（入口快照已捕获、恢复挂起中）再切走
      await vi.waitFor(() => expect(restore).toHaveBeenCalled());
      context.chatId = "other"; // 恢复期间切走
      context.chatMetadata = {};
      gate.resolve(true);
      await pending;

      expect(restore).toHaveBeenCalled();
      expect(manager.getStatus()).toBeUndefined(); // 未发布（结果属于旧对话，新对话的同步已在队列）
      expect(context.chatMetadata).toEqual({});
      expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toEqual(originalBinding);
    },
  );

  it("绑定值无法识别（损坏/未来版本）：原样保留、不新建覆盖", async () => {
    const h = createHarness();
    const { context, chatMetadata } = chatContext("story", "爱丽丝", 3);
    chatMetadata[CHAT_METADATA_BINDING_KEY] = { version: 2, spaceId: "future-space" };
    const { manager } = h.createManager(context);

    const status = await manager.syncToCurrentChat();

    if (status.kind !== "binding-unrecognized") {
      expect.fail(`预期 binding-unrecognized，实际 ${status.kind}`);
      return;
    }
    expect(status.humanMsg).toBe(BINDING_UNRECOGNIZED_MESSAGE);
    // 原值不动：新建覆盖会丢掉未来版本/损坏的绑定指针（如插件降级场景）
    expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toEqual({
      version: 2,
      spaceId: "future-space",
    });
    expect(await h.services.spaces.list()).toHaveLength(0);
  });

  it("跨角色同名对话文件互不冲突（绑定靠指针，名字只是显示）", async () => {
    const h = createHarness();
    const { context: aliceContext } = chatContext("story", "爱丽丝", 3);
    const { manager: alice } = h.createManager(aliceContext);
    await alice.syncToCurrentChat();
    const aliceSpace = (alice.getStatus() as ActiveStatus).space;

    // 鲍勃的同名对话文件（自己的 chatMetadata，自己的空间）
    const { context: bobContext, chatMetadata: bobMetadata } = chatContext("story", "鲍勃", 9);
    const { manager: bob } = h.createManager(bobContext);
    const status = await bob.syncToCurrentChat();

    expect(status.kind).toBe("active");
    if (status.kind !== "active") return;
    expect(status.space.id).not.toBe(aliceSpace.id);
    expect(status.space.name).toBe("鲍勃 - story");
    expect((bobMetadata[CHAT_METADATA_BINDING_KEY] as { spaceId: string }).spaceId).toBe(
      status.space.id,
    );
    expect(await h.services.spaces.list()).toHaveLength(2);
  });

  it("结构初始化失败：空间回滚、不写绑定、错误上抛，下次打开可重试", async () => {
    const h = createHarness();
    const { context, chatMetadata } = chatContext("story", "爱丽丝", 3);
    const installDefaultStructure = vi
      .fn<SpaceStructureInstallerPort["installDefaultStructure"]>()
      .mockRejectedValueOnce(new Error("install boom"))
      .mockResolvedValue(undefined);
    const { manager } = h.createManager(context, {
      installer: { installDefaultStructure },
    });

    await expect(manager.syncToCurrentChat()).rejects.toThrow("install boom");

    expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toBeUndefined();
    expect(await h.services.spaces.list()).toHaveLength(0);

    const status = await manager.syncToCurrentChat();
    expect(status.kind).toBe("active");
    if (status.kind !== "active") return;
    expect(status.created).toBe(true);
    expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toBeDefined();
  });

  it("v2 绑定 + chatIdentity 匹配：正常 active", async () => {
    const h = createHarness();
    const { context, chatMetadata } = chatContext("story", "爱丽丝", 3);
    // 预设 v2 绑定（模拟已创建空间）
    const space = await h.services.spaces.create("爱丽丝 - story");
    chatMetadata[CHAT_METADATA_BINDING_KEY] = {
      version: 2,
      spaceId: space.id,
      chatIdentity: "char:3:story",
    };
    const { manager } = h.createManager(context);

    const status = await manager.syncToCurrentChat();

    expect(status.kind).toBe("active");
    if (status.kind !== "active") return;
    expect(status.created).toBe(false);
    expect(status.space.id).toBe(space.id);
  });

  it("v2 绑定 + chatIdentity 不匹配 + 空间存在：branch-detected", async () => {
    const h = createHarness();
    const { context, chatMetadata } = chatContext("story", "爱丽丝", 3);
    // 预设 v2 绑定（模拟原对话的空间）
    const space = await h.services.spaces.create("爱丽丝 - story");
    chatMetadata[CHAT_METADATA_BINDING_KEY] = {
      version: 2,
      spaceId: space.id,
      chatIdentity: "char:3:original-story", // 原对话的 chatIdentity
    };
    const { manager } = h.createManager(context);

    const status = await manager.syncToCurrentChat();

    expect(status.kind).toBe("branch-detected");
    if (status.kind !== "branch-detected") return;
    expect(status.space.id).toBe(space.id);
    expect(status.originalChatIdentity).toBe("char:3:original-story");
  });

  it.each([
    ["角色编号变化", "char:10:story:2026", "story:2026", "active"],
    ["复制对话", "char:3:original-story", "story", "branch-detected"],
    ["跨设备分支", "char:10:original-story", "story", "branch-detected"],
    ["群聊迁入单聊", "group:10:story", "story", "branch-detected"],
  ])("空间缺失时先恢复镜像，再判断%s", async (_label, originalIdentity, chatId, kind) => {
    const h = createHarness();
    const { context, chatMetadata } = chatContext(chatId, "爱丽丝", 3);
    const originalBinding = {
      version: 2,
      spaceId: "space-ghost",
      chatIdentity: originalIdentity,
    };
    chatMetadata[CHAT_METADATA_BINDING_KEY] = originalBinding;
    const restore = vi.fn(async () => {
      await h.db.memorySpaces.add({
        id: "space-ghost" as MemorySpaceId,
        name: "爱丽丝 - 原对话",
        initializationSource: null,
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      });
      return true;
    });
    const { manager } = h.createManager(context, { mirrorRestore: { restore } });

    const status = await manager.syncToCurrentChat();

    expect(restore).toHaveBeenCalledWith(originalBinding);
    expect(status).toMatchObject({ kind, space: { id: "space-ghost" } });
    if (kind === "active") {
      expect(status).toMatchObject({ restored: true, created: false });
      expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toEqual({
        ...originalBinding,
        chatIdentity: `char:3:${chatId}`,
      });
      expect(await manager.syncToCurrentChat()).toMatchObject({ kind: "active", restored: false });
      expect(restore).toHaveBeenCalledTimes(1);
    } else {
      expect(status).toMatchObject({ originalChatIdentity: originalIdentity });
      expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toEqual(originalBinding);
      const resolved = await manager.resolveBranch({ action: "create" });
      expect(resolved.kind).toBe("active");
      expect(await h.services.spaces.find("space-ghost" as MemorySpaceId)).toBeDefined();
      expect(await h.services.spaces.list()).toHaveLength(2);
    }
  });

  it("角色编号变化但本地已有空间：保留分支确认且不恢复覆盖", async () => {
    const h = createHarness();
    const { context, chatMetadata } = chatContext("story", "爱丽丝", 3);
    const space = await h.services.spaces.create("原对话");
    const originalBinding = { version: 2, spaceId: space.id, chatIdentity: "char:10:story" };
    chatMetadata[CHAT_METADATA_BINDING_KEY] = originalBinding;
    const restore = vi.fn(async () => true);
    const { manager } = h.createManager(context, { mirrorRestore: { restore } });

    expect(await manager.syncToCurrentChat()).toMatchObject({ kind: "branch-detected" });
    expect(restore).not.toHaveBeenCalled();
    expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toEqual(originalBinding);
  });

  it.each(["story", "story-copy"])("真实镜像恢复及分支克隆保留记录（%s）", async (chatId) => {
    const source = createHarness();
    const sourceChat = chatContext("story", "爱丽丝", 10);
    const { manager: sourceManager } = source.createManager(sourceChat.context);
    const sourceStatus = (await sourceManager.syncToCurrentChat()) as ActiveStatus;
    const sourceBackup = new DexieMemoryBackupRepository(source.db);
    const sourceUnit = (await sourceBackup.loadSnapshot()).spaces[0]!;
    const field = sourceUnit.fields.find((field) => field.type === "short_text")!;
    const unit: MemorySpaceBackup = {
      ...sourceUnit,
      records: [
        {
          id: "record-source" as MemoryRecordId,
          memorySpaceId: sourceUnit.space.id,
          tableId: field.tableId,
          payload: { [field.id]: "跨设备保留的记忆" },
          fieldEvidence: {},
          displayText: "跨设备保留的记忆",
          source: { type: "manual" },
          revisionId: "revision-source" as MemoryRevisionId,
          revisionSource: "user",
          createdAt: sourceUnit.space.createdAt,
          updatedAt: sourceUnit.space.updatedAt,
        },
      ],
    };

    const target = createHarness();
    const { context, chatMetadata } = chatContext(chatId, "爱丽丝", 2);
    chatMetadata[CHAT_METADATA_BINDING_KEY] = sourceStatus.binding;
    const mirror = createChatMirrorFile(unit, unit.space.id, unit.space.updatedAt, "0.1.4");
    chatMetadata[CHAT_METADATA_MIRROR_KEY] = mirror;
    const adapter = new StChatAdapter(() => context);
    const backup = new DexieMemoryBackupRepository(target.db);
    const mirrorSync = new ChatMetadataMirrorSync({
      getChat: () => adapter.getChatSnapshot(),
      bindingStore: adapter.bindingStore,
      mirrorStore: adapter.mirrorStore,
      backup,
      changes: new DexieMemoryChangeSource(target.db),
      isEnabled: () => true,
      includeHistory: () => true,
      appVersion: () => "0.1.7",
      now: () => new Date(),
    });
    let sequence = 0;
    const manager = new ChatSpaceManager({
      getChat: () => adapter.getChatSnapshot(),
      bindingStore: adapter.bindingStore,
      spaces: target.services.spaces,
      installer: { installDefaultStructure: (id) => installDefaultPreset(target.db, id) },
      mirrorRestore: { restore: (binding) => mirrorSync.restoreFromMirror(binding) },
      backup,
      createId: (prefix) => `clone-${prefix}-${++sequence}`,
    });

    const status = await manager.syncToCurrentChat();
    expect((await backup.loadSnapshot()).spaces).toEqual([unit]);
    expect(chatMetadata[CHAT_METADATA_MIRROR_KEY]).toEqual(mirror);
    if (chatId === "story") {
      expect(status).toMatchObject({
        kind: "active",
        restored: true,
        binding: { chatIdentity: "char:2:story" },
      });
    } else {
      expect(status.kind).toBe("branch-detected");
      const resolved = await manager.resolveBranch({
        action: "clone",
        sourceSpaceId: unit.space.id,
      });
      expect(resolved.kind).toBe("active");
      const spaces = (await backup.loadSnapshot()).spaces;
      expect(spaces.find((space) => space.space.id === unit.space.id)).toEqual(unit);
      const clone = spaces.find((space) => space.space.id !== unit.space.id)!;
      expect(clone.records).toHaveLength(1);
      expect(clone.records[0]!.id).not.toBe(unit.records[0]!.id);
      expect(Object.values(clone.records[0]!.payload)).toEqual(["跨设备保留的记忆"]);
      expect(clone.tables).toHaveLength(unit.tables.length);
      expect(clone.fields).toHaveLength(unit.fields.length);
    }
  });

  it("身份不匹配且镜像无法恢复：保持绑定和 space-missing", async () => {
    const h = createHarness();
    const { context, chatMetadata } = chatContext("story", "爱丽丝", 3);
    const originalBinding = { version: 2, spaceId: "space-ghost", chatIdentity: "char:10:story" };
    chatMetadata[CHAT_METADATA_BINDING_KEY] = originalBinding;
    const restore = vi.fn(async () => false);
    const { manager } = h.createManager(context, { mirrorRestore: { restore } });

    expect(await manager.syncToCurrentChat()).toMatchObject({ kind: "space-missing" });
    expect(restore).toHaveBeenCalledWith(originalBinding);
    expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toEqual(originalBinding);
    expect(await h.services.spaces.list()).toHaveLength(0);
  });

  it("v2 绑定 + chatIdentity 不匹配 + 空间缺失且没有恢复端口：space-missing", async () => {
    const h = createHarness();
    const { context, chatMetadata } = chatContext("story", "爱丽丝", 3);
    chatMetadata[CHAT_METADATA_BINDING_KEY] = {
      version: 2,
      spaceId: "space-ghost",
      chatIdentity: "char:3:original-story",
    };
    const { manager } = h.createManager(context);

    const status = await manager.syncToCurrentChat();

    if (status.kind !== "space-missing") {
      expect.fail(`预期 space-missing，实际 ${status.kind}`);
      return;
    }
    expect(status.binding.spaceId).toBe("space-ghost");
    expect(status.humanMsg).toBe(SPACE_MISSING_MESSAGE);
  });

  it("v1 绑定 + chatIdentity 不匹配（迁移盲区）：迁移为 v2 后正常 active（不弹窗）", async () => {
    const h = createHarness();
    const { context, chatMetadata } = chatContext("story", "爱丽丝", 3);
    // 预设 v1 绑定（模拟原对话的空间）
    const space = await h.services.spaces.create("爱丽丝 - story");
    chatMetadata[CHAT_METADATA_BINDING_KEY] = {
      version: 1,
      spaceId: space.id,
    };
    // 切到不同对话（chatIdentity 不匹配）
    context.chatId = "other-story";
    const { manager } = h.createManager(context);

    const status = await manager.syncToCurrentChat();

    // v1 绑定被迁移为 v2，chatIdentity 写入当前对话的身份，不会触发分支检测
    expect(status.kind).toBe("active");
    if (status.kind !== "active") return;
    expect(status.space.id).toBe(space.id);
    // 绑定已迁移为 v2
    expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toEqual({
      version: 2,
      spaceId: space.id,
      chatIdentity: "char:3:other-story",
    });
  });

  it("首次创建空间写入 v2 绑定（含 chatIdentity）", async () => {
    const h = createHarness();
    const { context, chatMetadata } = chatContext("story", "爱丽丝", 3);
    const { manager } = h.createManager(context);

    const status = await manager.syncToCurrentChat();

    expect(status.kind).toBe("active");
    if (status.kind !== "active") return;
    expect(status.created).toBe(true);
    const binding = chatMetadata[CHAT_METADATA_BINDING_KEY] as {
      version: number;
      chatIdentity: string;
    };
    expect(binding.version).toBe(2);
    expect(binding.chatIdentity).toBe("char:3:story");
  });

  it("同步期间切走：不发布旧对话结果、不写绑定、孤儿空间回滚", async () => {
    const h = createHarness();
    const { context, chatMetadata } = chatContext("story", "爱丽丝", 3);
    const gate = deferred<void>();
    const { manager } = h.createManager(context, {
      installer: { installDefaultStructure: () => gate.promise },
    });

    const first = manager.syncToCurrentChat();
    await Promise.resolve(); // 让同步体先取快照并挂起在结构初始化上
    context.chatId = "story-2"; // 用户切走
    context.chatMetadata = {}; // 新对话的 metadata（无绑定）
    gate.resolve();

    const stale = await first;
    expect(stale.kind).toBe("active"); // 返回结果，但属于旧对话
    expect(manager.getStatus()).toBeUndefined(); // 未发布
    expect(chatMetadata[CHAT_METADATA_BINDING_KEY]).toBeUndefined(); // 绑定未写进新对话
    expect(await h.services.spaces.list()).toHaveLength(0); // 孤儿空间已回滚

    const second = await manager.syncToCurrentChat();
    expect(second.kind).toBe("active");
    expect(manager.getStatus()?.kind).toBe("active");
    expect(await h.services.spaces.list()).toHaveLength(1);
  });

  it("状态订阅：变化时通知，退订后不再通知", async () => {
    const h = createHarness();
    const { context } = chatContext("story", "爱丽丝", 3);
    const { manager } = h.createManager(context);
    const listener = vi.fn();
    const unsubscribe = manager.onStatusChange(listener);

    await manager.syncToCurrentChat();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    await manager.syncToCurrentChat(); // 幂等再同步也会发布
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("buildChatSpaceName（空间显示名）", () => {
  it("单人 = 角色名 - 对话文件名", () => {
    expect(buildChatSpaceName({ chatId: "story", groupId: null, characterName: "爱丽丝" })).toBe(
      "爱丽丝 - story",
    );
  });

  it("群聊 = 群聊 - 对话文件名（群聊无角色名）", () => {
    expect(
      buildChatSpaceName({ chatId: "group-story", groupId: "g1", characterName: undefined }),
    ).toBe("群聊 - group-story");
  });

  it("无角色名兜底 = 对话 - 对话文件名", () => {
    expect(buildChatSpaceName({ chatId: "story", groupId: null, characterName: undefined })).toBe(
      "对话 - story",
    );
  });

  it("超长对话文件名截断到 120 字符（memorySpaceName 上限，按 UTF-16 长度口径），前缀保留", () => {
    const name = buildChatSpaceName({
      chatId: "x".repeat(200),
      groupId: null,
      characterName: "爱丽丝",
    });
    expect(name.length).toBe(120);
    expect(name.startsWith("爱丽丝 - ")).toBe(true);
  });

  it("emoji 密集文件名也保证 UTF-16 长度 ≤ 120（Memory 校验口径）", () => {
    const name = buildChatSpaceName({
      chatId: "😀".repeat(100), // 200 个 UTF-16 单元
      groupId: null,
      characterName: "爱丽丝",
    });
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.startsWith("爱丽丝 - ")).toBe(true);
  });

  it("importSpace：克隆文件单元为新空间 + 重建绑定，原空间保留（issue 26 / ADR 0012）", async () => {
    const h = createHarness();
    const { context } = chatContext("story", "爱丽丝", 3);
    const backup = new DexieMemoryBackupRepository(h.db);
    let seq = 0;
    const createId = (prefix: string) => `new-${prefix}-${++seq}` as MemorySpaceId;
    const adapter = new StChatAdapter(() => context);
    const manager2 = new ChatSpaceManager({
      getChat: () => adapter.getChatSnapshot(),
      bindingStore: adapter.bindingStore,
      spaces: h.services.spaces,
      installer: { installDefaultStructure: (id) => installDefaultPreset(h.db, id) },
      backup,
      createId,
    });

    // 当前对话先有绑定空间 S
    const before = (await manager2.syncToCurrentChat()) as ActiveStatus;
    expect(before.kind).toBe("active");
    const originalSpaceId = before.space.id;

    // 构造一个与当前空间无关的文件单元（记忆空间「旧名」）
    const unit: MemorySpaceBackup = {
      space: {
        id: "imported-space" as MemorySpaceId,
        name: "旧名",
        initializationSource: {
          presetId: "p-imported",
          presetName: "导入来源预设",
          appliedAt: "2026-09-01T00:00:00.000Z",
        },
        createdAt: "",
        updatedAt: "",
      },
      tables: [
        {
          id: "t1" as MemoryTableId,
          memorySpaceId: "imported-space" as MemorySpaceId,
          key: "k" as MemoryTableKey,
          position: 0,
          name: "T",
          description: "",
          prompt: "",
          enabled: true,
          displayStrategy: null,
          createdAt: "",
          updatedAt: "",
        },
      ],
      fields: [
        {
          id: "f1" as MemoryFieldId,
          memorySpaceId: "imported-space" as MemorySpaceId,
          tableId: "t1" as MemoryTableId,
          key: "k" as MemoryFieldKey,
          name: "F",
          type: "short_text",
          required: false,
          prompt: "",
          enabled: true,
          position: 0,
          options: [],
          referenceTableId: null,
          maxChars: null,
          valuePattern: null,
          valuePatternMessage: null,
          createdAt: "",
          updatedAt: "",
        },
      ],
      records: [
        {
          id: "r1" as MemoryRecordId,
          memorySpaceId: "imported-space" as MemorySpaceId,
          tableId: "t1" as MemoryTableId,
          payload: { f1: "v" },
          fieldEvidence: {},
          displayText: "v",
          source: { type: "manual" },
          revisionId: "rev1" as MemoryRevisionId,
          revisionSource: "user",
          createdAt: "",
          updatedAt: "",
        },
      ],
      history: [],
      evidence: [],
    };

    const status = (await manager2.importSpace(unit)) as ActiveStatus;
    expect(status.kind).toBe("active");
    // 绑定指向全新空间（非原空间），原空间保留（ADR 0012）
    expect(status.space.id).not.toBe(originalSpaceId);
    const binding = adapter.bindingStore.read();
    expect(binding.kind).toBe("bound");
    if (binding.kind === "bound") {
      expect(binding.binding.spaceId).toBe(status.space.id);
    }
    // 新空间继承文件中的空间名后按当前对话命名规则重命名
    expect(status.space.name).toBe("爱丽丝 - story");
    // 数据库里现在有两个空间：原空间 + 克隆的新空间
    const snapshot = await backup.loadSnapshot();
    expect(snapshot.spaces).toHaveLength(2);
    expect(snapshot.spaces.find((u) => u.space.id === originalSpaceId)).toBeDefined();
    const cloned = snapshot.spaces.find((u) => u.space.id === status.space.id)!;
    expect(cloned.tables).toHaveLength(1);
    expect(cloned.records).toHaveLength(1);
    // 记录的 payload 键被重映射为克隆后的新字段 id（外键重映射正确）
    const clonedFieldId = cloned.fields[0]!.id;
    expect(cloned.records[0]!.payload).toEqual({ [clonedFieldId]: "v" });
    // 初始化来源随克隆保留（不依赖本地预设库中存在来源预设；AC-18）
    expect(cloned.space.initializationSource).toEqual({
      presetId: "p-imported",
      presetName: "导入来源预设",
      appliedAt: "2026-09-01T00:00:00.000Z",
    });
  });
});
