import type { SqliteMemoryClient, SqliteRequest, SqliteResponse } from "./types.ts";
export type {
  SqliteMemoryClient,
  SqliteEntities,
  SqliteEntityKind,
  SqliteExecution,
  SqliteView,
} from "./types.ts";

/** Worker resource URL remains relative to the published extension module. */
export function createSqliteMemoryClient(): SqliteMemoryClient {
  const worker = new Worker(new URL("sqlite-worker.js", import.meta.url), { type: "module" });
  let sequence = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  worker.onmessage = (event: MessageEvent<SqliteResponse>) => {
    const waiter = pending.get(event.data.id);
    if (!waiter) return;
    pending.delete(event.data.id);
    if (event.data.error !== undefined) waiter.reject(new Error(event.data.error));
    else waiter.resolve(event.data.result);
  };
  worker.onerror = (event) => {
    for (const waiter of pending.values()) waiter.reject(new Error(event.message));
    pending.clear();
  };
  return new Proxy({} as SqliteMemoryClient, {
    get(_target, property: string) {
      // A client is not a Promise; async factories must not accidentally invoke a "then" RPC.
      if (property === "then") return undefined;
      return (...args: unknown[]) =>
        new Promise<unknown>((resolve, reject) => {
          const id = ++sequence;
          pending.set(id, { resolve, reject });
          worker.postMessage({
            id,
            method: property as keyof SqliteMemoryClient,
            args,
          } satisfies SqliteRequest);
          if (property === "close")
            pending.set(id, {
              resolve(value) {
                resolve(value);
                worker.terminate();
              },
              reject,
            });
        });
    },
  });
}
