import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/adapters/outbound/sqlite/database/database.ts";
import { migrateDatabase, migrations } from "../src/adapters/outbound/sqlite/database/migrate.ts";
import { initialMigration } from "../src/adapters/outbound/sqlite/database/migrations/0001-initial.ts";

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
        "cleaning_rules",
        "kysely_migration",
        "kysely_migration_lock",
        "memory_evidence",
        "memory_fields",
        "memory_fill_tasks",
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

  it("upgrades fill task rows to the lifecycle status set (0004 → 0006)", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ste-memory-fill-task-upgrade-"));
    const database = createDatabase(`sqlite:${join(directory, "application.sqlite")}`);
    try {
      const initialResult = await new Migrator({
        db: database,
        provider: migrations,
      }).migrateTo("0005-cleaning-rules");
      expect(initialResult.error).toBeUndefined();
      await sql
        .raw(
          `
        INSERT INTO memory_spaces (id, name, created_at, updated_at)
        VALUES ('space-1', '会话', '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z')
      `,
        )
        .execute(database);
      await sql
        .raw(
          `
        INSERT INTO memory_fill_tasks (
          run_id, memory_space_id, from_source_id, to_source_id, block_size,
          status, error_message, created_at, updated_at
        ) VALUES (
          'run-1', 'space-1', 1, 4, 2, 'running', NULL,
          '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z'
        )
      `,
        )
        .execute(database);

      await migrateDatabase(database);

      // 旧行保留，状态原样；新状态集可写（约束已重建）。
      const rows = await sql<{ status: string }>`
        SELECT status FROM memory_fill_tasks WHERE run_id = 'run-1'
      `.execute(database);
      expect(rows.rows[0]?.status).toBe("running");
      await database
        .updateTable("memory_fill_tasks")
        .set({ status: "paused" })
        .where("run_id", "=", "run-1")
        .execute();
      const updated = await sql<{ status: string }>`
        SELECT status FROM memory_fill_tasks WHERE run_id = 'run-1'
      `.execute(database);
      expect(updated.rows[0]?.status).toBe("paused");
      // 唯一索引语义扩展：取消/中断也视为终态，暂停中的任务仍算活动。
      await expect(
        database
          .insertInto("memory_fill_tasks")
          .values({
            run_id: "run-2",
            memory_space_id: "space-1",
            from_source_id: 1,
            to_source_id: 2,
            block_size: 2,
            status: "running",
            error_message: null,
            created_at: "2026-07-28T00:00:00.000Z",
            updated_at: "2026-07-28T00:00:00.000Z",
          })
          .execute(),
      ).rejects.toThrow("UNIQUE constraint failed");
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

  it("upgrades an existing database and backfills empty field evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ste-memory-evidence-upgrade-"));
    const database = createDatabase(`sqlite:${join(directory, "application.sqlite")}`);
    try {
      const initialResult = await new Migrator({
        db: database,
        provider: {
          async getMigrations() {
            return { "0001-initial": initialMigration };
          },
        },
      }).migrateToLatest();
      expect(initialResult.error).toBeUndefined();
      await sql
        .raw(
          `
        INSERT INTO memory_spaces (id, name, created_at, updated_at)
        VALUES ('space-1', '会话', '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z')
      `,
        )
        .execute(database);
      await sql
        .raw(
          `
        INSERT INTO memory_tables (
          id, memory_space_id, key, kind, name, description, prompt, enabled,
          display_strategy, created_at, updated_at
        ) VALUES (
          'table-1', 'space-1', 'people', 'custom', '人物', '', '', 1,
          NULL, '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z'
        )
      `,
        )
        .execute(database);
      await sql
        .raw(
          `
        INSERT INTO memory_records (
          id, memory_space_id, table_id, payload_json, display_text, source_json,
          revision_id, revision_source, created_at, updated_at
        ) VALUES (
          'record-1', 'space-1', 'table-1', '{}', '林夏', '{"type":"manual"}',
          'revision-1', 'user', '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z'
        )
      `,
        )
        .execute(database);

      await migrateDatabase(database);

      const records = await sql<{ field_evidence_json: string }>`
        SELECT field_evidence_json FROM memory_records WHERE id = 'record-1'
      `.execute(database);
      expect(records.rows[0]?.field_evidence_json).toBe("{}");
      const evidenceTables = await sql<{ name: string }>`
        SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'memory_evidence'
      `.execute(database);
      expect(evidenceTables.rows[0]?.name).toBe("memory_evidence");
    } finally {
      await database.destroy();
    }
  });
});
