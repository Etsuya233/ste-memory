import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/adapters/outbound/sqlite/database/database.ts";
import { migrateDatabase } from "../src/adapters/outbound/sqlite/database/migrate.ts";

describe("application database migrations", () => {
  it("creates the complete schema in one database and remains idempotent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ste-memory-migration-"));
    const database = createDatabase(`sqlite:${join(directory, "application.sqlite")}`);
    try {
      await migrateDatabase(database);
      await migrateDatabase(database);
      const tables = await sql<{ name: string }>`
        SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `.execute(database);
      expect(tables.rows.map((row) => row.name)).toEqual([
        "kysely_migration",
        "kysely_migration_lock",
        "memory_fields",
        "memory_record_history",
        "memory_records",
        "memory_spaces",
        "memory_tables",
        "source_store_chats",
        "source_store_messages",
        "source_store_parse_errors",
      ]);
    } finally {
      await database.destroy();
    }
  });

  it("enforces table and field key uniqueness in their namespaces", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ste-memory-definition-keys-"));
    const database = createDatabase(`sqlite:${join(directory, "application.sqlite")}`);
    try {
      await migrateDatabase(database);
      await database
        .insertInto("memory_spaces")
        .values({
          id: "space-1",
          name: "会话",
          created_at: "2026-07-28T00:00:00.000Z",
          updated_at: "2026-07-28T00:00:00.000Z",
        })
        .execute();
      const table = {
        memory_space_id: "space-1",
        key: "characters",
        kind: "custom" as const,
        name: "表格",
        description: "",
        prompt: "",
        enabled: 1,
        display_strategy: null,
        created_at: "2026-07-28T00:00:00.000Z",
        updated_at: "2026-07-28T00:00:00.000Z",
      };
      await database
        .insertInto("memory_tables")
        .values({ id: "table-1", ...table })
        .execute();
      await expect(
        database
          .insertInto("memory_tables")
          .values({ id: "table-2", ...table })
          .execute(),
      ).rejects.toThrow("UNIQUE constraint failed");
      const field = {
        memory_space_id: "space-1",
        table_id: "table-1",
        key: "name",
        name: "字段",
        type: "short_text" as const,
        required: 0,
        prompt: "",
        enabled: 1,
        position: 0,
        options_json: "[]",
        reference_table_id: null,
        created_at: "2026-07-28T00:00:00.000Z",
        updated_at: "2026-07-28T00:00:00.000Z",
      };
      await database
        .insertInto("memory_fields")
        .values({ id: "field-1", ...field })
        .execute();
      await expect(
        database
          .insertInto("memory_fields")
          .values({ id: "field-2", ...field })
          .execute(),
      ).rejects.toThrow("UNIQUE constraint failed");
    } finally {
      await database.destroy();
    }
  });
});
