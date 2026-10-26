import { captureSpaceStructure } from "./features/table-presets/space-structure-capture.ts";
import { presetUpdateChanges } from "./features/table-presets/preset-space-update.ts";
import { describe, expect, it, vi } from "vitest";
import {
  createTestDatabase,
  createTestLogDatabase,
} from "./infrastructure/indexeddb/test-support.ts";
import { startSteMemory } from "./runtime.ts";
import type { StContext } from "./infrastructure/sillytavern/chat-adapter.ts";
import {
  DEFAULT_SETTINGS,
  type PluginSettings,
  type SettingsStore,
} from "./features/settings/plugin-settings.ts";
import type { VectorEmbeddingPort } from "./features/vector-index/index.ts";
import { createRuntimeTestPorts } from "./infrastructure/memory-runtime/test-support.ts";

async function setup(embedding: VectorEmbeddingPort) {
  const db = createTestDatabase();
  let settings: PluginSettings = { ...DEFAULT_SETTINGS, enabled: true };
  const settingsStore: SettingsStore = {
    read: () => settings,
    write: (next) => {
      settings = next;
    },
  };
  const handlers = new Map<string, () => void>();
  const context: StContext = {
    chatId: "vector-chat",
    characterId: 1,
    groupId: null,
    name2: "向量测试",
    characters: [{ avatar: "other.png" }, { avatar: "vector.png" }],
    chat: [{}, {}],
    chatMetadata: {},
    saveMetadataDebounced: vi.fn(),
    eventSource: {
      on: (event, handler) => {
        handlers.set(event, handler);
      },
    },
    eventTypes: {
      CHAT_CHANGED: "chat_changed",
      MESSAGE_SENT: "message_sent",
      MESSAGE_RECEIVED: "message_received",
    },
  };
  const ports = createRuntimeTestPorts(() => context);
  const runtime = await startSteMemory(() => context, {
    createDb: () => db,
    createLogDb: () => createTestLogDatabase(),
    ...ports,
    settingsStore,
    embedding,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const status = runtime.manager.getStatus();
  if (status?.kind !== "active") throw new Error("测试空间未激活");
  const spaceId = status.space.id;
  const table = await runtime.tables.create(spaceId, {
    key: "vector_test",
    name: "向量测试表",
    description: "",
    prompt: "",
    position: 100,
  });
  if (!table) throw new Error("表格创建失败");
  const field = await runtime.fields.create(spaceId, table.id, {
    key: "content",
    name: "内容",
    type: "short_text",
    required: true,
    prompt: "",
    enabled: true,
    position: 0,
  });
  if (!field) throw new Error("字段创建失败");
  await runtime.fields.setDisplayStrategy(spaceId, table.id, { type: "field", fieldId: field.id });
  return { runtime, db, spaceId, tableId: table.id, fieldId: field.id, context, handlers, ports };
}

async function waitFor(assertion: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw lastError;
}

describe("runtime 向量索引接线", () => {
  it("自动更新在保存记录后通过真实 Dexie 建向量，删除记录后清理派生数据", async () => {
    const inputs: string[] = [];
    const { runtime, db, spaceId, tableId, fieldId } = await setup({
      getProfile: () => ({ model: "test", version: "v1", dimensions: 2, maxInputChars: 100 }),
      embed: async (input) => {
        inputs.push(input);
        return [1, 2];
      },
    });
    await runtime.tables.update(spaceId, tableId, {
      vectorIndex: {
        enabled: true,
        source: "automatic",
        updateMode: "automatic",
        groups: [],
      },
    });
    const record = await runtime.records.create(spaceId, tableId, {
      payload: { [fieldId]: "星港" },
    });
    if (!record) throw new Error("记录创建失败");
    await waitFor(async () => {
      expect(await db.recordVectors.where("memorySpaceId").equals(spaceId).count()).toBe(1);
    });
    expect(inputs).toContain("内容：星港");
    await runtime.records.delete(spaceId, tableId, record.id, record.revisionId, "user");
    await waitFor(async () => {
      expect(await db.recordVectors.where("memorySpaceId").equals(spaceId).count()).toBe(0);
      expect(
        await db.vectorTasks
          .where("[memorySpaceId+tableId+recordId]")
          .equals([spaceId, tableId, record.id])
          .count(),
      ).toBe(0);
    });
  });

  it("手动更新保存不请求，显式提交后生成；恢复空间清理旧向量和任务", async () => {
    const inputs: string[] = [];
    const { runtime, db, spaceId, tableId, fieldId } = await setup({
      getProfile: () => ({ model: "test", version: "v1", dimensions: 2, maxInputChars: 100 }),
      embed: async (input) => {
        inputs.push(input);
        return [1, 2];
      },
    });
    await runtime.tables.update(spaceId, tableId, {
      vectorIndex: {
        enabled: true,
        source: "automatic",
        updateMode: "manual",
        groups: [],
      },
    });
    const record = await runtime.records.create(spaceId, tableId, {
      payload: { [fieldId]: "手动内容" },
    });
    if (!record) throw new Error("记录创建失败");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(inputs).toEqual([]);
    expect(await db.vectorTasks.where("memorySpaceId").equals(spaceId).count()).toBe(0);
    expect(
      (
        await runtime.vector.submit(
          { memorySpaceId: spaceId, tableId, recordId: record.id },
          { source: "manual" },
        )
      ).created,
    ).toBe(1);
    await waitFor(async () => {
      expect(await db.recordVectors.where("memorySpaceId").equals(spaceId).count()).toBe(1);
    });
    expect(inputs).toEqual(["内容：手动内容"]);
    const unit = (await runtime.backup.loadSnapshot()).spaces.find(
      (item) => item.space.id === spaceId,
    )!;
    await runtime.backup.restoreSpace(unit);
    await waitFor(async () => {
      expect(await db.recordVectors.where("memorySpaceId").equals(spaceId).count()).toBe(0);
      expect(await db.vectorTasks.where("memorySpaceId").equals(spaceId).count()).toBe(0);
    });
  });

  it("关闭插件后中断在途任务，迟到响应不写入索引", async () => {
    let resolveEmbedding!: (value: readonly number[]) => void;
    let calls = 0;
    const { runtime, db, spaceId, tableId, fieldId } = await setup({
      getProfile: () => ({ model: "test", version: "v1", dimensions: 2, maxInputChars: 100 }),
      embed: async () => {
        calls++;
        return new Promise((resolve) => {
          resolveEmbedding = resolve;
        });
      },
    });
    await runtime.tables.update(spaceId, tableId, {
      vectorIndex: {
        enabled: true,
        source: "automatic",
        updateMode: "automatic",
        groups: [],
      },
    });
    await runtime.records.create(spaceId, tableId, { payload: { [fieldId]: "等待请求" } });
    await waitFor(async () => {
      expect(calls).toBe(1);
    });
    await runtime.settingsService.setPluginEnabled(false);
    expect(
      (await db.vectorTasks.where("memorySpaceId").equals(spaceId).toArray()).some(
        (task) => task.status === "interrupted",
      ),
    ).toBe(true);
    resolveEmbedding([1, 2]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await db.recordVectors.where("memorySpaceId").equals(spaceId).count()).toBe(0);
    expect(calls).toBe(1);
  });
});

describe("runtime 向量检索接线", () => {
  it("真实Dexie变更让查询过期，纯向量替换保留结果，切同空间chat代次丢弃迟到响应", async () => {
    let resolveQuery: ((value: readonly number[]) => void) | undefined;
    const ctx = await setup({
      getProfile: () => ({ model: "test", version: "v1", dimensions: 2, maxInputChars: 100 }),
      embed: async (input) =>
        input === "慢查询"
          ? new Promise((resolve) => {
              resolveQuery = resolve;
            })
          : [1, 0],
    });
    const { runtime, db, spaceId, tableId, fieldId } = ctx;
    await runtime.tables.update(spaceId, tableId, {
      vectorIndex: { enabled: true, source: "automatic", updateMode: "manual", groups: [] },
    });
    const record = await runtime.records.create(spaceId, tableId, {
      payload: { [fieldId]: "森林" },
    });
    if (!record) throw new Error("创建失败");
    await runtime.vector.submit({ memorySpaceId: spaceId, tableId }, { source: "manual" });
    await waitFor(async () => {
      expect(await db.recordVectors.count()).toBe(1);
    });
    const request = {
      query: "森林",
      selection: [
        {
          tableId,
          groupIds: (await runtime.vector.targets({ memorySpaceId: spaceId, tableId })).map(
            (target) => target.groupId,
          ),
        },
      ],
      topK: 10,
      minimumScore: null,
    };
    await runtime.retrieval.search(request);
    expect(runtime.retrieval.getState().status).toBe("done");
    const vector = (await db.recordVectors.toArray())[0]!;
    await db.recordVectors.put({ ...vector, updatedAt: "replacement" });
    expect(runtime.retrieval.getState()).toMatchObject({ status: "done", indexUpdated: true });
    await runtime.records.create(spaceId, tableId, { payload: { [fieldId]: "新记录" } });
    expect(runtime.retrieval.getState().status).toBe("stale");
    const pending = runtime.retrieval.search({ ...request, query: "慢查询" });
    await waitFor(async () => {
      expect(resolveQuery).toBeTypeOf("function");
    });
    Object.assign(ctx.context, { chatId: "same-space-other-chat" });
    runtime.adapter.bindingStore.write({ version: 1, spaceId });
    ctx.handlers.get("chat_changed")!();
    await runtime.manager.syncToCurrentChat();
    Object.assign(ctx.context, { chatId: "vector-chat" });
    runtime.adapter.bindingStore.write({ version: 1, spaceId });
    ctx.handlers.get("chat_changed")!();
    await runtime.manager.syncToCurrentChat();
    resolveQuery!([1, 0]);
    await pending;
    expect(runtime.retrieval.getState()).toMatchObject({ status: "idle", result: null });
    await runtime.retrieval.search(request);
    await db.recordVectors.delete(vector.id);
    expect(runtime.retrieval.getState().status).toBe("stale");
  });

  it("索引与查询网络并发且取消/错误独立，查询成功不解除索引鉴权阻塞", async () => {
    const pending: {
      input: string;
      resolve: (value: readonly number[]) => void;
      reject: (error: Error) => void;
    }[] = [];
    const ctx = await setup({
      getProfile: () => ({ model: "test", version: "v1", dimensions: 2, maxInputChars: 100 }),
      embed: (input) => new Promise((resolve, reject) => pending.push({ input, resolve, reject })),
    });
    const { runtime, db, spaceId, tableId, fieldId } = ctx;
    await runtime.tables.update(spaceId, tableId, {
      vectorIndex: { enabled: true, source: "automatic", updateMode: "manual", groups: [] },
    });
    const record = await runtime.records.create(spaceId, tableId, {
      payload: { [fieldId]: "森林" },
    });
    if (!record) throw new Error("创建失败");
    await runtime.vector.submit({ memorySpaceId: spaceId, tableId }, { source: "manual" });
    await waitFor(async () => {
      expect(pending).toHaveLength(1);
    });
    pending[0]!.resolve([1, 0]);
    await waitFor(async () => {
      expect(await db.recordVectors.count()).toBe(1);
    });
    const request = { query: "独立查询", selection: null, topK: 10, minimumScore: null };
    await runtime.vector.submit(
      { memorySpaceId: spaceId, tableId },
      { source: "manual", force: true },
    );
    await waitFor(async () => {
      expect(pending).toHaveLength(2);
    });
    const query = runtime.retrieval.search(request);
    await waitFor(async () => {
      expect(pending).toHaveLength(3);
    });
    expect(pending[2]!.input).toBe("独立查询");
    runtime.retrieval.cancel();
    pending[2]!.resolve([1, 0]);
    await query;
    expect((await db.vectorTasks.toArray()).some((task) => task.status === "running")).toBe(true);
    const { VectorEmbeddingRequestError } = await import("./features/vector-index/index.ts");
    pending[1]!.reject(new VectorEmbeddingRequestError("索引鉴权失败", "authentication", true));
    await waitFor(async () => {
      expect((await db.vectorTasks.toArray()).some((task) => task.status === "failed")).toBe(true);
    });
    const next = runtime.retrieval.search(request);
    await waitFor(async () => {
      expect(pending).toHaveLength(4);
    });
    pending[3]!.resolve([1, 0]);
    await next;
    expect(runtime.retrieval.getState().status).toBe("done");
    await runtime.vector.submit(
      { memorySpaceId: spaceId, tableId },
      { source: "manual", force: true },
    );
    await waitFor(async () => {
      expect(
        (await db.vectorTasks.toArray()).some(
          (task) => task.status === "queued" && !!task.waitReason,
        ),
      ).toBe(true);
    });
    expect(pending).toHaveLength(4);
  });
});

describe("预设更新的运行时接线", () => {
  it("按分组 Key 更新名称和 Prompt，保留记录及有效向量；输入变更后索引过期", async () => {
    const embed = vi.fn(async () => [1, 2]);
    const { runtime, db, spaceId, tableId, fieldId } = await setup({
      getProfile: () => ({ model: "test", version: "v1", dimensions: 2, maxInputChars: 100 }),
      embed,
    });
    await runtime.tables.update(spaceId, tableId, {
      vectorIndex: {
        enabled: true,
        source: "custom",
        updateMode: "manual",
        groups: [
          { id: "original-group", key: "basic_info", name: "基本信息", fieldIds: [fieldId] },
        ],
      },
    });
    const record = await runtime.records.create(spaceId, tableId, {
      payload: { [fieldId]: "星港" },
    });
    await runtime.vector.submit({ memorySpaceId: spaceId, tableId }, { source: "manual" });
    await waitFor(async () =>
      expect(await db.recordVectors.where("memorySpaceId").equals(spaceId).count()).toBe(1),
    );
    const originalVector = (await db.recordVectors.toArray())[0]!;
    const status = runtime.manager.getStatus();
    if (status?.kind !== "active" || status.binding.version !== 2) throw new Error("空间未就绪");
    const structure = await captureSpaceStructure(
      {
        listTables: (id) => runtime.tables.list(id),
        listFields: (id, table) => runtime.fields.list(id, table),
      },
      spaceId,
      status.space.prompt,
    );
    const preset = {
      ...structure,
      id: "updated",
      name: "更新预设",
      description: "",
      builtIn: false,
      tables: structure.tables.map((table) =>
        table.key === "vector_test"
          ? {
              ...table,
              prompt: "新的填写规则",
              vectorIndex: {
                ...table.vectorIndex!,
                groups: table.vectorIndex!.groups.map((group) => ({
                  ...group,
                  name: "人物基本信息",
                })),
              },
            }
          : table,
      ),
    };
    const plan = await runtime.presetUpdate.preview(spaceId, preset, status.binding.chatIdentity);
    expect(
      await runtime.presetUpdate.apply(
        plan,
        presetUpdateChanges(plan.nodes).map((change) => change.id),
        status.binding.chatIdentity,
      ),
    ).toEqual({ issues: [] });
    expect(await db.recordVectors.toArray()).toEqual([originalVector]);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(await runtime.records.find(spaceId, tableId, record!.id)).toMatchObject({
      revisionId: record!.revisionId,
      payload: record!.payload,
    });
    expect(
      (await runtime.tables.find(spaceId, tableId))!.vectorIndex!.presetGroups![0],
    ).toMatchObject({ id: "original-group", key: "basic_info", name: "人物基本信息" });
    const renamed = {
      ...preset,
      tables: preset.tables.map((table) =>
        table.key === "vector_test"
          ? { ...table, fields: table.fields.map((field) => ({ ...field, name: "新字段名称" })) }
          : table,
      ),
    };
    const second = await runtime.presetUpdate.preview(
      spaceId,
      renamed,
      status.binding.chatIdentity,
    );
    await runtime.presetUpdate.apply(
      second,
      presetUpdateChanges(second.nodes).map((change) => change.id),
      status.binding.chatIdentity,
    );
    expect((await runtime.vector.getTableSummary({ memorySpaceId: spaceId, tableId })).stale).toBe(
      1,
    );
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("SQLite 导入失败保留原空间；提交后保存失败单独回报，重试保留之后的修改", async () => {
    const { runtime, spaceId, tableId, fieldId, ports } = await setup({
      getProfile: () => null,
      embed: vi.fn(),
    });
    await runtime.records.create(spaceId, tableId, { payload: { [fieldId]: "现有内容" } });
    const status = runtime.manager.getStatus();
    if (status?.kind !== "active" || status.binding.version !== 2) throw new Error("空间未就绪");
    const structure = await captureSpaceStructure(
      {
        listTables: (id) => runtime.tables.list(id),
        listFields: (id, table) => runtime.fields.list(id, table),
      },
      spaceId,
      status.space.prompt,
    );
    const base = { ...structure, id: "updated", name: "更新预设", description: "", builtIn: false };
    const invalid = {
      ...base,
      tables: base.tables.map((table) =>
        table.key === "vector_test"
          ? {
              ...table,
              name: "不能部分保存的改名",
              fields: [
                ...table.fields,
                { ...table.fields[0]!, key: "new_required", name: "必填新字段" },
              ],
            }
          : table,
      ),
    };
    const failedPlan = await runtime.presetUpdate.preview(
      spaceId,
      invalid,
      status.binding.chatIdentity,
    );
    await expect(
      runtime.presetUpdate.apply(
        failedPlan,
        presetUpdateChanges(failedPlan.nodes).map((change) => change.id),
        status.binding.chatIdentity,
      ),
    ).rejects.toThrow();
    expect((await runtime.tables.find(spaceId, tableId))!.name).toBe("向量测试表");
    expect(
      (await runtime.fields.list(spaceId, tableId)).some((field) => field.key === "new_required"),
    ).toBe(false);
    const preset = {
      ...base,
      tables: base.tables.map((table) =>
        table.key === "vector_test" ? { ...table, prompt: "已提交规则" } : table,
      ),
    };
    const plan = await runtime.presetUpdate.preview(spaceId, preset, status.binding.chatIdentity);
    vi.spyOn(ports.snapshotFiles, "write").mockRejectedValueOnce(new Error("测试保存失败"));
    const outcome = await runtime.presetUpdate.apply(
      plan,
      presetUpdateChanges(plan.nodes).map((change) => change.id),
      status.binding.chatIdentity,
    );
    expect(outcome.issues.join()).toContain("对话文件保存失败");
    expect((await runtime.tables.find(spaceId, tableId))!.prompt).toBe("已提交规则");
    await runtime.tables.update(spaceId, tableId, { prompt: "后续编辑" });
    expect(await runtime.presetUpdate.retrySave(spaceId, status.binding.chatIdentity)).toEqual({
      issues: [],
    });
    expect((await runtime.tables.find(spaceId, tableId))!.prompt).toBe("后续编辑");
  });
});

it("废弃旧召回后删除分组不再被旧绑定阻止，并清理向量", async () => {
  const { runtime, db, spaceId, tableId, fieldId } = await setup({
    getProfile: () => ({ model: "test", version: "v1", dimensions: 2, maxInputChars: 100 }),
    embed: async () => [1, 2],
  });
  await runtime.tables.update(spaceId, tableId, {
    vectorIndex: {
      enabled: true,
      source: "custom",
      updateMode: "manual",
      groups: [{ id: "bound-group", key: "basic", name: "基本信息", fieldIds: [fieldId] }],
    },
  });
  await runtime.records.create(spaceId, tableId, { payload: { [fieldId]: "星港" } });
  await runtime.vector.submit({ memorySpaceId: spaceId, tableId }, { source: "manual" });
  await waitFor(async () =>
    expect(await db.recordVectors.where("memorySpaceId").equals(spaceId).count()).toBe(1),
  );
  const status = runtime.manager.getStatus();
  if (status?.kind !== "active" || status.binding.version !== 2) throw new Error("空间未就绪");
  const structure = await captureSpaceStructure(
    {
      listTables: (id) => runtime.tables.list(id),
      listFields: (id, table) => runtime.fields.list(id, table),
    },
    spaceId,
    status.space.prompt,
  );
  const preset = {
    ...structure,
    id: "delete-group",
    name: "移除分组",
    description: "",
    builtIn: false,
    tables: structure.tables.map((table) =>
      table.key === "vector_test"
        ? { ...table, vectorIndex: { enabled: false, updateMode: "manual" as const, groups: [] } }
        : table,
    ),
  };
  const plan = await runtime.presetUpdate.preview(spaceId, preset, status.binding.chatIdentity);
  const selected = presetUpdateChanges(plan.nodes).map((change) => change.id);
  expect(await runtime.presetUpdate.apply(plan, selected, status.binding.chatIdentity)).toEqual({
    issues: [],
  });
  expect(await db.recordVectors.where("memorySpaceId").equals(spaceId).count()).toBe(0);
  expect((await runtime.tables.find(spaceId, tableId))!.vectorIndex!.presetGroups).toEqual([]);
});
