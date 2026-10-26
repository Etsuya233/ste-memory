import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
