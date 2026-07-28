import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateCoreDatabase } from "@ste-memory/core-sqlite";
import { migrateSourceStoreDatabase } from "../src/source-store/migrate.ts";

function tablesAt(databasePath: string): string[] {
  const database = new DatabaseSync(databasePath);
  try {
    return database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String(row.name));
  } finally {
    database.close();
  }
}

describe("SQLite migrations", () => {
  it("migrates Core and Source Store databases independently", () => {
    const directory = mkdtempSync(join(tmpdir(), "ste-memory-"));
    const corePath = join(directory, "core.sqlite");
    const sourcePath = join(directory, "source.sqlite");

    migrateCoreDatabase(`sqlite:${corePath}`);
    migrateSourceStoreDatabase(`sqlite:${sourcePath}`);

    expect(tablesAt(corePath)).toEqual([
      "core_migrations",
      "memory_fields",
      "memory_record_history",
      "memory_records",
      "memory_spaces",
      "memory_tables",
    ]);
    expect(tablesAt(sourcePath)).toEqual([
      "source_store_chats",
      "source_store_messages",
      "source_store_migrations",
      "source_store_parse_errors",
    ]);
  });

  it("keeps migration ownership separate in a shared file", () => {
    const directory = mkdtempSync(join(tmpdir(), "ste-memory-"));
    const sharedPath = join(directory, "shared.sqlite");

    migrateCoreDatabase(`sqlite:${sharedPath}`);
    migrateSourceStoreDatabase(`sqlite:${sharedPath}`);

    expect(tablesAt(sharedPath)).toEqual([
      "core_migrations",
      "memory_fields",
      "memory_record_history",
      "memory_records",
      "memory_spaces",
      "memory_tables",
      "source_store_chats",
      "source_store_messages",
      "source_store_migrations",
      "source_store_parse_errors",
    ]);
  });

  it("enforces table and field key uniqueness in their namespaces", () => {
    const directory = mkdtempSync(join(tmpdir(), "ste-memory-definition-keys-"));
    const corePath = join(directory, "core.sqlite");
    migrateCoreDatabase(`sqlite:${corePath}`);
    const database = new DatabaseSync(corePath);
    try {
      database
        .prepare("INSERT INTO memory_spaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run("space-1", "会话", "2026-07-28T00:00:00.000Z", "2026-07-28T00:00:00.000Z");
      const insertTable = database.prepare(`INSERT INTO memory_tables (
        id, memory_space_id, key, kind, name, description, prompt, enabled,
        display_strategy, created_at, updated_at
      ) VALUES (?, 'space-1', ?, 'custom', '表格', '', '', 1, NULL, '2026-07-28', '2026-07-28')`);
      insertTable.run("table-1", "characters");
      expect(() => insertTable.run("table-2", "characters")).toThrow(
        "UNIQUE constraint failed: memory_tables.memory_space_id, memory_tables.key",
      );

      const insertField = database.prepare(`INSERT INTO memory_fields (
        id, memory_space_id, table_id, key, name, type, required, prompt, enabled, position,
        options_json, reference_table_id, created_at, updated_at
      ) VALUES (?, 'space-1', 'table-1', ?, '字段', 'short_text', 0, '', 1, 0,
        '[]', NULL, '2026-07-28', '2026-07-28')`);
      insertField.run("field-1", "name");
      expect(() => insertField.run("field-2", "name")).toThrow(
        "UNIQUE constraint failed: memory_fields.memory_space_id, memory_fields.table_id, memory_fields.key",
      );
    } finally {
      database.close();
    }
  });

  it("migrates old system keys and assigns ids to definitions without keys", () => {
    const directory = mkdtempSync(join(tmpdir(), "ste-memory-old-definition-keys-"));
    const corePath = join(directory, "core.sqlite");
    const database = new DatabaseSync(corePath);
    database.exec(`
      CREATE TABLE memory_spaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE memory_tables (
        id TEXT PRIMARY KEY, memory_space_id TEXT NOT NULL, kind TEXT NOT NULL,
        system_key TEXT, name TEXT NOT NULL, description TEXT NOT NULL, prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL, display_strategy TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE memory_fields (
        id TEXT PRIMARY KEY, memory_space_id TEXT NOT NULL, table_id TEXT NOT NULL,
        name TEXT NOT NULL, type TEXT NOT NULL, required INTEGER NOT NULL, prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL, position INTEGER NOT NULL, options_json TEXT NOT NULL,
        reference_table_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO memory_spaces VALUES ('space-1', '会话', '2026-07-28', '2026-07-28');
      INSERT INTO memory_tables VALUES
        ('table-system', 'space-1', 'system', 'characters', '人物', '', '', 1, NULL, '2026-07-28', '2026-07-28'),
        ('table-custom', 'space-1', 'custom', NULL, '线索', '', '', 1, NULL, '2026-07-28', '2026-07-28');
      INSERT INTO memory_fields VALUES
        ('field-1', 'space-1', 'table-system', '名称', 'short_text', 1, '', 1, 0, '[]', NULL, '2026-07-28', '2026-07-28');
    `);
    database.close();

    migrateCoreDatabase(`sqlite:${corePath}`);
    const migrated = new DatabaseSync(corePath);
    try {
      expect(migrated.prepare("SELECT id, key FROM memory_tables ORDER BY id").all()).toEqual([
        { id: "table-custom", key: "table-custom" },
        { id: "table-system", key: "characters" },
      ]);
      expect(migrated.prepare("SELECT id, key FROM memory_fields").all()).toEqual([
        { id: "field-1", key: "field-1" },
      ]);
      expect(
        migrated
          .prepare("PRAGMA table_info(memory_tables)")
          .all()
          .some((column) => column.name === "system_key"),
      ).toBe(false);
    } finally {
      migrated.close();
    }
  });
});
