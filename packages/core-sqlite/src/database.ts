import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function sqlitePathFromUrl(databaseUrl: string): string {
  if (!databaseUrl.startsWith("sqlite:")) {
    throw new Error(`Unsupported database URL: ${databaseUrl}`);
  }

  const path = databaseUrl.slice("sqlite:".length);
  if (!path) {
    throw new Error("SQLite database URL must include a file path");
  }
  if (path === ":memory:") {
    return path;
  }
  return resolve(path);
}

export function openSqliteDatabase(databaseUrl: string): DatabaseSync {
  const path = sqlitePathFromUrl(databaseUrl);
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

export function checkSqliteConnection(databaseUrl: string): void {
  const database = openSqliteDatabase(databaseUrl);
  try {
    database.prepare("SELECT 1").get();
  } finally {
    database.close();
  }
}
