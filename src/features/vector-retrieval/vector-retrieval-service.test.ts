import { describe, expect, it, vi } from "vitest";
import type {
  MemoryField,
  MemoryFieldRepository,
  MemoryRecord,
  MemoryRecordRepository,
  MemorySpaceId,
  MemoryTable,
  MemoryTableRepository,
} from "../memory/index.ts";
import { VectorIndexService } from "../vector-index/vector-index-service.ts";
import {
  VectorEmbeddingRequestError,
  type RecordVector,
  type VectorEmbeddingPort,
  type VectorEmbeddingProfile,
  type VectorIndexRepository,
} from "../vector-index/index.ts";
import { VectorRetrievalService, type RetrievalRequest } from "./vector-retrieval-service.ts";

const space = "space" as MemorySpaceId;
const request: RetrievalRequest = { query: "问题", selection: null, topK: 10, minimumScore: null };
function setup() {
  const table = {
    id: "table",
    key: "table",
    name: "表",
    memorySpaceId: space,
    enabled: true,
    position: 0,
    displayStrategy: null,
    vectorIndex: {
      enabled: true,
      source: "custom",
      updateMode: "manual",
      groups: [
        { id: "a", name: "背景", fieldIds: ["f"] },
        { id: "b", name: "近况", fieldIds: ["f"] },
      ],
    },
  } as unknown as MemoryTable;
  const field = { id: "f", name: "内容", enabled: true, type: "short_text" } as MemoryField;
  const records = ["r2", "r1", "r3"].map(
    (id) =>
      ({
        id,
        memorySpaceId: space,
        tableId: table.id,
        displayText: "同名",
        payload: { f: id },
      }) as unknown as MemoryRecord,
  );
  let profile: VectorEmbeddingProfile | null = {
    model: "model",
    version: "v1",
    maxInputChars: 100,
    dimensions: 2,
  };
  const embedding: VectorEmbeddingPort = {
    getProfile: () => profile,
    embed: vi.fn(async () => [1, 0]),
  };
  const vectors: RecordVector[] = [];
  const repository = {
    listVectors: vi.fn(async () => vectors),
    listTasks: vi.fn(async () => []),
    saveTask: vi.fn(),
    saveVector: vi.fn(),
  } as unknown as VectorIndexRepository;
  const tables = {
    list: async () => [table],
    find: async () => table,
  } as unknown as MemoryTableRepository;
  const fields = { list: async () => [field] } as unknown as MemoryFieldRepository;
  const recordRepo = {
    list: async () => records,
    find: async (_space: string, _table: string, id: string) =>
      records.find((record) => record.id === id),
  } as unknown as MemoryRecordRepository;
  const index = new VectorIndexService(
    tables,
    fields,
    recordRepo,
    embedding,
    repository,
    () => space,
  );
  let context = "chat-a:0";
  const service = new VectorRetrievalService(
    tables,
    fields,
    index,
    repository,
    embedding,
    () => context,
  );
  service.setContext(context, space);
  async function populate() {
    for (const target of await index.targets({ memorySpaceId: space }))
      vectors.push({
        id: [space, table.id, target.record.id, target.groupId].join("\u0000"),
        memorySpaceId: space,
        tableId: table.id,
        recordId: target.record.id,
        groupId: target.groupId,
        fingerprint: target.fingerprint,
        values: target.record.id === "r3" ? [0, 1] : target.groupId === "a" ? [2, 0] : [1, 1],
        model: "model",
        version: "v1",
        updatedAt: "now",
      });
  }
  return {
    service,
    embedding,
    index,
    vectors,
    records,
    table,
    field,
    repository,
    populate,
    setProfile: (next: VectorEmbeddingProfile | null) => {
      profile = next;
    },
    setContext: (next: string) => {
      context = next;
      service.setContext(next, space);
    },
  };
}

it("filtered record/group unions keep view pairing and deduplicate overlap before ranking and coverage", async () => {
  const ctx = setup();
  await ctx.populate();
  await ctx.service.search({
    ...request,
    selection: [
      { tableId: ctx.table.id, groupIds: ["b"], recordIds: ["r1"] },
      { tableId: ctx.table.id, groupIds: ["a"], recordIds: ["r3"] },
      { tableId: ctx.table.id, groupIds: ["b"], recordIds: ["r1"] },
    ],
  });
  const result = ctx.service.getState().result!;
  expect(result.coverage.records).toBe(2);
  expect(result.coverage.expected).toBe(2);
  expect(result.coverage.ready).toBe(2);
  expect(result.hits.map((hit) => [hit.target.record.id, hit.target.groupId])).toEqual([
    ["r1", "b"],
    ["r3", "a"],
  ]);
  expect(result.hits[0]!.score).toBeCloseTo(Math.SQRT1_2);
  expect(ctx.embedding.embed).toHaveBeenCalledTimes(1);
});

