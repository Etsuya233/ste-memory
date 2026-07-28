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
      "memory_records",
      "memory_spaces",
      "memory_tables",
      "source_store_chats",
      "source_store_messages",
      "source_store_migrations",
      "source_store_parse_errors",
    ]);
  });

  it("enforces stable system keys for memory table definitions", () => {
    const directory = mkdtempSync(join(tmpdir(), "ste-memory-system-keys-"));
    const corePath = join(directory, "core.sqlite");
    migrateCoreDatabase(`sqlite:${corePath}`);
    const database = new DatabaseSync(corePath);
    try {
      database
        .prepare("INSERT INTO memory_spaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run("space-1", "会话", "2026-07-28T00:00:00.000Z", "2026-07-28T00:00:00.000Z");
      const insert = database.prepare(`INSERT INTO memory_tables (
        id, memory_space_id, kind, system_key, name, description, prompt, enabled,
        display_strategy, created_at, updated_at
      ) VALUES (?, 'space-1', ?, ?, '表格', '', '', 1, NULL, '2026-07-28', '2026-07-28')`);

      expect(() => insert.run("table-1", "system", null)).toThrow(
        "memory table kind and system key do not match",
      );
      expect(() => insert.run("table-2", "custom", "characters")).toThrow(
        "memory table kind and system key do not match",
      );
      expect(() => insert.run("table-3", "system", "unknown")).toThrow(
        "memory table kind and system key do not match",
      );
    } finally {
      database.close();
    }
  });
});
