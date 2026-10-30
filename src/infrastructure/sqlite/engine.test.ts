import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemorySpaceBackup } from "../../features/backup/backup-file.ts";
import type { MemoryRecord } from "../../features/memory/index.ts";
import { createInProcessSqliteMemoryClient } from "./node-client.ts";
import type { SqliteMemoryClient } from "./types.ts";
import { querySqliteRecords } from "./query-executor.ts";
import type { QueryRecordsInput } from "../../features/memory/index.ts";

const stamp = "2026-10-24T00:00:00.000Z";
function fixture(): MemorySpaceBackup {
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
        key: "角色",
        name: "角色",
        description: "",
        prompt: "",
        enabled: true,
        position: 0,
        displayStrategy: null,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    fields: [
      {
        id: "f",
        memorySpaceId: "s",
        tableId: "t",
        key: "姓名",
        name: "姓名",
        type: "short_text",
        required: true,
        prompt: "",
        enabled: true,
        position: 0,
        options: [],
        referenceTableId: null,
        maxChars: 10,
        valuePattern: null,
        valuePatternMessage: null,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    records: [],
    history: [],
    evidence: [],
  } as unknown as MemorySpaceBackup;
}
function record(id: string, name: string): MemoryRecord {
  return {
    id,
    memorySpaceId: "s",
    tableId: "t",
    payload: { f: name },
    fieldEvidence: {},
    displayText: name,
    source: { type: "manual" },
    revisionId: `revision-${id}`,
    revisionSource: "user",
    createdAt: stamp,
    updatedAt: stamp,
  } as unknown as MemoryRecord;
}
describe("real SQLite WASM memory engine", () => {
  let client: SqliteMemoryClient;
  beforeEach(async () => {
    client = await createInProcessSqliteMemoryClient();
    await client.importSpace(fixture());
  });
  afterEach(async () => {
    await client.close();
  });
  it("public snapshots contain all committed records and exclude in-progress writes and backup-only data", async () => {
    await client.begin("s");
    await client.putEntity("s", "record", record("r", "小红"));
    expect((await client.readSnapshot("s")).records).toHaveLength(0);
    await client.commit("s");
    const snapshot = await client.readSnapshot("s");
    expect(snapshot.records.map((item) => item.id)).toEqual(["r"]);
    expect(Object.keys(snapshot).sort()).toEqual(["fields", "records", "space", "tables"]);
  });
  it("classifies inline semantic dependencies during prepare without executing input expressions", async () => {
    const data = fixture();
    const sessionId = await client.openEvaluation(data);
    const from = `semantic_scores('角色','["facts"]',:last_user_message)`;
    for (const sql of [
      `SELECT * FROM ${from}`,
      `SELECT count(*) AS total FROM ${from}`,
      `WITH s AS(SELECT * FROM ${from}) SELECT record_id FROM s`,
      `SELECT score FROM(SELECT * FROM ${from})`,
      `SELECT * FROM ${from} WHERE 0`,
      `SELECT CASE WHEN :last_user_message THEN(SELECT count(*) FROM ${from}) ELSE 0 END`,
    ]) {
      for (const lastUserMessage of [null, "1"]) {
        const result = await client.evaluateSemanticSql({
          sessionId,
          sql,
          sources: [],
          lastUserMessage,
          prepareOnly: true,
        });
        expect(result).toMatchObject({ status: "complete", usesSemantic: true, rows: [] });
        expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
      }
    }
    expect(
      await client.evaluateSemanticSql({
        sessionId,
        sources: [],
        sql: "SELECT 1",
        prepareOnly: true,
      }),
    ).toMatchObject({ status: "complete", usesSemantic: false });
    expect(
      await client.evaluateSemanticSql({
        sessionId,
        sources: [],
        sql: `WITH unused AS(SELECT * FROM ${from}) SELECT 1`,
        prepareOnly: true,
      }),
    ).toMatchObject({ status: "complete", usesSemantic: false });
  });
  it("normalizes runtime semantic inputs and discards rows emitted before a structured source miss", async () => {
    const data = fixture();
    const sessionId = await client.openEvaluation({
      ...data,
      tables: [
        {
          ...data.tables[0]!,
          vectorIndex: {
            enabled: true,
            source: "custom",
            updateMode: "manual",
            groups: [
              { id: "g", key: "facts", name: "事实", fieldIds: [data.fields[0]!.id] },
              { id: "g2", key: "extra", name: "补充", fieldIds: [data.fields[0]!.id] },
            ],
          },
        },
      ],
    });
    const sql = `SELECT 'prefix' AS record_id,0 AS score UNION ALL SELECT record_id,score FROM semantic_scores('角色',json_array('facts','extra'),:last_user_message)`;
    const pending = await client.evaluateSemanticSql({
      sessionId,
      sql,
      lastUserMessage: "  问题\n",
      sources: [],
    });
    expect(pending).toMatchObject({
      status: "needs-semantic-source",
      request: { table: "角色", groups: ["facts", "extra"], query: "问题" },
    });
    expect(pending).not.toHaveProperty("rows");
    expect(
      await client.evaluateSemanticSql({
        sessionId,
        sql,
        lastUserMessage: "left\0right",
        sources: [],
      }),
    ).toMatchObject({ status: "needs-semantic-source", request: { query: "left\0right" } });
    const sources = [
      {
        table: "角色",
        groups: ["facts", "extra"],
        query: "问题",
        rows: [{ recordId: "r", score: 0.9, groupKey: "facts" }],
      },
    ];
    expect(
      await client.evaluateSemanticSql({ sessionId, sql, lastUserMessage: "  问题\n", sources }),
    ).toMatchObject({
      status: "complete",
      rows: [
        ["prefix", 0],
        ["r", 0.9],
      ],
      usesSemantic: true,
    });
    expect(
      await client.evaluateSemanticSql({ sessionId, sql, lastUserMessage: "another", sources: [] }),
    ).toMatchObject({ status: "needs-semantic-source", request: { query: "another" } });
  });
  it("keeps every semantic row available to final SQL ordering and separate cursors", async () => {
    const data = fixture();
    const sessionId = await client.openEvaluation({
      ...data,
      tables: [
        {
          ...data.tables[0]!,
          vectorIndex: {
            enabled: true,
            source: "custom",
            updateMode: "manual",
            groups: [{ id: "g", key: "facts", name: "事实", fieldIds: [data.fields[0]!.id] }],
          },
        },
      ],
    });
    const rows = Array.from({ length: 201 }, (_, i) => ({
      recordId: `r${i}`,
      score: i / 200,
      groupKey: "facts",
    }));
    const sources = [{ table: "角色", groups: ["facts"], query: "问题", rows }];
    const from = `semantic_scores('角色','["facts"]','问题')`;
    expect(
      await client.evaluateSemanticSql({
        sessionId,
        sources,
        sql: `SELECT record_id,score FROM ${from} ORDER BY score DESC LIMIT 1 OFFSET 0`,
      }),
    ).toMatchObject({ status: "complete", rows: [["r200", 1]] });
    expect(
      await client.evaluateSemanticSql({
        sessionId,
        sources,
        sql: `SELECT a.record_id AS first,b.record_id AS second FROM ${from} a CROSS JOIN ${from} b WHERE a.score>=0.995 AND b.score>=0.995 ORDER BY first,second`,
      }),
    ).toMatchObject({
      status: "complete",
      rows: [
        ["r199", "r199"],
        ["r199", "r200"],
        ["r200", "r199"],
        ["r200", "r200"],
      ],
    });
  });
  it("uses real empty prepared relations for COUNT, EXISTS and LEFT JOIN", async () => {
    const data = fixture();
    const sessionId = await client.openEvaluation({
      ...data,
      records: [record("r", "甲")],
      tables: [
        {
          ...data.tables[0]!,
          vectorIndex: {
            enabled: true,
            source: "custom",
            updateMode: "manual",
            groups: [{ id: "g", key: "facts", name: "事实", fieldIds: [data.fields[0]!.id] }],
          },
        },
      ],
    });
    const from = `semantic_scores('角色','["facts"]','问题')`;
    expect(
      await client.evaluateSemanticSql({
        sessionId,
        sources: [],
        sql: `SELECT count(*) AS total FROM ${from}`,
      }),
    ).toMatchObject({ status: "needs-semantic-source" });
    const sources = [{ table: "角色", groups: ["facts"], query: "问题", rows: [] }];
    expect(
      await client.evaluateSemanticSql({
        sessionId,
        sources,
        sql: `SELECT count(*) AS total FROM ${from}`,
      }),
    ).toMatchObject({ status: "complete", rows: [[0]] });
    expect(
      await client.evaluateSemanticSql({
        sessionId,
        sources,
        sql: `SELECT EXISTS(SELECT 1 FROM ${from}) AS found`,
      }),
    ).toMatchObject({ status: "complete", rows: [[0]] });
    expect(
      await client.evaluateSemanticSql({
        sessionId,
        sources,
        sql: `SELECT t."姓名",s.score FROM "角色" t LEFT JOIN ${from} s ON s.record_id=t."$record_id"`,
      }),
    ).toMatchObject({ status: "complete", rows: [["甲", null]] });
  });
  it("plans a correlated fourth argument after its JOIN dependency", async () => {
    const data = fixture();
    const sessionId = await client.openEvaluation({
      ...data,
      records: [record("a", "甲"), record("b", "乙")],
      tables: [
        {
          ...data.tables[0]!,
          vectorIndex: {
            enabled: true,
            source: "custom",
            updateMode: "manual",
            groups: [{ id: "g", key: "facts", name: "事实", fieldIds: [data.fields[0]!.id] }],
          },
        },
      ],
    });
    const sql = `SELECT t."姓名",s.record_id FROM semantic_scores(
      '角色','["facts"]','问题',
      json_object('rerank',json('false'),'scopeRecordIds',json_array(t."$record_id"))
    ) s JOIN "角色" t ON s.record_id=t."$record_id" ORDER BY t."$record_id"`;
    const first = await client.evaluateSemanticSql({ sessionId, sql, sources: [] });
    expect(first).toMatchObject({
      status: "needs-semantic-source",
      request: { options: { rerank: false, scopeRecordIds: ["a"] } },
    });
    const sources = [
      {
        table: "角色",
        groups: ["facts"],
        query: "问题",
        options: { rerank: false, scopeRecordIds: ["a"] },
        rows: [{ recordId: "a", score: 0.8, groupKey: "facts" }],
      },
    ];
    expect(await client.evaluateSemanticSql({ sessionId, sql, sources })).toMatchObject({
      status: "needs-semantic-source",
      request: { options: { rerank: false, scopeRecordIds: ["b"] } },
    });
    sources.push({
      table: "角色",
      groups: ["facts"],
      query: "问题",
      options: { rerank: false, scopeRecordIds: ["b"] },
      rows: [{ recordId: "b", score: 0.6, groupKey: "facts" }],
    });
    expect(await client.evaluateSemanticSql({ sessionId, sql, sources })).toMatchObject({
      status: "complete",
      rows: [
        ["甲", "a"],
        ["乙", "b"],
      ],
    });
  });
  it("accepts row-correlated TEXT parameters without mixing sources or cursor state", async () => {
    const data = fixture();
    const sessionId = await client.openEvaluation({
      ...data,
      records: [record("a", "甲"), record("b", "乙")],
      tables: [
        {
          ...data.tables[0]!,
          vectorIndex: {
            enabled: true,
            source: "custom",
            updateMode: "manual",
            groups: [{ id: "g", key: "facts", name: "事实", fieldIds: [data.fields[0]!.id] }],
          },
        },
      ],
    });
    const sql = `SELECT t."姓名",s.record_id,s.score FROM "角色" t CROSS JOIN semantic_scores('角色','["facts"]',t."姓名") s ORDER BY t."姓名"`;
    const first = await client.evaluateSemanticSql({ sessionId, sql, sources: [] });
    expect(first).toMatchObject({ status: "needs-semantic-source", request: { query: "甲" } });
    const sources = [
      {
        table: "角色",
        groups: ["facts"],
        query: "甲",
        rows: [{ recordId: "a", score: 0.8, groupKey: "facts" }],
      },
    ];
    expect(await client.evaluateSemanticSql({ sessionId, sql, sources })).toMatchObject({
      status: "needs-semantic-source",
      request: { query: "乙" },
    });
    sources.push({
      table: "角色",
      groups: ["facts"],
      query: "乙",
      rows: [{ recordId: "b", score: 0.6, groupKey: "facts" }],
    });
    expect(await client.evaluateSemanticSql({ sessionId, sql, sources })).toMatchObject({
      status: "complete",
      rows: [
        ["乙", "b", 0.6],
        ["甲", "a", 0.8],
      ],
    });
  });
  it.each([
    "semantic_scores(NULL,'[\"facts\"]','问题')",
    "semantic_scores('角色',1,'问题')",
    "semantic_scores('角色','bad json','问题')",
    "semantic_scores('角色','[]','问题')",
    "semantic_scores('角色','[\"facts\",\"facts\"]','问题')",
    "semantic_scores('角色','[1]','问题')",
    "semantic_scores('角色','[\"gone\"]','问题')",
    "semantic_scores('角色','[\"facts\"]',42)",
    "semantic_scores('角色','[\"facts\"]',NULL)",
    "semantic_scores('角色','[\"facts\"]','   ')",
    "semantic_scores('gone','[\"facts\"]','问题')",
  ])("rejects invalid runtime input before returning a preparation request: %s", async (from) => {
    const data = fixture();
    const sessionId = await client.openEvaluation({
      ...data,
      tables: [
        {
          ...data.tables[0]!,
          vectorIndex: {
            enabled: true,
            source: "custom",
            updateMode: "manual",
            groups: [{ id: "g", key: "facts", name: "事实", fieldIds: [data.fields[0]!.id] }],
          },
        },
      ],
    });
    await expect(
      client.evaluateSemanticSql({ sessionId, sources: [], sql: `SELECT * FROM ${from}` }),
    ).rejects.toThrow();
  });
  it("enforces inline read authorization and rejects mixed legacy sources", async () => {
    const data = fixture();
    const sessionId = await client.openEvaluation(data);
    const from = `semantic_scores('角色','["facts"]','问题')`;
    for (const sql of [
      `SELECT * FROM __entities`,
      `DELETE FROM "角色"`,
      `SELECT * FROM ${from};SELECT 1`,
      `SELECT record_id AS x,score AS x FROM ${from}`,
      `SELECT query_arg FROM ${from}`,
      `SELECT load_extension('x')`,
    ])
      await expect(
        client.evaluateSemanticSql({ sessionId, sources: [], sql, prepareOnly: true }),
      ).rejects.toThrow();
    await expect(
      client.evaluateMacro({
        sessionId,
        sources: [{ name: "old_scores", rows: [] }],
        sql: `SELECT * FROM ${from}`,
        prepareOnly: true,
      }),
    ).rejects.toThrow("混用");
    await expect(
      client.openEvaluation({
        ...data,
        tables: [{ ...data.tables[0]!, key: "SEMANTIC_SCORES" }],
      } as unknown as MemorySpaceBackup),
    ).rejects.toThrow("保留名称");
    expect(
      (await client.executeConsole("s", `SELECT * FROM ${from}`)).semanticStatement?.sql,
    ).toContain("semantic_scores");
  });
  it("preserves a legacy temp source named semantic_scores without classifying it as the inline function", async () => {
    const sessionId = await client.openEvaluation(fixture());
    const sources = [
      { name: "SEMANTIC_SCORES", rows: [{ recordId: "legacy", score: 0.7, groupKey: "facts" }] },
    ];
    expect(
      await client.evaluateMacro({
        sessionId,
        sources,
        sql: "SELECT record_id,score FROM semantic_scores",
      }),
    ).toEqual({ columns: ["record_id", "score"], rows: [["legacy", 0.7]] });
    expect(
      await client.evaluateMacro({
        sessionId,
        sources,
        sql: "SELECT count(*) AS total FROM semantic_scores",
        prepareOnly: true,
      }),
    ).toEqual({ columns: ["total"], rows: [] });
    await expect(
      client.evaluateMacro({
        sessionId,
        sources,
        sql: `SELECT * FROM semantic_scores('角色','["facts"]','问题')`,
        prepareOnly: true,
      }),
    ).rejects.toThrow("not a function");
    await expect(
      client.evaluateMacro({
        sessionId,
        sources,
        sql: `SELECT * FROM main.semantic_scores('角色','["facts"]','问题')`,
        prepareOnly: true,
      }),
    ).rejects.toThrow("混用");
    await expect(
      client.evaluateMacro({
        sessionId,
        sources,
        sql: `SELECT count(*) FROM main.semantic_scores('角色','["facts"]','问题')`,
        prepareOnly: true,
      }),
    ).rejects.toThrow("混用");
    await expect(
      client.evaluateMacro({
        sessionId,
        sources,
        sql: `SELECT * FROM main.semantic_scores('角色','["facts"]','问题') WHERE 0`,
        prepareOnly: true,
      }),
    ).rejects.toThrow("混用");
    expect(
      await client.evaluateMacro({
        sessionId,
        sources,
        sql: "SELECT count(*) AS total FROM temp.semantic_scores WHERE 0",
        prepareOnly: true,
      }),
    ).toEqual({ columns: ["total"], rows: [] });
    expect(
      await client.evaluateSemanticSql({
        sessionId,
        sources: [],
        sql: `SELECT count(*) AS total FROM semantic_scores('角色','["facts"]','问题')`,
        prepareOnly: true,
      }),
    ).toMatchObject({ status: "complete", usesSemantic: true, rows: [] });
    expect(
      await client.evaluateSemanticSql({ sessionId, sources: [], sql: "SELECT 1 AS ok" }),
    ).toMatchObject({ status: "complete", usesSemantic: false, rows: [[1]] });
  });
  it("checks enabled source metadata from the captured evaluation snapshot", async () => {
    const data = fixture();
    const table = {
      ...data.tables[0]!,
      vectorIndex: {
        enabled: true,
        source: "custom" as const,
        updateMode: "manual" as const,
        groups: [{ id: "g", key: "facts", name: "事实", fieldIds: [data.fields[0]!.id] }],
      },
    };
    const sql = `SELECT * FROM semantic_scores('角色','["facts"]','问题')`;
    const sessionId = await client.openEvaluation({ ...data, tables: [table] });
    table.vectorIndex.groups[0]!.key = "changed-after-capture";
    expect(await client.evaluateSemanticSql({ sessionId, sql, sources: [] })).toMatchObject({
      status: "needs-semantic-source",
      request: { groups: ["facts"] },
    });
    for (const snapshot of [
      { ...data, tables: [{ ...table, enabled: false }] },
      { ...data, tables: [{ ...table, vectorIndex: { ...table.vectorIndex, enabled: false } }] },
      { ...data, tables: [table], fields: [{ ...data.fields[0]!, enabled: false }] },
    ]) {
      const invalid = await client.openEvaluation(snapshot);
      await expect(
        client.evaluateSemanticSql({
          sessionId: invalid,
          sql: sql.replace('"facts"', '"changed-after-capture"'),
          sources: [],
        }),
      ).rejects.toThrow();
    }
  });
  it("applies the 10000 row cap to the final result while retaining larger semantic relations", async () => {
    const data = fixture();
    const sessionId = await client.openEvaluation({
      ...data,
      tables: [
        {
          ...data.tables[0]!,
          vectorIndex: {
            enabled: true,
            source: "custom",
            updateMode: "manual",
            groups: [{ id: "g", key: "facts", name: "事实", fieldIds: [data.fields[0]!.id] }],
          },
        },
      ],
    });
    const rows = Array.from({ length: 10001 }, (_, i) => ({
      recordId: String(i),
      score: 0.5,
      groupKey: "facts",
    }));
    const sources = [{ table: "角色", groups: ["facts"], query: "问题", rows }];
    const from = `semantic_scores('角色','["facts"]','问题')`;
    expect(
      await client.evaluateSemanticSql({
        sessionId,
        sources,
        sql: `SELECT count(*) AS total FROM ${from}`,
      }),
    ).toMatchObject({ status: "complete", rows: [[10001]] });
    await expect(
      client.evaluateSemanticSql({ sessionId, sources, sql: `SELECT record_id FROM ${from}` }),
    ).rejects.toThrow("10000");
  });
  it("cleans failed statements and pending requests after VM interruption", async () => {
    const data = fixture();
    const sessionId = await client.openEvaluation({
      ...data,
      tables: [
        {
          ...data.tables[0]!,
          vectorIndex: {
            enabled: true,
            source: "custom",
            updateMode: "manual",
            groups: [{ id: "g", key: "facts", name: "事实", fieldIds: [data.fields[0]!.id] }],
          },
        },
      ],
    });
    const from = `semantic_scores('角色','["facts"]','问题')`;
    const sources = [
      {
        table: "角色",
        groups: ["facts"],
        query: "问题",
        rows: Array.from({ length: 2000 }, (_, i) => ({
          recordId: String(i),
          score: 0.5,
          groupKey: "facts",
        })),
      },
    ];
    await expect(
      client.evaluateSemanticSql({
        sessionId,
        sources,
        sql: `SELECT count(*) AS total FROM ${from} a CROSS JOIN ${from} b`,
        budgetMs: 1,
      }),
    ).rejects.toThrow();
    expect(
      await client.evaluateSemanticSql({ sessionId, sources: [], sql: "SELECT 1 AS ok" }),
    ).toMatchObject({ status: "complete", rows: [[1]], usesSemantic: false });
    expect(
      await client.evaluateSemanticSql({ sessionId, sources: [], sql: `SELECT * FROM ${from}` }),
    ).toMatchObject({ status: "needs-semantic-source" });
    await expect(
      client.evaluateSemanticSql({
        sessionId,
        sources,
        sql: `SELECT json_extract('invalid','$') FROM ${from}`,
      }),
    ).rejects.toThrow("JSON");
    expect(
      await client.evaluateSemanticSql({ sessionId, sources: [], sql: "SELECT 2 AS ok" }),
    ).toMatchObject({ status: "complete", rows: [[2]] });
  });
  it("evaluates isolated macro snapshots with trusted local sources and ordered columns", async () => {
    const snapshot = fixture();
    const sessionId = await client.openEvaluation({
      ...snapshot,
      records: [record("one", "旧正文")],
    });
    await client.putEntity("s", "record", record("one", "新正文"));
    const input = {
      sessionId,
      sources: [{ name: "scores", rows: [{ recordId: "one", score: 0.7, groupKey: "facts" }] }],
    };
    expect(
      await client.evaluateMacro({
        ...input,
        sql: 'SELECT r."姓名" AS name,s.score,:last_user_message AS message FROM "角色" r JOIN scores s ON s.record_id=r."$record_id"',
        lastUserMessage: "hello'; SELECT 9",
      }),
    ).toEqual({
      columns: ["name", "score", "message"],
      rows: [["旧正文", 0.7, "hello'; SELECT 9"]],
    });
    await expect(
      client.evaluateMacro({ sessionId, sources: [], sql: "SELECT * FROM scores" }),
    ).rejects.toThrow();
    await expect(
      client.evaluateMacro({ ...input, sql: "SELECT * FROM __entities" }),
    ).rejects.toThrow();
    await expect(client.evaluateMacro({ ...input, sql: "DELETE FROM scores" })).rejects.toThrow();
    await expect(client.evaluateMacro({ ...input, sql: "SELECT 1; SELECT 2" })).rejects.toThrow(
      "一条",
    );
    await expect(client.evaluateMacro({ ...input, sql: "SELECT 1 AS a,2 AS a" })).rejects.toThrow(
      "重复列",
    );
    expect(
      await client.evaluateMacro({
        sessionId,
        sources: [],
        sql: "SELECT :last_user_message AS message",
      }),
    ).toEqual({ columns: ["message"], rows: [[null]] });
    await client.closeEvaluation(sessionId);
  });
  it("rejects the 10001st macro row and interrupts expensive SQL while keeping the session reusable", async () => {
    const sessionId = await client.openEvaluation(fixture());
    await expect(
      client.evaluateMacro({
        sessionId,
        sources: [],
        sql: "WITH RECURSIVE n(v) AS(VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<10001) SELECT v FROM n",
      }),
    ).rejects.toThrow("10000");
    await expect(
      client.evaluateMacro({
        sessionId,
        sources: [],
        budgetMs: 1,
        sql: "WITH RECURSIVE n(v) AS(VALUES(1) UNION ALL SELECT v+1 FROM n) SELECT sum(v) FROM n",
      }),
    ).rejects.toThrow();
    expect(
      (await client.evaluateMacro({ sessionId, sources: [], sql: "SELECT 1 AS ok; -- comment" }))
        .rows,
    ).toEqual([[1]]);
  });
  it("starts the legacy SQL budget after trusted source materialization while preserving the total deadline", async () => {
    const sessionId = await client.openEvaluation(fixture());
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const sources = [
      {
        name: "scores",
        rows: [
          {
            get recordId() {
              now += 1200;
              return "one";
            },
            score: 0.7,
            groupKey: "facts",
          },
          { recordId: "two", score: 0.6, groupKey: "facts" },
        ],
      },
    ];
    try {
      expect(
        await client.evaluateMacro({
          sessionId,
          sources,
          remainingMs: 5000,
          sql: "SELECT record_id FROM scores ORDER BY score DESC LIMIT 1",
        }),
      ).toEqual({ columns: ["record_id"], rows: [["one"]] });
      now = 0;
      await expect(
        client.evaluateMacro({
          sessionId,
          sources,
          remainingMs: 1000,
          sql: "SELECT record_id FROM scores LIMIT 1",
        }),
      ).rejects.toThrow("宏求值超时");
      now = 0;
      await expect(
        client.evaluateMacro({
          sessionId,
          sources,
          remainingMs: 5000,
          get sql() {
            now += 1001;
            return "SELECT record_id FROM scores LIMIT 1";
          },
        }),
      ).rejects.toThrow("SQL 超出执行预算");
    } finally {
      clock.mockRestore();
    }
    expect(await client.evaluateMacro({ sessionId, sources: [], sql: "SELECT 1 AS ok" })).toEqual({
      columns: ["ok"],
      rows: [[1]],
    });
  });
  it("uses SQLite ASCII identifier matching without exposing disabled Unicode tables or columns", async () => {
    const data = fixture();
    const sessionId = await client.openEvaluation({
      ...data,
      tables: [
        { ...data.tables[0]!, key: "ä" },
        { ...data.tables[0]!, id: "hidden", key: "Ä", enabled: false },
      ],
      fields: [
        { ...data.fields[0]!, key: "ä" },
        { ...data.fields[0]!, id: "hidden-field", key: "Ä", required: false, enabled: false },
        { ...data.fields[0]!, id: "other-field", tableId: "hidden", key: "value" },
      ],
      records: [
        { ...record("one", "公开"), payload: { f: "公开", "hidden-field": "secret" } },
        { ...record("two", "secret"), tableId: "hidden", payload: { "other-field": "secret" } },
      ],
    } as unknown as MemorySpaceBackup);
    expect(
      (await client.evaluateMacro({ sessionId, sources: [], sql: 'SELECT "ä" FROM "ä"' })).rows,
    ).toEqual([["公开"]]);
    await expect(
      client.evaluateMacro({ sessionId, sources: [], sql: 'SELECT "$display_text" FROM "Ä"' }),
    ).rejects.toThrow();
    await expect(
      client.evaluateMacro({ sessionId, sources: [], sql: 'SELECT "Ä" FROM "ä"' }),
    ).rejects.toThrow();
    const other = await client.openEvaluation(fixture());
    expect(
      (
        await client.evaluateMacro({
          sessionId: other,
          sources: [
            { name: "ä", rows: [{ recordId: "a", score: 1, groupKey: "g" }] },
            { name: "Ä", rows: [{ recordId: "b", score: 0, groupKey: "g" }] },
          ],
          sql: 'SELECT a.record_id AS a,b.record_id AS b FROM "ä" a JOIN "Ä" b',
        })
      ).rows,
    ).toEqual([["a", "b"]]);
  });
  it.each(["json_each", "json_tree"])(
    "does not authorize a disabled business table named %s as a JSON virtual table",
    async (key) => {
      const data = fixture();
      for (const enabled of [false, true]) {
        const sessionId = await client.openEvaluation({
          ...data,
          tables: [{ ...data.tables[0]!, key, enabled }],
          records: [record("one", "secret")],
        } as unknown as MemorySpaceBackup);
        const result = client.evaluateMacro({
          sessionId,
          sources: [],
          sql: `SELECT "$display_text" FROM "${key}"`,
        });
        if (enabled) expect((await result).rows).toEqual([["secret"]]);
        else await expect(result).rejects.toThrow();
      }
    },
  );
  it("pauses only the native semantic statement and returns its tail without replaying console writes", async () => {
    const semanticSql = `SELECT * FROM semantic_scores('角色','["facts"]','问题;文本');`;
    const result = await client.executeConsole(
      "s",
      `CREATE TABLE console_once(n); INSERT INTO console_once VALUES(1); ${semanticSql} INSERT INTO console_once VALUES(2);`,
    );
    expect(result.semanticStatement!.sql.trim()).toBe(semanticSql);
    expect(result.semanticStatement!.remainingSql.trim()).toBe(
      "INSERT INTO console_once VALUES(2);",
    );
    expect(result.changes).toBe(1);
    expect(
      (await client.executeConsole("s", "SELECT * FROM console_once")).results[0]!.rows,
    ).toEqual([[1]]);
    await client.executeConsole("s", result.semanticStatement!.remainingSql);
    expect(
      (await client.executeConsole("s", "SELECT * FROM console_once")).results[0]!.rows,
    ).toEqual([[1], [2]]);
    const literal = await client.executeConsole(
      "s",
      "SELECT 'semantic_scores(ignored)' AS text; -- semantic_scores\n SELECT 2;",
    );
    expect(literal.semanticStatement).toBeUndefined();
    expect(literal.results).toHaveLength(2);
    const shadow = await client.executeConsole(
      "s",
      "CREATE TABLE semantic_scores(value TEXT); INSERT INTO semantic_scores VALUES('ordinary'); SELECT * FROM semantic_scores;",
    );
    expect(shadow.semanticStatement).toBeUndefined();
    expect(shadow.results[0]!.rows).toEqual([["ordinary"]]);
  });
  it("detects native semantic reads through CTE, COUNT, subqueries and branches and refuses semantic writes before stepping", async () => {
    const from = `semantic_scores('角色','["facts"]','问题')`;
    for (const sql of [
      `SELECT count(*) FROM ${from}`,
      `WITH scores AS(SELECT * FROM ${from}) SELECT * FROM scores`,
      `SELECT * FROM(SELECT * FROM ${from})`,
      `SELECT * FROM ${from} WHERE 0`,
      `SELECT CASE WHEN 0 THEN(SELECT count(*) FROM ${from}) ELSE 1 END`,
    ])
      expect((await client.executeConsole("s", sql)).semanticStatement?.sql).toBe(sql);
    await client.executeConsole("s", "CREATE TABLE forbidden(n)");
    await expect(
      client.executeConsole("s", `INSERT INTO forbidden SELECT score FROM ${from}`),
    ).rejects.toThrow("只读");
    expect((await client.executeConsole("s", "SELECT * FROM forbidden")).results[0]!.rows).toEqual(
      [],
    );
    await client.executeConsole(
      "s",
      `CREATE TRIGGER no_semantic_write AFTER INSERT ON forbidden BEGIN SELECT count(*) FROM ${from}; END;`,
    );
    await expect(client.executeConsole("s", "INSERT INTO forbidden VALUES(1)")).rejects.toThrow(
      "只读",
    );
    expect((await client.executeConsole("s", "SELECT * FROM forbidden")).results[0]!.rows).toEqual(
      [],
    );
  });
  it("executes unrestricted console DDL, DML, PRAGMA and multiple result sets in order", async () => {
    const result = await client.executeConsole(
      "s",
      `
      CREATE TABLE console_sample(value TEXT);
      INSERT INTO console_sample VALUES('hello;世界');
      ALTER TABLE console_sample ADD COLUMN n INTEGER DEFAULT 3;
      UPDATE console_sample SET n=7;
      SELECT value,n FROM console_sample;
      PRAGMA table_info(console_sample);
      SELECT 1 AS same,2 AS same;
    `,
    );
    expect(result.results[0]).toEqual({ columns: ["value", "n"], rows: [["hello;世界", 7]] });
    expect(result.results[1]!.rows).toHaveLength(2);
    expect(result.results[2]).toEqual({ columns: ["same", "same"], rows: [[1, 2]] });
    expect(result.changes).toBe(2);
    expect(result.transactionOpen).toBe(false);
    expect(
      (await client.consoleSchema("s")).find((entry) => entry.name === "console_sample")?.columns,
    ).toEqual([
      { name: "value", type: "TEXT" },
      { name: "n", type: "INTEGER" },
    ]);
    await client.executeConsole("s", "DROP TABLE console_sample");
    expect((await client.consoleSchema("s")).some((entry) => entry.name === "console_sample")).toBe(
      false,
    );
  });
  it("returns all console rows, empty-result columns, NULL, empty strings and blobs", async () => {
    const result = await client.executeConsole(
      "s",
      `
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<250) SELECT x FROM n;
      SELECT 1 AS empty WHERE 0;
      SELECT NULL AS nil,'' AS blank,x'00ff' AS binary;
    `,
    );
    expect(result.results[0]!.rows).toHaveLength(250);
    expect(result.results[1]).toEqual({ columns: ["empty"], rows: [] });
    expect(result.results[2]!.rows[0]).toEqual([null, "", new Uint8Array([0, 255])]);
  });
  it("allows explicit console transactions across calls and leaves earlier statements on errors", async () => {
    await client.executeConsole("s", "CREATE TABLE console_sample(n)");
    expect(
      (await client.executeConsole("s", "BEGIN; INSERT INTO console_sample VALUES(1)"))
        .transactionOpen,
    ).toBe(true);
    expect(
      (await client.executeConsole("s", "ROLLBACK; SELECT * FROM console_sample")).results[0]!.rows,
    ).toEqual([]);
    await expect(
      client.executeConsole(
        "s",
        "INSERT INTO console_sample VALUES(2); SELECT * FROM missing_table",
      ),
    ).rejects.toThrow();
    expect(
      (await client.executeConsole("s", "SELECT * FROM console_sample")).results[0]!.rows,
    ).toEqual([[2]]);
    await client.executeConsole("s", "BEGIN; INSERT INTO console_sample VALUES(3); COMMIT");
    expect(
      (await client.executeConsole("s", "SELECT * FROM console_sample")).results[0]!.rows,
    ).toEqual([[2], [3]]);
  });
  it("uses SQLite statement boundaries for triggers and grants access to internal tables", async () => {
    const result = await client.executeConsole(
      "s",
      `
      CREATE TABLE console_sample(n);
      CREATE TRIGGER console_trigger AFTER INSERT ON console_sample WHEN NEW.n=1 BEGIN
        INSERT INTO console_sample VALUES(2); INSERT INTO console_sample VALUES(3);
      END;
      INSERT INTO console_sample VALUES(1);
      SELECT * FROM console_sample ORDER BY n;
      SELECT count(*) FROM __entities;
    `,
    );
    expect(result.results[0]!.rows).toEqual([[1], [2], [3]]);
    expect(result.results[1]!.rows[0]![0]).toBeGreaterThan(0);
    // The existing Agent endpoint remains read-only even after console execution.
    await expect(client.exec({ spaceId: "s", sql: "DROP TABLE console_sample" })).rejects.toThrow();
  });
  it("executes against the current database without publishing or saving console mutations", async () => {
    await client.putEntity("s", "record", record("r", "林"));
    await client.executeConsole("s", 'UPDATE "角色" SET "姓名"=\'SQL\'; CREATE TABLE transient(n)');
    expect(await client.exec({ spaceId: "s", sql: 'SELECT "姓名" FROM "角色"' })).toEqual([
      { 姓名: "SQL" },
    ]);
    expect((await client.exportSpace("s")).records[0]!.payload.f).toBe("林");
    await client.importSpace(await client.exportSpace("s"));
    expect((await client.consoleSchema("s")).some((entry) => entry.name === "transient")).toBe(
      false,
    );
    expect(await client.exec({ spaceId: "s", sql: 'SELECT "姓名" FROM "角色"' })).toEqual([
      { 姓名: "林" },
    ]);
  });
  it("isolates committed reads, supports parameter SQL, commits and round-trips full records", async () => {
    await client.begin("s");
    await client.putEntity("s", "record", record("r", "林"));
    expect(await client.listEntities("s", "record")).toEqual([]);
    expect(
      await client.exec({
        spaceId: "s",
        view: "write",
        sql: "SELECT 姓名 FROM 角色 WHERE 姓名=? OR 姓名=?",
        bind: ["林", "张三"],
      }),
    ).toEqual([{ 姓名: "林" }]);
    await client.commit("s");
    expect((await client.exportSpace("s")).records).toEqual([record("r", "林")]);
  });
  it("rolls back a failed tool savepoint and the outer task independently", async () => {
    await client.begin("s");
    await client.putEntity("s", "record", record("r", "林"));
    await expect(client.putEntity("s", "record", record("bad", ""))).rejects.toThrow();
    expect((await client.listEntities("s", "record", "write")).map((row) => row.id)).toEqual(["r"]);
    await client.rollback("s");
    expect(await client.listEntities("s", "record", "write")).toEqual([]);
  });
  it("authorizes compiled SQL and actually interrupts expensive recursive queries", async () => {
    for (const sql of [
      "BEGIN",
      "PRAGMA foreign_keys=OFF",
      "DROP TABLE 角色",
      "DELETE FROM 角色",
      "SELECT 1; DELETE FROM 角色",
    ]) {
      await expect(client.exec({ spaceId: "s", sql })).rejects.toThrow();
    }
    await expect(
      client.exec({
        spaceId: "s",
        budgetMs: 1,
        sql: "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n",
      }),
    ).rejects.toThrow();
    expect(await client.exec({ spaceId: "s", sql: "SELECT 1 AS ok" })).toEqual([{ ok: 1 }]);
  });
  it("enforces delayed references and retains list order in the complete snapshot", async () => {
    const snapshot = fixture();
    const field = {
      ...snapshot.fields[0]!,
      id: "ref",
      key: "朋友",
      name: "朋友",
      type: "multi_reference",
      required: false,
      referenceTableId: "t",
      maxChars: null,
    } as unknown as MemorySpaceBackup["fields"][number];
    await client.importSpace({ ...snapshot, fields: [...snapshot.fields, field] });
    await client.begin("s");
    const first = { ...record("r1", "林"), payload: { f: "林", ref: ["r2"] } };
    await client.putEntity("s", "record", first);
    await expect(client.commit("s")).rejects.toThrow("引用约束");
    await client.putEntity("s", "record", record("r2", "张三"));
    await client.commit("s");
    expect((await client.exportSpace("s")).records[0]!.payload.ref).toEqual(["r2"]);
    await client.putEntity("s", "table", { ...snapshot.tables[0]!, name: "改名" });
    await expect(client.deleteEntity("s", "record", "r2")).rejects.toThrow();
  });
  it("executes null-aware filters, Unicode contains, fresh display, list predicates and paging in SQL", async () => {
    const snapshot = fixture();
    const text = { ...snapshot.fields[0]!, required: false };
    const list = {
      ...text,
      id: "list",
      key: "标签",
      type: "short_text_list",
    } as unknown as MemorySpaceBackup["fields"][number];
    await client.importSpace({ ...snapshot, fields: [text, list] });
    await client.begin("s");
    await client.putEntity("s", "record", {
      ...record("r1", "Äbc"),
      payload: { f: "Äbc", list: ["x", "y"] },
    });
    await client.putEntity("s", "record", { ...record("r2", ""), payload: { f: null, list: [] } });
    await client.putEntity("s", "record", {
      ...record("r3", "Z"),
      payload: { f: "Z", list: null },
    });
    await client.commit("s");
    const query = (conditions: unknown, page = 1, pageSize = 10) =>
      querySqliteRecords(client, "s", {
        tableId: "t",
        conditions,
        paging: { page, pageSize },
      } as unknown as QueryRecordsInput);
    expect(
      (await query([{ fieldId: "f", operator: "contains", value: "äB" }])).records.map(
        (record) => record.id,
      ),
    ).toEqual(["r1"]);
    expect(
      (await query([{ fieldId: "f", operator: "not_in", value: ["Äbc", null] }])).records.map(
        (record) => record.id,
      ),
    ).toEqual(["r3"]);
    expect(
      (await query([{ fieldId: "list", operator: "not_contains", value: "x" }])).records.map(
        (record) => record.id,
      ),
    ).toEqual(["r2"]);
    expect((await query([], 2, 1)).records.map((record) => record.id)).toEqual(["r2"]);
    const fresh = await querySqliteRecords(
      client,
      "s",
      {
        tableId: "t",
        conditions: [{ fieldId: "$display_text", operator: "equals", value: "fresh" }],
        paging: { page: 1, pageSize: 10 },
      } as unknown as QueryRecordsInput,
      "committed",
      [{ id: "r3", displayText: "fresh" }],
    );
    expect(fresh.records.map((record) => [record.id, record.displayText])).toEqual([
      ["r3", "fresh"],
    ]);
  });
  it("rebuilds mutually referencing tables without dropping live foreign-key targets", async () => {
    const snapshot = fixture();
    const second = {
      ...snapshot.tables[0]!,
      id: "t2",
      key: "事件",
      name: "事件",
    } as unknown as MemorySpaceBackup["tables"][number];
    const link = {
      ...snapshot.fields[0]!,
      id: "link",
      key: "事件",
      type: "single_reference",
      required: false,
      referenceTableId: "t2",
      maxChars: null,
    } as unknown as MemorySpaceBackup["fields"][number];
    const back = {
      ...link,
      id: "back",
      tableId: "t2",
      key: "角色",
      referenceTableId: "t",
    } as unknown as MemorySpaceBackup["fields"][number];
    const one = { ...record("r1", "林"), payload: { f: "林", link: "r2" } };
    const two = { ...record("r2", "事件"), tableId: second.id, payload: { back: "r1" } };
    await client.importSpace({
      ...snapshot,
      tables: [...snapshot.tables, second],
      fields: [...snapshot.fields, link, back],
      records: [one, two],
    });
    await client.putEntity("s", "field", { ...link, name: "关联事件" });
    expect((await client.exportSpace("s")).records).toEqual([one, two]);
    expect(
      await client.exec({
        spaceId: "s",
        sql: 'SELECT a.姓名 FROM 角色 a JOIN 事件 b ON a.事件=b."$record_id" WHERE b.角色=a."$record_id"',
      }),
    ).toEqual([{ 姓名: "林" }]);
  });
});
