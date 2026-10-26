import { afterEach, expect, it, vi } from "vitest";
import type { MemorySpaceBackup } from "../backup/backup-file.ts";
import type { RecordVector, VectorEmbeddingPort } from "../vector-index/index.ts";
import { createInProcessSqliteMemoryClient } from "../../infrastructure/sqlite/node-client.ts";
import type { SqliteMemoryClient } from "../../infrastructure/sqlite/types.ts";
import { createMacroEvaluationBatch, type MacroEvaluationBatch } from "./macro-evaluation.ts";

const stamp = "2026-10-24T00:00:00.000Z";
function fixture(count = 120): MemorySpaceBackup {
  return {
    space: {
      id: "s",
      name: "空间",
      initializationSource: null,
      createdAt: stamp,
      updatedAt: stamp,
    },
    tables: [
      {
        id: "t",
        memorySpaceId: "s",
        key: "facts",
        name: "记忆",
        enabled: true,
        description: "",
        prompt: "",
        position: 0,
        displayStrategy: null,
        createdAt: stamp,
        updatedAt: stamp,
        vectorIndex: {
          enabled: true,
          source: "custom",
          updateMode: "manual",
          groups: [
            { key: "facts", id: "g", name: "事实", fieldIds: ["f"] },
            { key: "extra", id: "g2", name: "更多", fieldIds: ["f"] },
          ],
        },
      },
    ],
    fields: [
      {
        id: "f",
        memorySpaceId: "s",
        tableId: "t",
        key: "content",
        name: "内容",
        type: "short_text",
        required: false,
        enabled: true,
        position: 0,
        prompt: "",
        options: [],
        referenceTableId: null,
        maxChars: null,
        valuePattern: null,
        valuePatternMessage: null,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    records: Array.from({ length: count }, (_, i) => ({
      id: `r${i}`,
      memorySpaceId: "s",
      tableId: "t",
      payload: { f: `内容${i}` },
      displayText: `显示${i}`,
      fieldEvidence: {},
      source: { type: "manual" },
      revisionId: `v${i}`,
      revisionSource: "user",
      createdAt: stamp,
      updatedAt: stamp,
    })),
    history: [],
    evidence: [],
  } as unknown as MemorySpaceBackup;
}
const clients: SqliteMemoryClient[] = [];
const batches: MacroEvaluationBatch[] = [];
afterEach(async () => {
  for (const batch of batches.splice(0)) await batch.close();
  for (const client of clients.splice(0)) await client.close();
});
async function setup(
  snapshot = fixture(),
  indexed = true,
  configured = true,
  maxInputChars = 4000,
) {
  const sql = await createInProcessSqliteMemoryClient();
  clients.push(sql);
  const vectors = indexed
    ? snapshot.records.flatMap((record, i) =>
        ["g", "g2"].map((groupId): RecordVector => ({
          id: `${record.id}${groupId}`,
          memorySpaceId: record.memorySpaceId,
          tableId: record.tableId,
          recordId: record.id,
          groupId,
          fingerprint: JSON.stringify([["f"], `内容：${record.payload.f}`, "model", "v1"]),
          model: "model",
          version: "v1",
          values: i === 119 && groupId === "g2" ? [1, 0] : [0, 1],
          updatedAt: stamp,
        })),
      )
    : [];
  const embedding: VectorEmbeddingPort = {
    getProfile: () =>
      configured ? { model: "model", version: "v1", dimensions: 2, maxInputChars } : null,
    embed: vi.fn(async () => [1, 0]),
  };
  const controller = new AbortController();
  const batch = await createMacroEvaluationBatch({
    sql,
    vectors: { listVectors: async () => vectors },
    embedding,
    snapshot,
    lastUserMessage: "本轮问题",
    signal: controller.signal,
    deadline: performance.now() + 10000,
  });
  batches.push(batch);
  return { batch, embedding, vectors, controller, sql };
}
it("scores every record and group before Query filtering, and shares embedding with SQL sources", async () => {
  const { batch, embedding } = await setup();
  const query = await batch.evaluate({
    language: "query",
    query: {
      table: "facts",
      semantic: { groups: ["facts", "extra"], query: { context: "last_user_message" } },
      fields: ["content", "$similarity"],
      conditions: [{ field: "$similarity", op: "greater_than", value: 0.9 }],
      orderBy: { field: "$similarity", direction: "desc" },
      limit: 1,
    },
  });
  expect(query.rows).toEqual([["内容119", 1]]);
  expect(query.sources[0]!.coverage.ready).toBe(240);
  const sql = await batch.evaluate({
    language: "sql",
    sources: [{ name: "scores", table: "facts", groups: ["extra"], query: { text: "本轮问题" } }],
    sql: 'SELECT f.content,s.score FROM facts f JOIN scores s ON s.record_id=f."$record_id" WHERE s.score>0.9 LIMIT 1',
  });
  expect(sql.rows).toEqual(query.rows);
  expect(embedding.embed).toHaveBeenCalledTimes(1);
  const reused = await batch.evaluate({
    language: "sql",
    sources: [
      {
        name: "same_scores",
        table: "facts",
        groups: ["facts", "extra"],
        query: { context: "last_user_message" },
      },
    ],
    sql: "SELECT count(*) FROM same_scores",
  });
  expect(reused.sources[0]!.calls).toBe(0);
  expect(embedding.embed).toHaveBeenCalledTimes(1);
  const plain = await batch.evaluate({ language: "query", query: { table: "facts" } });
  expect(plain.rows).toHaveLength(120);
});
it("provides empty relations without embedding and distinguishes missing profile from stale vectors", async () => {
  const empty = await setup(fixture(2), false, false);
  const expression = {
    language: "sql" as const,
    sources: [{ name: "scores", table: "facts", groups: ["facts"], query: { text: "问题" } }],
    sql: 'SELECT f.content,s.score FROM facts f LEFT JOIN scores s ON s.record_id=f."$record_id" ORDER BY f.content',
  };
  expect((await empty.batch.evaluate(expression)).rows).toEqual([
    ["内容0", null],
    ["内容1", null],
  ]);
  expect(empty.embedding.embed).not.toHaveBeenCalled();
  const missing = await setup(fixture(2), true, false);
  await expect(missing.batch.evaluate(expression)).rejects.toThrow("已有存储向量");
  const stale = await setup(fixture(2));
  stale.vectors.forEach((vector) => Object.assign(vector, { fingerprint: "newer snapshot" }));
  const result = await stale.batch.evaluate(expression);
  expect(result.sources[0]!.coverage.stale).toBe(2);
  expect(stale.embedding.embed).not.toHaveBeenCalled();
});
it("only requires the connection query limit when stored vectors need its profile", async () => {
  const expression = {
    language: "sql" as const,
    sources: [{ name: "scores", table: "facts", groups: ["facts"], query: { text: "问题" } }],
    sql: "SELECT count(*) AS total FROM scores",
  };
  const empty = await setup(fixture(2), false, true, 1);
  expect((await empty.batch.evaluate(expression)).rows).toEqual([[0]]);
  expect(empty.embedding.embed).not.toHaveBeenCalled();
  const stored = await setup(fixture(2), true, true, 1);
  await expect(stored.batch.evaluate(expression)).rejects.toThrow("输入限制");
  expect(stored.embedding.embed).not.toHaveBeenCalled();
});
it("rejects invalid Query operators and source collisions before requesting embedding", async () => {
  const { batch, embedding } = await setup();
  await expect(
    batch.evaluate({
      language: "query",
      query: { table: "facts", conditions: [{ field: "content", op: "greater_than", value: "x" }] },
    }),
  ).rejects.toThrow();
  await expect(
    batch.evaluate({
      language: "sql",
      sources: [{ name: "facts", table: "facts", groups: ["facts"], query: { text: "问题" } }],
      sql: "SELECT 1",
    }),
  ).rejects.toThrow("冲突");
  expect(embedding.embed).not.toHaveBeenCalled();
});
it("yields to cancellation while preparing a full scoring source", async () => {
  const { batch, controller } = await setup(fixture(1000));
  const work = batch.evaluate({
    language: "query",
    query: { table: "facts", semantic: { groups: ["facts"], query: { text: "问题" } } },
  });
  setTimeout(() => controller.abort(), 0);
  await expect(work).rejects.toMatchObject({ name: "AbortError" });
});
it("validates SQL and semantic metadata without vector reads, stepping SQL or embedding", async () => {
  const { batch, embedding } = await setup(fixture(0), false, false);
  await batch.validate({
    language: "sql",
    sources: [
      {
        name: "scores",
        table: "facts",
        groups: ["facts"],
        query: { context: "last_user_message" },
      },
    ],
    sql: "WITH RECURSIVE n(v) AS(VALUES(1) UNION ALL SELECT v+1 FROM n) SELECT sum(v) FROM n",
  });
  await batch.validate({
    language: "query",
    query: {
      table: "facts",
      semantic: { groups: ["facts"], query: { context: "last_user_message" } },
      conditions: [{ field: "$similarity", op: "greater_than", value: 0.5 }],
    },
  });
  await expect(
    batch.validate({
      language: "sql",
      sources: [{ name: "scores", table: "facts", groups: ["gone"], query: { text: "" } }],
      sql: "SELECT 1",
    }),
  ).rejects.toThrow("分组");
  await expect(
    batch.validate({ language: "sql", sql: "SELECT * FROM __entities" }),
  ).rejects.toThrow();
  await expect(batch.validate({ language: "sql", sql: "SELECT :unknown" })).rejects.toThrow(
    "参数未声明",
  );
  expect(embedding.embed).not.toHaveBeenCalled();
});
it("closes a batch once when embedding ignores cancellation and never settles", async () => {
  const { batch, embedding, controller, sql } = await setup(fixture(1));
  const close = vi.spyOn(sql, "closeEvaluation");
  const execute = vi.spyOn(sql, "evaluateMacro");
  let entered!: () => void;
  const embeddingStarted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.mocked(embedding.embed).mockImplementation(() => {
    entered();
    return new Promise(() => {});
  });
  void batch.evaluate({
    language: "query",
    query: { table: "facts", semantic: { groups: ["facts"], query: { text: "问题" } } },
  });
  await embeddingStarted;
  controller.abort();
  const firstClose = batch.close();
  expect(batch.close()).toBe(firstClose);
  await firstClose;
  expect(close).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
  await expect(batch.evaluate({ language: "sql", sql: "SELECT 1" })).rejects.toMatchObject({
    name: "AbortError",
  });
});
it("does not execute SQL after a late embedding settles on an aborted batch", async () => {
  const { batch, embedding, controller, sql } = await setup(fixture(1));
  const close = vi.spyOn(sql, "closeEvaluation");
  const execute = vi.spyOn(sql, "evaluateMacro");
  let entered!: () => void;
  let finish!: (value: readonly number[]) => void;
  const embeddingStarted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.mocked(embedding.embed).mockImplementation(() => {
    entered();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const work = batch.evaluate({
    language: "query",
    query: { table: "facts", semantic: { groups: ["facts"], query: { text: "问题" } } },
  });
  await embeddingStarted;
  controller.abort();
  await batch.close();
  finish([1, 0]);
  await expect(work).rejects.toMatchObject({ name: "AbortError" });
  await batch.close();
  expect(close).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
});
it("owns cleanup before asynchronous session opening finishes during cancellation", async () => {
  const controller = new AbortController();
  let opened!: (id: string) => void;
  let entered!: () => void;
  const openingStarted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const sql = {
    openEvaluation: vi.fn(() => {
      entered();
      return new Promise<string>((resolve) => {
        opened = resolve;
      });
    }),
    closeEvaluation: vi.fn(async () => {}),
    evaluateMacro: vi.fn(async () => ({ columns: [], rows: [] })),
  };
  const creating = createMacroEvaluationBatch({
    sql,
    snapshot: fixture(0),
    vectors: { listVectors: async () => [] },
    embedding: { getProfile: () => null, embed: async () => [] },
    lastUserMessage: null,
    signal: controller.signal,
    deadline: performance.now() + 10000,
  });
  await openingStarted;
  controller.abort();
  expect(sql.closeEvaluation).not.toHaveBeenCalled();
  opened("late-session");
  await expect(creating).rejects.toMatchObject({ name: "AbortError" });
  expect(sql.closeEvaluation).toHaveBeenCalledExactlyOnceWith("late-session");
  expect(sql.evaluateMacro).not.toHaveBeenCalled();
});
it("shares a failed close promise and exposes its error without retrying the RPC", async () => {
  const { batch, sql } = await setup(fixture(0));
  const error = new Error("close RPC failed");
  const close = vi.spyOn(sql, "closeEvaluation").mockRejectedValueOnce(error);
  const closing = batch.close();
  expect(batch.close()).toBe(closing);
  await expect(closing).rejects.toBe(error);
  await expect(batch.close()).rejects.toBe(error);
  expect(close).toHaveBeenCalledOnce();
  batches.splice(batches.indexOf(batch), 1);
});
