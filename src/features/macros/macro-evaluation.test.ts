import type { RerankPort } from "../semantic-query/rerank.ts";
import type { RerankSettings } from "../settings/rerank-settings.ts";
import { MemoryMacroService, type MemoryMacroExecutionContext } from "./memory-macro-service.ts";
import type { MemoryMacro } from "./macro-expression.ts";
import { createQuerySqlTool } from "../agent/tools/query/query-sql-tool.ts";
import type { SemanticQueryRequest } from "../semantic-query/semantic-query-session.ts";
import { createSemanticQuerySession } from "../semantic-query/semantic-query-session.ts";
import { createSemanticQueryExecutor } from "../semantic-query/semantic-query-service.ts";
import { afterEach, expect, it, vi } from "vitest";
import type { MemorySpaceBackup } from "../backup/backup-file.ts";
import type { RecordVector, VectorEmbeddingPort } from "../vector-index/index.ts";
import { createInProcessSqliteMemoryClient } from "../../infrastructure/sqlite/node-client.ts";
import type { SqliteMemoryClient } from "../../infrastructure/sqlite/types.ts";
import { createMacroEvaluationBatch, type MacroEvaluationBatch } from "./macro-evaluation.ts";
import { QueryVectorCache } from "../semantic-query/query-vector-cache.ts";

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
  cache = new QueryVectorCache(),
  rerank?: { port: RerankPort; settings: RerankSettings },
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
  const revision = cache.revisionFor(embedding.getProfile());
  const vectorRepository = { listVectors: vi.fn(async () => vectors) };
  const queryVectors = cache.createExecution({
    embedding,
    revision,
    signal: controller.signal,
    isCurrent: () => true,
  });
  const onCleanupError = vi.fn<(error: unknown) => void>();
  const batch = await createMacroEvaluationBatch({
    sql,
    vectors: vectorRepository,
    embedding,
    rerank: rerank?.port,
    rerankSettings: rerank?.settings,
    queryVectors,
    snapshot,
    lastUserMessage: "本轮问题",
    signal: controller.signal,
    deadline: performance.now() + 10000,
    onCleanupError,
  });
  batches.push(batch);
  const query = createSemanticQueryExecutor({
    snapshot: async () => snapshot,
    createSession: (snapshot, context) =>
      createSemanticQuerySession({
        sql,
        snapshot,
        ...context,
        vectors: vectorRepository,
        embedding,
        rerank: rerank?.port,
        rerankSettings: rerank?.settings,
        queryVectors: cache.createExecution({
          embedding,
          revision,
          signal: context.signal,
          isCurrent: () => true,
        }),
      }),
    onCleanupError,
  });
  return {
    query,
    snapshot,
    batch,
    embedding,
    vectors,
    controller,
    sql,
    vectorRepository,
    queryVectors,
    onCleanupError,
  };
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
  const work = batch.evaluate({
    language: "query",
    query: { table: "facts", semantic: { groups: ["facts"], query: { text: "问题" } } },
  });
  await embeddingStarted;
  controller.abort();
  await expect(work).rejects.toMatchObject({ name: "AbortError" });
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
  const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await batch.close();
  finish([1, 0]);
  await rejected;
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
    evaluateSemanticSql: vi.fn(async () => ({
      status: "complete" as const,
      columns: [],
      rows: [],
      usesSemantic: false,
      elapsedMs: 0,
    })),
  };
  const embedding = { getProfile: () => null, embed: async () => [] };
  const cache = new QueryVectorCache();
  const revision = cache.revisionFor(null);
  const creating = createMacroEvaluationBatch({
    sql,
    snapshot: fixture(0),
    vectors: { listVectors: async () => [] },
    embedding,
    queryVectors: cache.createExecution({
      embedding,
      revision,
      signal: controller.signal,
      isCurrent: () => true,
    }),
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
it("observes an abort-triggered cleanup failure while retaining the same rejected close promise", async () => {
  const { batch, sql, controller, onCleanupError } = await setup(fixture(0));
  const error = new Error("abort cleanup failed");
  const close = vi.spyOn(sql, "closeEvaluation").mockRejectedValueOnce(error);
  controller.abort();
  const closing = batch.close();
  expect(batch.close()).toBe(closing);
  await expect(closing).rejects.toBe(error);
  await vi.waitFor(() => expect(onCleanupError).toHaveBeenCalledExactlyOnceWith(error));
  await expect(batch.close()).rejects.toBe(error);
  expect(close).toHaveBeenCalledOnce();
  batches.splice(batches.indexOf(batch), 1);
});
it("shares complete multi-group scoring between Query and inline SQL, retaining the winning group", async () => {
  const { batch, embedding } = await setup();
  const query = await batch.evaluate({
    language: "query",
    query: {
      table: "facts",
      semantic: { groups: ["facts", "extra"], query: { context: "last_user_message" } },
      fields: ["content", "$similarity"],
      orderBy: { field: "$similarity", direction: "desc" },
      limit: 1,
    },
  });
  const inline = await batch.evaluate({
    language: "sql",
    sql: `SELECT f.content,s.score,s.group_key FROM facts f JOIN semantic_scores('facts',json_array('extra','facts'),:last_user_message) s ON s.record_id=f."$record_id" ORDER BY s.score DESC LIMIT 1`,
  });
  expect(query.rows).toEqual([["内容119", 1]]);
  expect(inline.rows).toEqual([["内容119", 1, "extra"]]);
  expect(inline.sources[0]!.coverage.ready).toBe(240);
  expect(inline.execution?.sqlPasses).toBe(2);
  expect(embedding.embed).toHaveBeenCalledOnce();
});
it("reuses L2 across batches while rechecking changed records and vectors for the new snapshot", async () => {
  const cache = new QueryVectorCache();
  const expression = {
    language: "sql" as const,
    sql: `SELECT f.content,s.score FROM facts f JOIN semantic_scores('facts','["facts"]','same question') s ON s.record_id=f."$record_id" ORDER BY s.score DESC`,
  };
  const first = await setup(fixture(2), true, true, 4000, cache);
  Object.assign(
    first.vectors.find((vector) => vector.recordId === "r0" && vector.groupId === "g")!,
    { values: [1, 0] },
  );
  expect((await first.batch.evaluate(expression)).rows).toEqual([
    ["内容0", 1],
    ["内容1", 0],
  ]);
  await first.batch.close();
  const nextSnapshot = fixture(2);
  Object.assign(nextSnapshot.records[0]!, { payload: { f: "修改后" }, displayText: "修改后" });
  const second = await setup(nextSnapshot, true, true, 4000, cache);
  Object.assign(
    second.vectors.find((vector) => vector.recordId === "r1" && vector.groupId === "g")!,
    { values: [1, 0] },
  );
  const result = await second.batch.evaluate(expression);
  expect(result.rows).toEqual([
    ["内容1", 1],
    ["修改后", 0],
  ]);
  expect(result.sources[0]!.sharedHits).toBe(1);
  expect(second.embedding.embed).not.toHaveBeenCalled();
  expect(first.embedding.embed).toHaveBeenCalledOnce();
  expect(second.vectorRepository.listVectors).toHaveBeenCalledOnce();
});
it("prepares true empty inline sources without a connection for LEFT JOIN and COUNT", async () => {
  const { batch, embedding, vectorRepository } = await setup(fixture(2), false, false);
  const from = `semantic_scores('facts','["facts"]','question')`;
  expect(await batch.validate({ language: "sql", sql: `SELECT count(*) FROM ${from}` })).toBe(true);
  expect(embedding.embed).not.toHaveBeenCalled();
  expect(
    (
      await batch.evaluate({
        language: "sql",
        sql: `SELECT f.content,s.score FROM facts f LEFT JOIN ${from} s ON s.record_id=f."$record_id" ORDER BY f.content`,
      })
    ).rows,
  ).toEqual([
    ["内容0", null],
    ["内容1", null],
  ]);
  expect(
    (await batch.evaluate({ language: "sql", sql: `SELECT count(*) AS total FROM ${from}` })).rows,
  ).toEqual([[0]]);
  expect(vectorRepository.listVectors).toHaveBeenCalledOnce();
  expect(embedding.embed).not.toHaveBeenCalled();
});
it("publishes only the final complete UNION result after a source miss", async () => {
  const { batch, embedding } = await setup(fixture(2));
  const result = await batch.evaluate({
    language: "sql",
    sql: `SELECT 'prefix' AS record_id,0 AS score UNION ALL SELECT record_id,score FROM semantic_scores('facts','["facts"]','question')`,
  });
  expect(result.rows).toEqual([
    ["prefix", 0],
    ["r0", 0],
    ["r1", 0],
  ]);
  expect(result.execution?.sqlPasses).toBe(2);
  expect(embedding.embed).toHaveBeenCalledOnce();
});
it("rejects the fifth dynamic text before issuing its embedding request", async () => {
  const { batch, embedding, queryVectors, sql } = await setup(fixture(5));
  const get = vi.spyOn(queryVectors, "get");
  const execute = vi.spyOn(sql, "evaluateSemanticSql");
  await expect(
    batch.evaluate({
      language: "sql",
      sql: `SELECT s.record_id FROM facts f CROSS JOIN semantic_scores('facts','["facts"]',f.content) s`,
    }),
  ).rejects.toThrow("查询文本超过 4");
  expect(get).toHaveBeenCalledTimes(4);
  expect(embedding.embed).toHaveBeenCalledTimes(4);
  expect(execute).toHaveBeenCalledTimes(5);
});
it("rejects the seventeenth distinct source before preparing it, even with one shared query vector", async () => {
  const snapshot = fixture(1);
  const groups = Array.from({ length: 17 }, (_, i) => ({
    id: `gid${i}`,
    key: `group${i}`,
    name: `组${i}`,
    fieldIds: [snapshot.fields[0]!.id],
  }));
  Object.assign(snapshot.tables[0]!, {
    vectorIndex: { enabled: true, source: "custom", updateMode: "manual", groups },
  });
  const { batch, embedding, vectors, queryVectors, sql } = await setup(snapshot);
  const base = vectors[0]!;
  vectors.splice(
    0,
    vectors.length,
    ...groups.map((group) => ({ ...base, id: group.id, groupId: group.id, values: [1, 0] })),
  );
  const get = vi.spyOn(queryVectors, "get");
  const execute = vi.spyOn(sql, "evaluateSemanticSql");
  const groupJson = JSON.stringify(groups.map((group) => group.key));
  await expect(
    batch.evaluate({
      language: "sql",
      sql: `SELECT s.score FROM json_each('${groupJson}') selected CROSS JOIN semantic_scores('facts',json_array(selected.value),'question') s`,
    }),
  ).rejects.toThrow("评分源超过 16");
  expect(execute).toHaveBeenCalledTimes(17);
  expect(get).toHaveBeenCalledTimes(16);
  expect(embedding.embed).toHaveBeenCalledOnce();
});
it("deducts elapsed SQL time across preparation passes instead of resetting the budget", async () => {
  const { batch, sql, embedding } = await setup(fixture(1));
  const execute = sql.evaluateSemanticSql.bind(sql);
  const budgets: (number | undefined)[] = [];
  const spy = vi.spyOn(sql, "evaluateSemanticSql").mockImplementation(async (input) => {
    budgets.push(input.budgetMs);
    const result = await execute(input);
    return { ...result, elapsedMs: 600 };
  });
  await expect(
    batch.evaluate({
      language: "sql",
      sql: `SELECT * FROM semantic_scores('facts','["facts"]','question')`,
    }),
  ).rejects.toThrow("累计执行超过 1 秒");
  expect(budgets).toEqual([1000, 400]);
  expect(spy).toHaveBeenCalledTimes(2);
  expect(embedding.embed).toHaveBeenCalledOnce();
});
it("stops after a real SQL error without another preparation or API retry", async () => {
  const { batch, sql, embedding } = await setup(fixture(1));
  const execute = vi.spyOn(sql, "evaluateSemanticSql");
  await expect(
    batch.evaluate({
      language: "sql",
      sql: `SELECT json_extract('invalid','$') FROM semantic_scores('facts','["facts"]','question')`,
    }),
  ).rejects.toThrow("JSON");
  expect(execute).toHaveBeenCalledTimes(2);
  expect(embedding.embed).toHaveBeenCalledOnce();
});
it("clones each table's vector list once so later SQL rounds cannot mix new vector data", async () => {
  const { batch, sql, vectors, vectorRepository } = await setup(fixture(1));
  const execute = sql.evaluateSemanticSql.bind(sql);
  vi.spyOn(sql, "evaluateSemanticSql").mockImplementation(async (input) => {
    const result = await execute(input);
    if (result.status === "needs-semantic-source" && input.sources.length === 1)
      Object.assign(
        vectors.find((vector) => vector.groupId === "g2")!,
        { fingerprint: "new record version", values: [1, 0] },
      );
    return result;
  });
  const result = await batch.evaluate({
    language: "sql",
    sql: `SELECT a.score AS a,b.score AS b FROM semantic_scores('facts','["facts"]','question') a CROSS JOIN semantic_scores('facts','["extra"]','question') b`,
  });
  expect(result.rows).toEqual([[0, 0]]);
  expect(result.sources.map((source) => [source.coverage.ready, source.coverage.stale])).toEqual([
    [1, 0],
    [1, 0],
  ]);
  expect(result.execution?.sqlPasses).toBe(3);
  expect(vectorRepository.listVectors).toHaveBeenCalledOnce();
});

it("shares successful query vectors between macros and standalone semantic SQL while refreshing record scores", async () => {
  const { batch, query, embedding, snapshot } = await setup(fixture(2));
  await batch.evaluate({
    language: "sql",
    sql: `SELECT * FROM semantic_scores('facts','["facts"]',:last_user_message)`,
  });
  const request = {
    sql: `SELECT f.content,s.score FROM facts f JOIN semantic_scores('facts',json_array('facts'),:query) s ON s.record_id=f."$record_id"`,
    params: { query: "本轮问题" },
  };
  const first = await query(snapshot.space.id, request);
  expect(first.rows).toHaveLength(2);
  expect(first.diagnostics.queryVectors).toEqual({ requests: 0, executionHits: 0, sharedHits: 1 });
  expect(embedding.embed).toHaveBeenCalledTimes(1);
  Object.assign(snapshot.records[0]!.payload, { f: "已修改" });
  const second = await query(snapshot.space.id, request);
  expect(second.rows).toHaveLength(1);
  expect(second.sources[0]!.coverage).toMatchObject({ stale: 1, ready: 1 });
  expect(embedding.embed).toHaveBeenCalledTimes(1);
});

it("standalone semantic SQL rejects invalid bindings and writes before requesting embeddings", async () => {
  const { query, snapshot, embedding } = await setup(fixture(1));
  const invalidRequests: SemanticQueryRequest[] = [
    { sql: "DELETE FROM facts" },
    { sql: "SELECT 1; SELECT 2" },
    { sql: "PRAGMA table_info(facts)" },
    { sql: "SELECT :missing" },
    { sql: "SELECT 1", params: { unused: 1 } },
    { sql: "SELECT ?", params: { query: "text" } },
    { sql: "SELECT @query", params: { query: "text" } },
    { sql: "SELECT :query", params: { query: Infinity } },
  ];
  for (const request of invalidRequests)
    await expect(query(snapshot.space.id, request)).rejects.toThrow();
  expect(embedding.embed).not.toHaveBeenCalled();
  expect(
    (await query(snapshot.space.id, { sql: "SELECT :name AS value", params: { name: "星港'；" } }))
      .rows,
  ).toEqual([["星港'；"]]);
});

it("standalone caller limits probe truncation without truncating the semantic score source", async () => {
  const { query, snapshot } = await setup(fixture(120));
  const result = await query(snapshot.space.id, {
    sql: `SELECT * FROM semantic_scores('facts','["facts"]', 'text')`,
    maxRows: 100,
  });
  expect(result.rows).toHaveLength(100);
  expect(result.truncated).toBe(true);
  expect(result.sources[0]!.rows).toHaveLength(120);
  const exact = await query(snapshot.space.id, { sql: "SELECT 1", maxRows: 1 });
  expect(exact.rows).toEqual([[1]]);
  expect(exact.truncated).toBe(false);
});

it("standalone semantic SQL cancellation closes its session and does not cache late vectors", async () => {
  const { query, snapshot, embedding, sql } = await setup(fixture(1));
  const close = vi.spyOn(sql, "closeEvaluation");
  let resolveVector!: (values: number[]) => void;
  let started!: () => void;
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.mocked(embedding.embed).mockImplementationOnce(() => {
    started();
    return new Promise((resolve) => {
      resolveVector = resolve;
    });
  });
  const controller = new AbortController();
  const request = { sql: `SELECT * FROM semantic_scores('facts','["facts"]','cancel-text')` };
  const pending = query(snapshot.space.id, { ...request, signal: controller.signal });
  const failed = expect(pending).rejects.toThrow();
  await start;
  controller.abort();
  await failed;
  expect(close).toHaveBeenCalledTimes(1);
  resolveVector([1, 0]);
  await query(snapshot.space.id, request);
  expect(embedding.embed).toHaveBeenCalledTimes(2);
});

it("query_sql uses one shared executor for ordinary and semantic SQL with unchanged named-row results", async () => {
  const { query, snapshot, embedding } = await setup(fixture(120));
  const tool = createQuerySqlTool({
    query,
    digest: { memorySpaceId: snapshot.space.id, tables: [] },
    semanticDescription: "semantic_scores",
  });
  const ordinary = await tool.execute("plain", {
    sql: "SELECT content FROM facts ORDER BY content LIMIT 1",
  });
  expect(ordinary.details.rows).toEqual([{ content: "内容0" }]);
  expect(embedding.embed).not.toHaveBeenCalled();
  const semantic = await tool.execute("semantic", {
    sql: `SELECT record_id,score FROM semantic_scores('facts',json_array('facts'),'线索') ORDER BY record_id`,
  });
  expect(semantic.details.rows).toHaveLength(100);
  expect(semantic.details.rows[0]).toEqual({ record_id: "r0", score: 0 });
  expect(semantic.details.truncated).toBe(true);
  expect(semantic.details.sources![0]!.coverage.ready).toBe(120);
  expect(embedding.embed).toHaveBeenCalledTimes(1);
  await expect(tool.execute("write", { sql: "DELETE FROM facts" })).rejects.toThrow();
});

const rerankSettings: RerankSettings = {
  enabled: true,
  candidateLimit: 2,
  connection: {
    endpoint: "https://rerank.invalid/v1/rerank",
    apiKey: "",
    model: "test",
    maxInputChars: 8000,
    timeoutSeconds: 5,
  },
};

it("large ordinary and rerank-disabled Query macros avoid the candidate scope prequery", async () => {
  const rerank = vi.fn(async () => [1]);
  const { batch, embedding, vectorRepository, snapshot } = await setup(
    fixture(10001),
    false,
    true,
    4000,
    new QueryVectorCache(),
    { port: { rerank }, settings: rerankSettings },
  );
  const result = await batch.evaluate({
    language: "query",
    query: {
      table: "facts",
      conditions: [{ field: "content", op: "contains", value: "内容" }],
      fields: ["content"],
      orderBy: { field: "$record_id", direction: "asc" },
      limit: 1,
    },
  });
  expect(result.rows).toEqual([["内容0"]]);
  expect(result.sources).toEqual([]);
  expect(vectorRepository.listVectors).not.toHaveBeenCalled();
  expect(embedding.embed).not.toHaveBeenCalled();
  const indexedRecord = snapshot.records[0]!;
  vectorRepository.listVectors.mockResolvedValue([
    {
      id: "r0g",
      memorySpaceId: indexedRecord.memorySpaceId,
      tableId: indexedRecord.tableId,
      recordId: indexedRecord.id,
      groupId: "g",
      fingerprint: JSON.stringify([["f"], "内容：内容0", "model", "v1"]),
      model: "model",
      version: "v1",
      values: [1, 0],
      updatedAt: stamp,
    },
  ]);
  const semantic = await batch.evaluate({
    language: "query",
    query: {
      table: "facts",
      semantic: { groups: ["facts"], query: { text: "问题" }, options: { rerank: false } },
      conditions: [{ field: "content", op: "contains", value: "内容" }],
      fields: ["content"],
      limit: 1,
    },
  });
  expect(semantic.rows).toEqual([["内容0"]]);
  expect(semantic.sources[0]!.coverage.records).toBe(10001);
  expect(rerank).not.toHaveBeenCalled();
});

it("reranks scoped SQL candidates, preserves cosine scores and the full relation, and honors explicit false", async () => {
  const rerank = vi.fn(async (_query: string, documents: readonly string[]) =>
    documents.map((_, i) => i),
  );
  const { batch } = await setup(fixture(4), true, true, 4000, new QueryVectorCache(), {
    port: { rerank },
    settings: rerankSettings,
  });
  const result = await batch.evaluate({
    language: "sql",
    sql: `
    WITH eligible AS MATERIALIZED (SELECT * FROM facts WHERE content != '内容0')
    SELECT s.record_id,s.score,s.rerank_score,s.rerank_rank,s.rank
    FROM semantic_scores('facts',json_array('facts','extra'),:last_user_message,
      json_object('scopeRecordIds',json((SELECT json_group_array("$record_id") FROM eligible)))) s
    ORDER BY s.record_id`,
  });
  expect(result.rows).toEqual([
    ["r1", 0, 0, 2, 2],
    ["r2", 0, 1, 1, 1],
    ["r3", 0, null, null, null],
  ]);
  expect(rerank).toHaveBeenCalledTimes(1);
  expect(rerank.mock.calls[0]![1]).toEqual(["表格：记忆\n内容：内容1", "表格：记忆\n内容：内容2"]);
  const disabled = await batch.evaluate({
    language: "sql",
    sql: `SELECT record_id,score,rank,rerank_score FROM semantic_scores('facts','["facts"]',:last_user_message,'{"rerank":false,"candidateLimit":1}') ORDER BY rank`,
  });
  expect(disabled.rows).toEqual([
    ["r0", 0, 1, null],
    ["r1", 0, 2, null],
    ["r2", 0, 3, null],
    ["r3", 0, 4, null],
  ]);
  expect(rerank).toHaveBeenCalledTimes(1);
});

it("Query business conditions limit scope before rerank and its limit only limits final rows", async () => {
  const rerank = vi.fn(async (_query: string, documents: readonly string[]) =>
    documents.map((_, i) => i),
  );
  const { batch } = await setup(fixture(5), true, true, 4000, new QueryVectorCache(), {
    port: { rerank },
    settings: rerankSettings,
  });
  const result = await batch.evaluate({
    language: "query",
    query: {
      table: "facts",
      semantic: {
        groups: ["facts"],
        query: { context: "last_user_message" },
        options: { candidateLimit: 2, textFields: ["content"] },
      },
      conditions: [{ field: "content", op: "in", value: ["内容2", "内容3", "内容4"] }],
      fields: ["content", "$similarity", "$rerank_score", "$rank"],
      orderBy: { field: "$rank", direction: "asc" },
      limit: 1,
    },
  });
  expect(result.rows).toEqual([["内容3", 0, 1, 1]]);
  expect(rerank.mock.calls[0]![1]).toEqual(["表格：记忆\n内容：内容2", "表格：记忆\n内容：内容3"]);
  expect(result.sources[0]!.coverage.records).toBe(3);
});

it("shares successful rerank inputs across Query and SQL and skips empty scopes", async () => {
  const rerank = vi.fn(async (_query: string, documents: readonly string[]) =>
    documents.map((_, i) => i),
  );
  const { batch } = await setup(fixture(3), true, true, 4000, new QueryVectorCache(), {
    port: { rerank },
    settings: rerankSettings,
  });
  await batch.evaluate({
    language: "query",
    query: {
      table: "facts",
      semantic: { groups: ["facts"], query: { context: "last_user_message" } },
      fields: ["content"],
      orderBy: { field: "$rank", direction: "asc" },
      limit: 1,
    },
  });
  await batch.evaluate({
    language: "sql",
    sql: `SELECT record_id FROM semantic_scores('facts','["facts"]',:last_user_message,'{"candidateLimit":2}') WHERE rank IS NOT NULL ORDER BY rank`,
  });
  expect(rerank).toHaveBeenCalledTimes(1);
  const empty = await batch.evaluate({
    language: "sql",
    sql: `SELECT count(*) FROM semantic_scores('facts','["facts"]',:last_user_message,'{"scopeRecordIds":[]}')`,
  });
  expect(empty.rows).toEqual([[0]]);
  expect(rerank).toHaveBeenCalledTimes(1);
});

it("propagates rerank failure and rejects a cancelled late response", async () => {
  let resolve!: (scores: readonly number[]) => void;
  const rerank = vi.fn(
    () =>
      new Promise<readonly number[]>((done) => {
        resolve = done;
      }),
  );
  const { batch, controller } = await setup(fixture(3), true, true, 4000, new QueryVectorCache(), {
    port: { rerank },
    settings: rerankSettings,
  });
  const execution = batch.evaluate({
    language: "sql",
    sql: `SELECT * FROM semantic_scores('facts','["facts"]',:last_user_message)`,
  });
  const failed = expect(execution).rejects.toThrow();
  await vi.waitFor(() => expect(rerank).toHaveBeenCalledTimes(1));
  controller.abort(new Error("切换对话"));
  resolve([0, 1]);
  await failed;
  const broken = await setup(fixture(3), true, true, 4000, new QueryVectorCache(), {
    port: {
      rerank: async () => {
        throw new Error("HTTP 503");
      },
    },
    settings: rerankSettings,
  });
  await expect(
    broken.batch.evaluate({
      language: "sql",
      sql: `SELECT * FROM semantic_scores('facts','["facts"]',:last_user_message)`,
    }),
  ).rejects.toThrow("HTTP 503");
});

it("publishes reranked Query and SQL macro rows during actual generation expansion", async () => {
  const rerank = vi.fn(async (_query: string, documents: readonly string[]) =>
    documents.map((_, i) => i),
  );
  const { batch, snapshot } = await setup(fixture(4), true, true, 4000, new QueryVectorCache(), {
    port: { rerank },
    settings: rerankSettings,
  });
  const definitions: MemoryMacro[] = [
    {
      id: "q",
      name: "查询记忆",
      enabled: true,
      expression: {
        language: "query",
        query: {
          table: "facts",
          semantic: { groups: ["facts"], query: { context: "last_user_message" } },
          fields: ["content"],
          orderBy: { field: "$rank", direction: "asc" },
          limit: 1,
        },
      },
      output: { format: "text", maxChars: null },
    },
    {
      id: "s",
      name: "SQL记忆",
      enabled: true,
      expression: {
        language: "sql",
        sql: `SELECT f.content FROM facts f JOIN semantic_scores('facts','["facts"]',:last_user_message) s ON s.record_id=f."$record_id" WHERE s.rank IS NOT NULL ORDER BY s.rank LIMIT 1`,
      },
      output: { format: "text", maxChars: null },
    },
  ];
  let expand: ((context: MemoryMacroExecutionContext) => string) | undefined;
  const service = new MemoryMacroService({
    getContext: () => "chat",
    getChatMacros: () => [],
    saveChatMacros: async () => {},
    readLegacyChatMacros: () => [],
    writeLegacyChatMacros: () => {},
    readSettings: () => ({
      enabled: true,
      macroName: "{{ste}}",
      macroLimit: 2000,
      macros: definitions,
    }),
    capture: async () => snapshot,
    createBatch: async () => batch,
    registerMacro: {
      register: (_name, handler) => {
        expand = handler;
      },
      unregister: () => {},
    },
  });
  await service.start();
  expect(expand?.({ unnamedArgs: ["查询记忆"] })).toBe("");
  service.started("regenerate", {}, false);
  await service.afterCommands("regenerate", {}, false, "本轮问题");
  expect(expand?.({ unnamedArgs: ["查询记忆"] })).toBe("内容1");
  expect(expand?.({ unnamedArgs: ["SQL记忆"] })).toBe("内容1");
  expect(rerank).toHaveBeenCalledTimes(1);
  service.chatChanged();
  expect(expand?.({ unnamedArgs: ["查询记忆"] })).toBe("");
  service.stop();
});
