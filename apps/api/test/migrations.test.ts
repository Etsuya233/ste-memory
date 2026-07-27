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

    expect(tablesAt(corePath)).toEqual(["core_migrations"]);
    expect(tablesAt(sourcePath)).toEqual(["source_store_migrations"]);
  });

  it("keeps migration ownership separate in a shared file", () => {
    const directory = mkdtempSync(join(tmpdir(), "ste-memory-"));
    const sharedPath = join(directory, "shared.sqlite");

    migrateCoreDatabase(`sqlite:${sharedPath}`);
    migrateSourceStoreDatabase(`sqlite:${sharedPath}`);

    expect(tablesAt(sharedPath)).toEqual([
      "core_migrations",
      "source_store_migrations",
    ]);
  });
});
