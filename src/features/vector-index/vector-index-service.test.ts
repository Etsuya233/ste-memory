import { describe, expect, it } from "vitest";
import type {
  MemoryField,
  MemoryFieldRepository,
  MemoryRecord,
  MemoryRecordRepository,
  MemorySpaceId,
  MemoryTable,
  MemoryTableRepository,
} from "../memory/index.ts";
import { VectorIndexService } from "./vector-index-service.ts";
import type {
  RecordVector,
  VectorEmbeddingPort,
  VectorIndexRepository,
  VectorScope,
  VectorSuppression,
  VectorTask,
} from "./types.ts";

const space = "space" as MemorySpaceId;
const table = {
  id: "table",
  memorySpaceId: space,
  vectorIndex: {
    enabled: true,
    source: "custom",
    updateMode: "automatic",
    groups: [{ id: "group", name: "组合", fieldIds: ["field"] }],
  },
} as unknown as MemoryTable;
const field = { id: "field", name: "数量", enabled: true, type: "integer" } as MemoryField;
let record = {
  id: "record",
  memorySpaceId: space,
  tableId: table.id,
  payload: { field: 0 },
  displayText: "记录",
} as unknown as MemoryRecord;
const scope: VectorScope = { memorySpaceId: space, tableId: table.id, recordId: record.id };

