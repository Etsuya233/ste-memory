import { describe, expect, it } from "vitest";
import type {
  MemoryField,
  MemoryFieldRepository,
  MemoryRecord,
  MemoryRecordRepository,
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
  MemoryTableRepository,
} from "../memory/index.ts";
import { VectorIndexService } from "./vector-index-service.ts";
import {
  VectorEmbeddingRequestError,
  type RecordVector,
  type VectorEmbeddingPort,
  type VectorIndexRepository,
  type VectorScope,
  type VectorSuppression,
  type VectorTask,
} from "./types.ts";

const current = "current" as MemorySpaceId;
const background = "background" as MemorySpaceId;

function fixture() {
  const tables = new Map<string, MemoryTable>();
  const records = new Map<string, MemoryRecord>();
  const fields = new Map<string, MemoryField[]>();
  const tasks = new Map<string, VectorTask>();
  const vectors = new Map<string, RecordVector>();
  const suppressions = new Map<string, VectorSuppression>();
  const requests: {
    input: string;
    resolve: (value: number[]) => void;
    reject: (error: Error) => void;
  }[] = [];
  let currentSpace = current;
  function add(
    spaceId: MemorySpaceId,
    suffix: string,
    updateMode: "manual" | "automatic" = "automatic",
  ) {
    const tableId = `table-${suffix}` as MemoryTableId;
    const recordId = `record-${suffix}` as MemoryRecord["id"];
    const table = {
      id: tableId,
      memorySpaceId: spaceId,
      vectorIndex: {
        enabled: true,
        source: "custom",
        updateMode,
        groups: [{ key: "group", id: "group", name: "内容", fieldIds: [`field-${suffix}`] }],
      },
    } as unknown as MemoryTable;
    const record = {
      id: recordId,
      memorySpaceId: spaceId,
      tableId,
      payload: { [`field-${suffix}`]: suffix, [`other-${suffix}`]: "unchanged" },
      displayText: suffix,
    } as unknown as MemoryRecord;
    tables.set(tableId, table);
    records.set(recordId, record);
    fields.set(tableId, [
      { id: `field-${suffix}`, name: "内容", enabled: true, position: 0, type: "short_text" },
      { id: `other-${suffix}`, name: "无关", enabled: true, position: 1, type: "short_text" },
    ] as MemoryField[]);
    return {
      table,
      record,
      scope: { memorySpaceId: spaceId, tableId, recordId } as Required<VectorScope>,
    };
  }
  const inScope = (
    item: { memorySpaceId: MemorySpaceId; tableId?: MemoryTableId; recordId?: MemoryRecord["id"] },
    scope: VectorScope,
  ) =>
    item.memorySpaceId === scope.memorySpaceId &&
    (!scope.tableId || item.tableId === scope.tableId) &&
    (!scope.recordId || item.recordId === scope.recordId);
  const repository: VectorIndexRepository = {
    saveTask: async (task) => {
      tasks.set(task.id, task);
    },
    getTask: async (id) => tasks.get(id),
    listTasks: async () => [...tasks.values()],
    deleteTasks: async (scope) => {
      for (const [id, task] of tasks) if (inScope(task, scope)) tasks.delete(id);
    },
    saveVector: async (vector) => {
      vectors.set(vector.id, vector);
    },
    getVector: async (id) => vectors.get(id),
    listVectors: async (scope) => [...vectors.values()].filter((vector) => inScope(vector, scope)),
    deleteVector: async (id) => {
      vectors.delete(id);
    },
    deleteVectors: async (scope) => {
      for (const [id, vector] of vectors) if (inScope(vector, scope)) vectors.delete(id);
    },
    saveSuppression: async (suppression) => {
      suppressions.set(suppression.id, suppression);
    },
    getSuppression: async (id) => suppressions.get(id),
    deleteSuppression: async (id) => {
      suppressions.delete(id);
    },
    deleteSuppressions: async (scope) => {
      for (const [id, suppression] of suppressions)
        if (suppression.memorySpaceId === scope.memorySpaceId) suppressions.delete(id);
    },
    listSuppressions: async () => [...suppressions.values()],
  };
  const embedding: VectorEmbeddingPort = {
    getProfile: () => ({ model: "test", version: "v1", maxInputChars: 1000, dimensions: 2 }),
    embed: (input) =>
      new Promise((resolve, reject) => {
        requests.push({ input, resolve, reject });
      }),
  };
  const fieldRepository = {
    list: async (_space, tableId) => fields.get(tableId)!,
  } as MemoryFieldRepository;
  function service() {
    return new VectorIndexService(
      {
        find: async (_space, id) => tables.get(id),
        list: async (spaceId) =>
          [...tables.values()].filter((table) => table.memorySpaceId === spaceId),
      } as MemoryTableRepository,
      fieldRepository,
      {
        find: async (_space, _table, id) => records.get(id),
        list: async (_space, tableId) =>
          [...records.values()].filter((record) => record.tableId === tableId),
      } as MemoryRecordRepository,
      embedding,
      repository,
      () => currentSpace,
    );
  }
  return {
    add,
    service,
    tasks,
    vectors,
    suppressions,
    requests,
    records,
    tables,
    fieldRepository,
    setCurrent: (id: MemorySpaceId) => {
      currentSpace = id;
    },
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("向量任务生命周期与调度", () => {
  it.each(["cancel", "stop", "purge"] as const)(
    "目标检查期间 %s 不会复活排队任务",
    async (action) => {
      const ctx = fixture();
      const blocker = ctx.add(background, "blocker");
      const item = ctx.add(current, "target");
      const service = ctx.service();
      await service.submit(blocker.scope, { source: "manual" });
      await flush();
      await service.submit(item.scope, { source: "manual" });
      const task = [...ctx.tasks.values()].find((row) => row.recordId === item.record.id)!;
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const checking = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const list = ctx.fieldRepository.list.bind(ctx.fieldRepository);
      ctx.fieldRepository.list = async (spaceId, tableId) => {
        if (tableId === item.table.id) {
          entered();
          await gate;
        }
        return list(spaceId, tableId);
      };
      ctx.requests[0]!.resolve([1, 2]);
      await checking;
      if (action === "cancel") await service.cancel(task.id);
      else await service[action](item.scope);
      release();
      await flush();
      expect(ctx.requests).toHaveLength(1);
      expect(ctx.tasks.get(task.id)?.status).toBe(
        action === "cancel" ? "cancelled" : action === "stop" ? "interrupted" : undefined,
      );
    },
  );

  it("失败的强制重算重试保留 force，旧缓存不会跳过请求", async () => {
    const ctx = fixture();
    const item = ctx.add(current, "target");
    const service = ctx.service();
    await service.submit(item.scope, { source: "manual" });
    await flush();
    ctx.requests[0]!.resolve([1, 2]);
    await flush();
    await service.submit(item.scope, { source: "manual", force: true });
    await flush();
    ctx.requests[1]!.reject(new Error("临时失败"));
    await flush();
    const failed = [...ctx.tasks.values()].find((task) => task.status === "failed")!;
    expect(ctx.vectors.size).toBe(1);
    expect((await service.retry(failed.id)).created).toBe(1);
    await flush();
    expect(ctx.requests).toHaveLength(3);
    expect([...ctx.tasks.values()].find((task) => task.status === "running")?.force).toBe(true);
  });

  it.each(["cancelled", "failed"] as const)("等价分组替换身份后保留 %s 抑制", async (reason) => {
    const ctx = fixture();
    const item = ctx.add(current, "target");
    const service = ctx.service();
    await service.submit(item.scope, { source: "automatic" });
    await flush();
    if (reason === "cancelled") {
      await service.cancel([...ctx.tasks.values()][0]!.id);
      ctx.requests[0]!.resolve([1, 2]);
    } else ctx.requests[0]!.reject(new Error("临时失败"));
    await flush();
    ctx.tables.set(item.table.id, {
      ...item.table,
      vectorIndex: {
        ...item.table.vectorIndex!,
        source: "preset",
        presetGroups: [{ ...item.table.vectorIndex!.groups[0]!, id: "preset-group", name: "改名" }],
      },
    });
    expect((await service.reconcile(item.scope)).created).toBe(0);
    await flush();
    expect(ctx.requests).toHaveLength(1);
    expect(
      [...ctx.suppressions.values()].some((row) => row.id.includes("\u0000preset-group\u0000")),
    ).toBe(true);
    expect(ctx.suppressions.size).toBe(1);
    expect((await service.submit(item.scope, { source: "manual" })).created).toBe(1);
    await flush();
    ctx.requests[1]!.resolve([1, 2]);
    await flush();
    expect(ctx.suppressions.size).toBe(0);
    expect((await service.reconcile(item.scope)).created).toBe(0);
    expect(ctx.suppressions.size).toBe(0);
  });

  it("仍存在的已取消分组不抑制另一份相同字段的独立分组", async () => {
    const ctx = fixture();
    const item = ctx.add(current, "target");
    const service = ctx.service();
    await service.submit(item.scope, { source: "automatic" });
    await flush();
    await service.cancel([...ctx.tasks.values()][0]!.id);
    ctx.requests[0]!.resolve([1, 2]);
    await flush();
    ctx.tables.set(item.table.id, {
      ...item.table,
      vectorIndex: {
        ...item.table.vectorIndex!,
        groups: [
          ...item.table.vectorIndex!.groups,
          { ...item.table.vectorIndex!.groups[0]!, id: "independent", name: "独立分组" },
        ],
      },
    });
    expect((await service.reconcile(item.scope)).created).toBe(1);
    await flush();
    expect(ctx.requests).toHaveLength(2);
    expect([...ctx.tasks.values()].find((task) => task.status === "running")?.groupId).toBe(
      "independent",
    );
  });
  it("手动任务跨空间优先，同来源优先当前空间，执行完当前请求后重新排序", async () => {
    const ctx = fixture();
    const blocker = ctx.add(background, "blocker");
    const backgroundAuto = ctx.add(background, "background-auto");
    const currentAuto = ctx.add(current, "current-auto");
    const backgroundManual = ctx.add(background, "background-manual", "manual");
    const currentManual = ctx.add(current, "current-manual", "manual");
    const service = ctx.service();
    await service.submit(blocker.scope, { source: "automatic" });
    await flush();
    expect(ctx.requests.map((request) => request.input)).toEqual(["内容：blocker"]);
    await service.submit(backgroundAuto.scope, { source: "automatic" });
    await service.submit(currentAuto.scope, { source: "automatic" });
    await service.submit(backgroundManual.scope, { source: "manual" });
    await service.submit(currentManual.scope, { source: "manual" });
    for (const expected of [
      "内容：current-manual",
      "内容：background-manual",
      "内容：current-auto",
      "内容：background-auto",
    ]) {
      ctx.requests.at(-1)!.resolve([1, 2]);
      await flush();
      expect(ctx.requests.at(-1)?.input).toBe(expected);
    }
    ctx.requests.at(-1)!.resolve([1, 2]);
    await flush();
    expect([...ctx.tasks.values()].every((task) => task.status === "succeeded")).toBe(true);
  });

  it("取消抑制跨服务重启保留，显式手动提交解除；clear 后自动核对不立刻重建", async () => {
    const ctx = fixture();
    const item = ctx.add(current, "one");
    const service = ctx.service();
    await service.submit(item.scope, { source: "automatic" });
    await flush();
    const task = [...ctx.tasks.values()][0]!;
    await service.cancel(task.id);
    ctx.requests[0]!.resolve([1, 2]);
    await flush();
    const restarted = ctx.service();
    expect((await restarted.reconcile(item.scope)).created).toBe(0);
    expect(ctx.vectors.size).toBe(0);
    expect((await restarted.submit(item.scope, { source: "manual" })).created).toBe(1);
    await flush();
    ctx.requests.at(-1)!.resolve([1, 2]);
    await flush();
    await restarted.clear(item.scope);
    expect(ctx.vectors.size).toBe(0);
    expect((await restarted.reconcile(item.scope)).created).toBe(0);
    expect(ctx.suppressions.size).toBe(1);
  });

  it("排队目标变化作废旧项，无关字段变化不触发重算", async () => {
    const ctx = fixture();
    const blocker = ctx.add(background, "blocker");
    const item = ctx.add(current, "target");
    const service = ctx.service();
    await service.submit(blocker.scope, { source: "manual" });
    await flush();
    await service.submit(item.scope, { source: "automatic" });
    const original = [...ctx.tasks.values()].find((task) => task.recordId === item.record.id)!;
    ctx.records.set(item.record.id, {
      ...item.record,
      payload: { ...item.record.payload, [`other-target`]: "changed" },
    });
    expect((await service.reconcile(item.scope)).created).toBe(0);
    expect(ctx.tasks.get(original.id)?.status).toBe("queued");
    ctx.records.set(item.record.id, {
      ...item.record,
      payload: { ...item.record.payload, [`field-target`]: "new" },
    });
    expect((await service.reconcile(item.scope)).created).toBe(1);
    expect(ctx.tasks.get(original.id)?.status).toBe("obsolete");
    ctx.requests[0]!.resolve([1, 2]);
    await flush();
    expect(ctx.requests.at(-1)?.input).toBe("内容：new");
  });

  it("鉴权全局阻塞保留剩余排队项，自动核对不重复建失败目标", async () => {
    const ctx = fixture();
    const first = ctx.add(current, "first");
    const second = ctx.add(current, "second");
    const service = ctx.service();
    await service.submit(first.scope, { source: "automatic" });
    await flush();
    await service.submit(second.scope, { source: "automatic" });
    ctx.requests[0]!.reject(new VectorEmbeddingRequestError("认证失败", "authentication", true));
    await flush();
    expect(ctx.requests).toHaveLength(1);
    expect([...ctx.tasks.values()].map((task) => task.status).sort()).toEqual(["failed", "queued"]);
    await service.reconcile(first.scope);
    await service.reconcile(second.scope);
    expect(ctx.requests).toHaveLength(1);
    expect([...ctx.tasks.values()].filter((task) => task.status === "queued")).toHaveLength(1);
    expect((await service.getStatus(second.scope)).connection).toBe("blocked");
  });
});
