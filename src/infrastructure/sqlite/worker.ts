import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { SqliteMemoryEngine } from "./engine.ts";
import type { SqliteRequest, SqliteResponse } from "./types.ts";

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<SqliteRequest>) => void;
  postMessage(message: SqliteResponse): void;
};
const ready = sqlite3InitModule().then((sqlite) => new SqliteMemoryEngine(sqlite));
// Preserve arrival order across async engine calls, including publication after COMMIT.
let queue = Promise.resolve();
scope.onmessage = (event) => {
  queue = queue.then(async () => {
    const { id, method, args } = event.data;
    try {
      const engine = await ready;
      const call = engine[method] as (...args: unknown[]) => Promise<unknown>;
      scope.postMessage({ id, result: await call.apply(engine, args) });
    } catch (error) {
      scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  });
};