function setup(createTaskId?: () => string) {
  record = { ...record, payload: { field: 0 } };
  const tasks = new Map<string, VectorTask>();
  const vectors = new Map<string, RecordVector>();
  const suppressions = new Map<string, VectorSuppression>();
  const repository: VectorIndexRepository = {
    saveTask: async (item) => {
      tasks.set(item.id, item);
    },
    getTask: async (id) => tasks.get(id),
    listTasks: async () => [...tasks.values()],
    deleteTasks: async () => {
      tasks.clear();
    },
    saveVector: async (item) => {
      vectors.set(item.id, item);
    },
    getVector: async (id) => vectors.get(id),
    deleteVector: async (id) => {
      vectors.delete(id);
    },
    listVectors: async () => [...vectors.values()],
    deleteVectors: async () => {
      vectors.clear();
    },
    saveSuppression: async (item) => {
      suppressions.set(item.id, item);
    },
    getSuppression: async (id) => suppressions.get(id),
    deleteSuppression: async (id) => {
      suppressions.delete(id);
    },
    deleteSuppressions: async () => {
      suppressions.clear();
    },
    listSuppressions: async () => [...suppressions.values()],
  };
  const pending: Array<{ resolve: (value: number[]) => void }> = [];
  const embedding: VectorEmbeddingPort = {
    getProfile: () => ({ model: "test", version: "v1", maxInputChars: 100, dimensions: 2 }),
    embed: () =>
      new Promise((resolve) => {
        pending.push({ resolve });
      }),
  };
  const service = new VectorIndexService(
    { find: async () => table, list: async () => [table] } as unknown as MemoryTableRepository,
    { list: async () => [field] } as unknown as MemoryFieldRepository,
    { find: async () => record, list: async () => [record] } as unknown as MemoryRecordRepository,
    embedding,
    repository,
    () => space,
    () => true,
    createTaskId,
  );
  return { service, repository, tasks, vectors, suppressions, pending, embedding };
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("VectorIndexService", () => {
  it("连接缺失时仍可识别空输入并清理该组旧向量", async () => {
    const ctx = setup();
    await ctx.service.submit(scope, { source: "manual" });
    await tick();
    ctx.pending[0]!.resolve([1, 2]);
    await tick();
    expect(ctx.vectors.size).toBe(1);
    record = { ...record, payload: {} };
    ctx.embedding.getProfile = () => null;
    const preview = await ctx.service.preview(scope as Required<VectorScope>);
    expect(preview[0]?.status).toBe("empty");
    await ctx.service.reconcile(scope);
    expect(ctx.vectors.size).toBe(0);
    expect(ctx.pending).toHaveLength(1);
  });

  it("草稿统计整表目标，区分可复用与待生成且不提交任务", async () => {
    const ctx = setup();
    const config = {
      ...table.vectorIndex!,
      enabled: false,
      groups: [
        ...table.vectorIndex!.groups,
        { id: "invalid", name: "失效", fieldIds: ["missing" as MemoryField["id"]] },
      ],
    };
    const tableScope = { memorySpaceId: space, tableId: table.id };
    expect(await ctx.service.previewDraftSummary(tableScope, config)).toEqual({
      records: 1,
      vectors: 2,
      ready: 0,
      pending: 1,
      empty: 0,
      invalid: 1,
      tooLong: 0,
      unavailable: 0,
    });
    expect(ctx.tasks.size).toBe(0);
    expect(ctx.pending).toHaveLength(0);
    await ctx.service.submit(scope, { source: "manual" });
    await tick();
    ctx.pending[0]!.resolve([1, 2]);
    await tick();
    const summary = await ctx.service.previewDraftSummary(tableScope, config);
    expect(summary.ready).toBe(1);
    expect(summary.pending).toBe(0);
  });

  it("任务身份由宿主注入的工厂生成", async () => {
    const ctx = setup(() => "host-task-1");
    await ctx.service.submit(scope, { source: "manual" });
    expect(ctx.tasks.has("host-task-1")).toBe(true);
  });
  it("保留 0 输入、去重并将自动任务提升为手动", async () => {
    const ctx = setup();
    const preview = await ctx.service.preview(scope as Required<VectorScope>);
    expect(preview[0]?.input).toBe("数量：0");
    await ctx.service.submit(scope, { source: "automatic" });
    const second = await ctx.service.submit(scope, { source: "manual" });
    expect(second.created).toBe(0);
    expect(second.promoted + second.reused).toBe(1);
    expect(ctx.tasks.size).toBe(1);
    await tick();
    ctx.pending[0]?.resolve([1, 2]);
    await tick();
    expect(ctx.vectors.size).toBe(1);
  });

  it("运行中强制提交仅增加一个后继，取消旧请求不接收迟到结果", async () => {
    const ctx = setup();
    await ctx.service.submit(scope, { source: "manual" });
    await tick();
    await ctx.service.submit(scope, { source: "manual", force: true });
    await ctx.service.submit(scope, { source: "manual", force: true });
    expect(ctx.tasks.size).toBe(2);
    const running = [...ctx.tasks.values()].find((task) => task.status === "running")!;
    await ctx.service.cancel(running.id);
    ctx.pending[0]?.resolve([1, 2]);
    await tick();
    expect(ctx.vectors.size).toBe(0);
  });

  it("重试解除同目标取消抑制", async () => {
    const ctx = setup();
    await ctx.service.submit(scope, { source: "manual" });
    await tick();
    const task = [...ctx.tasks.values()][0]!;
    await ctx.service.cancel(task.id);
    expect((await ctx.service.reconcile(scope)).created).toBe(0);
    expect((await ctx.service.retry(task.id)).created).toBe(1);
  });

  it("目标输入变化后丢弃在途旧响应并为新目标建任务", async () => {
    const ctx = setup();
    await ctx.service.submit(scope, { source: "automatic" });
    await tick();
    record = { ...record, payload: { field: 7 } };
    await ctx.service.reconcile(scope);
    ctx.pending[0]?.resolve([1, 2]);
    await tick();
    expect(ctx.vectors.size).toBe(0);
    expect([...ctx.tasks.values()].some((task) => task.status === "obsolete")).toBe(true);
    expect([...ctx.tasks.values()].some((task) => task.input === "数量：7")).toBe(true);
  });

  it("同页并发提交同一目标只登记一次", async () => {
    const ctx = setup();
    const results = await Promise.all([
      ctx.service.submit(scope, { source: "automatic" }),
      ctx.service.submit(scope, { source: "manual" }),
    ]);
    expect(results.reduce((sum, result) => sum + result.created, 0)).toBe(1);
    expect(ctx.tasks.size).toBe(1);
  });

  it("队列空快照期间提交的新任务仍会唤醒请求", async () => {
    const ctx = setup();
    await ctx.service.start();
    const originalList = ctx.repository.listTasks;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first = true;
    ctx.repository.listTasks = async () => {
      if (!first) return originalList();
      first = false;
      const empty = await originalList();
      entered();
      await gate;
      return empty;
    };
    ctx.service.resumeConnection();
    await enteredGate;
    expect((await ctx.service.submit(scope, { source: "manual" })).created).toBe(1);
    release();
    await tick();
    expect(ctx.pending).toHaveLength(1);
  });

  it("批量汇总以记录为单位计数", async () => {
    const ctx = setup();
    expect(await ctx.service.getTableSummary({ memorySpaceId: space, tableId: table.id })).toEqual({
      records: 1,
      ready: 0,
      stale: 1,
      errors: 0,
      empty: 0,
      queued: 0,
    });
    await ctx.service.submit(scope, { source: "manual" });
    await tick();
    ctx.pending[0]?.resolve([1, 2]);
    await tick();
    expect(
      (await ctx.service.getTableSummary({ memorySpaceId: space, tableId: table.id })).ready,
    ).toBe(1);
    const prior = [...ctx.tasks.values()][0]!;
    ctx.tasks.set("failed-force", {
      ...prior,
      id: "failed-force",
      force: true,
      status: "failed",
      error: "远端失败",
    });
    expect(
      (await ctx.service.getTableSummary({ memorySpaceId: space, tableId: table.id })).ready,
    ).toBe(1);
  });

  it("关闭索引的草稿仍可预览输入且不建任务", async () => {
    const ctx = setup();
    const configuration = { ...table.vectorIndex!, enabled: false };
    const preview = await ctx.service.previewDraft(scope as Required<VectorScope>, configuration);
    expect(preview[0]?.input).toBe("数量：0");
    expect(ctx.tasks.size).toBe(0);
  });
});
