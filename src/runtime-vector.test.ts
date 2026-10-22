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

async function setup(embedding: VectorEmbeddingPort) {
  const db = createTestDatabase();
  let settings: PluginSettings = { ...DEFAULT_SETTINGS, enabled: true };
  const settingsStore: SettingsStore = {
    read: () => settings,
    write: (next) => {
      settings = next;
    },
  };
  const context: StContext = {
    chatId: "vector-chat",
    characterId: 1,
    groupId: null,
    name2: "向量测试",
    chat: [{}, {}],
    chatMetadata: {},
    saveMetadataDebounced: vi.fn(),
    eventSource: { on: () => undefined },
    eventTypes: {
      CHAT_CHANGED: "chat_changed",
      MESSAGE_SENT: "message_sent",
      MESSAGE_RECEIVED: "message_received",
    },
  };
  const runtime = await startSteMemory(() => context, {
    createDb: () => db,
    createLogDb: () => createTestLogDatabase(),
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
  return { runtime, db, spaceId, tableId: table.id, fieldId: field.id };
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