it("empty filtered candidates avoid embedding and retain an explicit filter message", async () => {
  const ctx = setup();
  await ctx.populate();
  await ctx.service.search({
    ...request,
    selection: [{ tableId: ctx.table.id, groupIds: ["a"], recordIds: [] }],
  });
  expect(ctx.embedding.embed).not.toHaveBeenCalled();
  expect(ctx.service.getState().result?.message).toBe("没有符合筛选条件的记录");
  expect(ctx.service.getState().result?.coverage.expected).toBe(0);
});

async function embeddingStarted(ctx: ReturnType<typeof setup>): Promise<void> {
  await vi.waitFor(() => expect(ctx.service.getState().status).toBe("embedding"));
}

describe("向量检索", () => {
  it("按记录max去重、稳定平分、阈值含边界，完整读取超过一页候选", async () => {
    const ctx = setup();
    for (let n = 0; n < 120; n++)
      ctx.records.push({ ...ctx.records[0]!, id: `extra-${n}` as MemoryRecord["id"] });
    await ctx.populate();
    await ctx.service.search({ ...request, topK: 2, minimumScore: 1 });
    const result = ctx.service.getState().result!;
    expect(result.coverage.ready).toBe(246);
    expect(result.hits).toHaveLength(2);
    expect(new Set(result.hits.map((hit) => hit.target.record.id)).size).toBe(2);
    expect(result.hits[0]?.target.record.id).toBe("extra-0");
    expect(result.hits[0]?.groups).toHaveLength(2);
    expect(result.hits[0]?.target.groupId).toBe("a");
    expect(result.calls).toBe(1);
    expect(ctx.embedding.embed).toHaveBeenCalledTimes(1);
    expect(ctx.repository.saveTask).not.toHaveBeenCalled();
    expect(ctx.repository.saveVector).not.toHaveBeenCalled();
  });

  it("选择表/组后仅对应目标参与，空选择与失效组不扩大范围", async () => {
    const ctx = setup();
    await ctx.populate();
    await ctx.service.search({
      ...request,
      selection: [{ tableId: ctx.table.id, groupIds: ["b"] }],
    });
    expect(ctx.service.getState().result?.coverage.expected).toBe(3);
    expect(ctx.service.getState().result?.hits[0]?.groups).toHaveLength(1);
    await ctx.service.search({ ...request, selection: [] });
    expect(ctx.service.getState().status).toBe("error");
    await ctx.service.search({
      ...request,
      selection: [{ tableId: ctx.table.id, groupIds: ["removed"] }],
    });
    expect(ctx.service.getState().error).toContain("分组已删除");
    expect(ctx.embedding.embed).toHaveBeenCalledTimes(1);
  });

  it("无索引零请求，部分可用显示缺失/过期/坏向量，不隐式补建", async () => {
    const ctx = setup();
    await ctx.service.search(request);
    expect(ctx.service.getState().result?.coverage.missing).toBe(6);
    expect(ctx.embedding.embed).not.toHaveBeenCalled();
    await ctx.populate();
    ctx.vectors.pop();
    ctx.vectors[0] = { ...ctx.vectors[0]!, version: "other-profile" };
    ctx.vectors[1] = { ...ctx.vectors[1]!, values: [0, 0] };
    await ctx.service.search(request);
    expect(ctx.service.getState().result?.coverage).toMatchObject({
      ready: 3,
      stale: 1,
      missing: 1,
      invalid: 1,
    });
    expect(ctx.service.getState().result?.message).toContain("可能遗漏");
    expect(ctx.repository.saveTask).not.toHaveBeenCalled();
    ctx.records[1] = { ...ctx.records[1]!, payload: { f: "已修改正文" } };
    await ctx.service.search(request);
    expect(ctx.service.getState().result?.coverage.stale).toBe(3);
  });

  it("未指定维度时按查询响应排除异维度；全部异常与无相关结果区分", async () => {
    const ctx = setup();
    await ctx.populate();
    ctx.setProfile({ model: "model", version: "v1", maxInputChars: 100 });
    ctx.vectors.splice(
      0,
      ctx.vectors.length,
      ...ctx.vectors.map((vector) => ({ ...vector, values: [1, 0, 0] })),
    );
    await ctx.service.search(request);
    expect(ctx.service.getState().result).toMatchObject({
      hits: [],
      calls: 1,
      message: "索引不兼容／异常",
    });
    expect(ctx.service.getState().result?.coverage).toMatchObject({ ready: 0, invalid: 6 });
    vi.mocked(ctx.embedding.embed).mockResolvedValue([0, 0]);
    await ctx.service.search(request);
    expect(ctx.service.getState().error).toContain("查询向量");
  });

  it("查询输入不改写，长度/参数非法零请求，已结束同文本重新请求", async () => {
    const ctx = setup();
    await ctx.populate();
    await ctx.service.search({ ...request, query: "x".repeat(101) });
    await ctx.service.search({ ...request, topK: 0 });
    await ctx.service.search({ ...request, minimumScore: Number.NaN });
    expect(ctx.embedding.embed).not.toHaveBeenCalled();
    await ctx.service.search({ ...request, query: "  A\nB  " });
    await ctx.service.search({ ...request, query: "  A\nB  " });
    expect(ctx.embedding.embed).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ctx.embedding.embed).mock.calls[0]?.[0]).toBe("A\nB");
  });

  it("重复提交去重、替换和取消阻止忽略AbortSignal的迟到响应", async () => {
    const ctx = setup();
    await ctx.populate();
    const pending: ((values: number[]) => void)[] = [];
    vi.mocked(ctx.embedding.embed).mockImplementation(
      async () => new Promise((resolve) => pending.push(resolve)),
    );
    const first = ctx.service.search(request);
    await embeddingStarted(ctx);
    await ctx.service.search(request);
    expect(ctx.embedding.embed).toHaveBeenCalledTimes(1);
    const second = ctx.service.search({ ...request, query: "替换" });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[0]!([1, 0]);
    await first;
    expect(ctx.service.getState().status).toBe("embedding");
    ctx.service.cancel();
    pending[1]!([1, 0]);
    await second;
    expect(ctx.service.getState()).toMatchObject({ status: "cancelled", result: null });
  });

  it("真实chat代次隔离同空间切走切回；正文失效，新增索引保留快照", async () => {
    const ctx = setup();
    await ctx.populate();
    let resolve!: (values: number[]) => void;
    vi.mocked(ctx.embedding.embed).mockImplementation(
      async () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const old = ctx.service.search(request);
    await embeddingStarted(ctx);
    ctx.setContext("chat-b:1");
    ctx.setContext("chat-a:2");
    resolve([1, 0]);
    await old;
    expect(ctx.service.getState()).toMatchObject({ status: "idle", result: null });
    const current = ctx.service.search(request);
    await embeddingStarted(ctx);
    ctx.service.indexChanged({ memorySpaceId: space, tableId: ctx.table.id }, false);
    resolve([1, 0]);
    await current;
    expect(ctx.service.getState()).toMatchObject({ status: "done", indexUpdated: true });
    const snapshot = ctx.service.getState().result;
    ctx.service.invalidate("other-space" as MemorySpaceId);
    expect(ctx.service.getState().status).toBe("done");
    ctx.service.invalidate(space);
    expect(ctx.service.getState()).toMatchObject({ status: "stale", result: snapshot });
  });

  it("索引删除使活动搜索失效，密钥/超时相同profile保留、模型更换失效", async () => {
    const ctx = setup();
    await ctx.populate();
    let resolve!: (values: number[]) => void;
    vi.mocked(ctx.embedding.embed).mockImplementation(
      async () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const search = ctx.service.search(request);
    await embeddingStarted(ctx);
    ctx.service.profileChanged();
    expect(ctx.service.getState().status).toBe("embedding");
    ctx.service.indexChanged({ memorySpaceId: space, tableId: ctx.table.id }, true);
    resolve([1, 0]);
    await search;
    expect(ctx.service.getState().status).toBe("stale");
    vi.mocked(ctx.embedding.embed).mockResolvedValue([1, 0]);
    await ctx.service.search(request);
    ctx.setProfile({ model: "new", version: "v2", maxInputChars: 100, dimensions: 2 });
    ctx.service.profileChanged();
    expect(ctx.service.getState().status).toBe("stale");
  });

  it("查询鉴权错误只影响查询，显式再次提交可成功", async () => {
    const ctx = setup();
    await ctx.populate();
    vi.mocked(ctx.embedding.embed).mockRejectedValueOnce(
      new VectorEmbeddingRequestError("鉴权失败", "authentication", true),
    );
    await ctx.service.search(request);
    expect(ctx.service.getState()).toMatchObject({ status: "error", result: null });
    await ctx.service.search(request);
    expect(ctx.service.getState().status).toBe("done");
    expect(ctx.embedding.embed).toHaveBeenCalledTimes(2);
  });
});

it("大表共享输入计算分批让出，checking期间取消可中止且零查询请求", async () => {
  const ctx = setup();
  let payloadReads = 0;
  for (let n = 0; n < 5000; n++)
    ctx.records.push({
      ...ctx.records[0]!,
      id: `bulk-${n}` as MemoryRecord["id"],
      get payload() {
        payloadReads++;
        return { f: "测试内容" };
      },
    });
  const running = ctx.service.search(request);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(ctx.service.getState().status).toBe("checking");
  ctx.service.cancel();
  await running;
  expect(ctx.service.getState().status).toBe("cancelled");
  expect(payloadReads).toBeLessThan(5000);
  expect(ctx.embedding.embed).not.toHaveBeenCalled();
});
