import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemorySpaceReader, MemorySpace } from "../memory/index.ts";
import { createInProcessSqliteMemoryClient } from "../../infrastructure/sqlite/node-client.ts";
import type { SqliteMemoryClient, SqliteView } from "../../infrastructure/sqlite/types.ts";
import { createTestMemorySpace } from "./memory-space-fixture.ts";
import { buildMemorySpaceTableDigest } from "./digest.ts";
import { createQuerySqlTool, optionalQuerySqlTools } from "./tools/query/query-sql-tool.ts";

describe("Agent read-only SQL tool with real SQLite", () => {
  let client: SqliteMemoryClient;
  const fixture = createTestMemorySpace();
  const spaceId = fixture.memorySpaceId;
  let view: SqliteView;
  let reader: MemorySpaceReader & Required<Pick<MemorySpaceReader, "querySql">>;
  beforeEach(async () => {
    client = await createInProcessSqliteMemoryClient();
    view = "committed";
    await client.importSpace({
      space: {
        id: spaceId,
        name: "测试",
        initializationSource: null,
        createdAt: "2026-10-24",
        updatedAt: "2026-10-24",
      } as MemorySpace,
      tables: fixture.tables,
      fields: [...fixture.fieldsByTableId.values()].flat(),
      records: [...fixture.recordsByTableId.values()].flat(),
      history: [],
      evidence: [],
    });
    reader = {
      ...fixture.reader,
      async querySql(id, sql) {
        const digest = await buildMemorySpaceTableDigest(fixture.reader, id);
        const allowedTables = Object.fromEntries(
          digest.tables.map((table) => [
            table.key,
            [
              ...table.fields.map((field) => field.key),
              "$record_id",
              "$display_text",
              "$created_at",
              "$updated_at",
            ],
          ]),
        );
        return client.exec({ spaceId: id, sql, view, budgetMs: 1000, maxRows: 101, allowedTables });
      },
    };
  });
  afterEach(async () => {
    await client.close();
  });
  async function tool() {
    return createQuerySqlTool({
      reader,
      digest: await buildMemorySpaceTableDigest(reader, spaceId),
    });
  }
  it("reads SQL AND/OR/JOIN and JSON list members using enabled field Keys", async () => {
    const result = await (
      await tool()
    ).execute("call", {
      sql: "SELECT c.name,l.name AS location FROM characters c JOIN locations l ON c.location=l.\"$record_id\" WHERE c.current_status='受伤' OR (c.name='云烬' AND EXISTS(SELECT 1 FROM json_each(c.aliases) WHERE value='烬'))",
    });
    expect(result.details.rows.length).toBeGreaterThan(0);
    expect(result.details.truncated).toBe(false);
  });
  it("rejects DDL, DML, transaction control and hidden tables/fields through SQLite authorization", async () => {
    for (const sql of [
      "DROP TABLE characters",
      "DELETE FROM characters",
      "BEGIN",
      "PRAGMA foreign_keys=OFF",
      "SELECT data FROM __entities",
      "SELECT secret_notes FROM characters",
      "SELECT name FROM archives",
    ]) {
      await expect((await tool()).execute("call", { sql })).rejects.toThrow();
    }
    expect(
      (await (await tool()).execute("call", { sql: "SELECT count(*) total FROM characters" }))
        .details.rows[0]!.total,
    ).toBe(3);
  });
  it("reads own uncommitted task writes while ordinary readers retain committed data", async () => {
    await client.begin(spaceId);
    const record = (await client.listEntities(spaceId, "record"))[0]!;
    const field = fixture.fieldsByTableId
      .get(record.tableId)!
      .find((field) => field.key === "name")!;
    await client.putEntity(spaceId, "record", {
      ...record,
      payload: { ...record.payload, [field.id]: "事务新名" },
    });
    view = "write";
    expect(
      (
        await (
          await tool()
        ).execute("call", { sql: "SELECT name FROM characters WHERE name='事务新名'" })
      ).details.rows,
    ).toEqual([{ name: "事务新名" }]);
    view = "committed";
    expect(
      (
        await (
          await tool()
        ).execute("call", { sql: "SELECT name FROM characters WHERE name='事务新名'" })
      ).details.rows,
    ).toEqual([]);
    await client.rollback(spaceId);
  });
  it("bounds results and interrupts excessive work, and is absent without host capability", async () => {
    const result = await (
      await tool()
    ).execute("call", {
      sql: "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000) SELECT x FROM n",
    });
    expect(result.details.rows).toHaveLength(100);
    expect(result.details.truncated).toBe(true);
    await expect(
      reader.querySql(
        spaceId,
        "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n",
      ),
    ).rejects.toThrow();
    expect(
      optionalQuerySqlTools(
        fixture.reader,
        await buildMemorySpaceTableDigest(fixture.reader, spaceId),
      ),
    ).toEqual([]);
  });
});
