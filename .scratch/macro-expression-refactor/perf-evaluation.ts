import { createInProcessSqliteMemoryClient } from "../../src/infrastructure/sqlite/node-client.ts";
import { createMacroEvaluationBatch } from "../../src/features/macros/macro-evaluation.ts";
import { QueryVectorCache } from "../../src/features/semantic-query/query-vector-cache.ts";
import type { MemorySpaceBackup } from "../../src/features/backup/backup-file.ts";
import type { RecordVector } from "../../src/features/vector-index/index.ts";
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

const count = Number(process.argv[2]);
const dimensions = 1024;
const snapshot = fixture(count);
const vectors: RecordVector[] = snapshot.records.flatMap((record, i) =>
  ["g", "g2"].map((groupId) => ({
    id: `${record.id}${groupId}`,
    memorySpaceId: record.memorySpaceId,
    tableId: record.tableId,
    recordId: record.id,
    groupId,
    fingerprint: JSON.stringify([["f"], `内容：${record.payload.f}`, "model", "v1"]),
    model: "model",
    version: "v1",
    updatedAt: stamp,
    values: Array.from(
      { length: dimensions },
      (_, j) => (((i + j + (groupId === "g2" ? 3 : 0)) % 17) - 8) / 8,
    ),
  })),
);
const sql = await createInProcessSqliteMemoryClient();
global.gc?.();
const baseline = process.memoryUsage();
let sampledHeap = baseline.heapUsed,
  sampledRss = baseline.rss,
  sampledExternal = baseline.external;
const sample = () => {
  const m = process.memoryUsage();
  sampledHeap = Math.max(sampledHeap, m.heapUsed);
  sampledRss = Math.max(sampledRss, m.rss);
  sampledExternal = Math.max(sampledExternal, m.external);
};
const timer = setInterval(sample, 5);
const started = performance.now();
let queryRpcMs = 0;
const port = {
  openEvaluation: async (data: MemorySpaceBackup) => {
    const id = await sql.openEvaluation(data);
    sample();
    return id;
  },
  evaluateMacro: async (input: Parameters<typeof sql.evaluateMacro>[0]) => {
    const start = performance.now();
    try {
      return await sql.evaluateMacro(input);
    } finally {
      queryRpcMs += performance.now() - start;
      sample();
    }
  },
  closeEvaluation: (id: string) => sql.closeEvaluation(id),
  evaluateSemanticSql: (input: Parameters<typeof sql.evaluateSemanticSql>[0]) =>
    sql.evaluateSemanticSql(input),
};
const queryVector = Array.from({ length: dimensions }, (_, j) => ((j % 17) - 8) / 8);
const embedding = {
  getProfile: () => ({ model: "model", version: "v1", dimensions, maxInputChars: 4000 }),
  embed: async () => queryVector,
};
const controller = new AbortController();
const cache = new QueryVectorCache();
const revision = cache.revisionFor(embedding.getProfile());
const batch = await createMacroEvaluationBatch({
  sql: port,
  vectors: { listVectors: async () => vectors },
  embedding,
  queryVectors: cache.createExecution({
    embedding,
    revision,
    signal: controller.signal,
    isCurrent: () => true,
  }),
  snapshot,
  lastUserMessage: "本轮问题",
  signal: controller.signal,
  deadline: started + 60000,
});
const snapshotMs = performance.now() - started;
const evalStarted = performance.now();
const result = await batch.evaluate({
  language: "query",
  query: {
    table: "facts",
    semantic: {
      groups: ["facts", "extra"],
      query: { context: "last_user_message" },
    },
    fields: ["content", "$similarity"],
    orderBy: { field: "$similarity", direction: "desc" },
    limit: 10,
  },
});
const evaluationMs = performance.now() - evalStarted;
sample();
clearInterval(timer);
console.log(
  JSON.stringify({
    node: process.version,
    records: count,
    groups: 2,
    dimensions,
    vectors: vectors.length,
    deadlineMs: 60000,
    snapshotMs,
    evaluationMs,
    sourcePreparationAndScoreMs: evaluationMs - queryRpcMs,
    materializationAndSqlRpcMs: queryRpcMs,
    totalMs: performance.now() - started,
    scoredRecords: result.sources[0].rows.length,
    coverage: result.sources[0].coverage,
    baseline,
    sampledPeak: {
      heapUsed: sampledHeap,
      rss: sampledRss,
      external: sampledExternal,
    },
    processMaxRssKiB: process.resourceUsage().maxRSS,
  }),
);
await batch.close();
await sql.close();
