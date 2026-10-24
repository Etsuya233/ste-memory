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
