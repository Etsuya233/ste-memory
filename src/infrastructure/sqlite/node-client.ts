import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { SqliteMemoryEngine } from "./engine.ts";
import type { SqliteMemoryClient } from "./types.ts";

/** Explicit test harness: production always creates the dedicated Web Worker. */
export async function createInProcessSqliteMemoryClient(): Promise<SqliteMemoryClient> {
  return new SqliteMemoryEngine(await sqlite3InitModule());
}
