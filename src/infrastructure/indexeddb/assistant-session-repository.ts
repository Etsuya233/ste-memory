import type {
  AssistantSession,
  AssistantSessionRepository,
} from "../../features/query-chat/session-store.ts";
import {
  AssistantSessionBusyError,
  AssistantSessionConflictError,
} from "../../features/query-chat/session-store.ts";
import { liveQuery } from "dexie";
import type { SteMemoryDatabase } from "./database.ts";

export class IndexedDbAssistantSessions implements AssistantSessionRepository {
  private readonly db: SteMemoryDatabase;
  constructor(db: SteMemoryDatabase) {
    this.db = db;
  }
  list() {
    return this.db.assistantSessions.toArray();
  }
  find(id: string) {
    return this.db.assistantSessions.get(id);
  }
  async put(session: AssistantSession, expectedRevision: number) {
    await this.db.transaction("rw", this.db.assistantSessions, async () => {
      const current = await this.find(session.id);
      if ((current?.storageRevision ?? -1) !== expectedRevision)
        throw new AssistantSessionConflictError();
      await this.db.assistantSessions.put(session);
    });
  }
  async delete(id: string, expectedRevision: number) {
    await this.db.transaction("rw", this.db.assistantSessions, async () => {
      const current = await this.find(id);
      if ((current?.storageRevision ?? -1) !== expectedRevision)
        throw new AssistantSessionConflictError();
      await this.db.assistantSessions.delete(id);
    });
  }
  async withLock<T>(
    id: string,
    work: () => Promise<T>,
    wait = false,
    signal?: AbortSignal,
  ): Promise<T> {
    // HTTP 局域网等环境没有 Web Locks，允许单页面使用；页内互斥由 Store 负责。
    // 该环境不保证跨页面协调，持久化仍保留版本校验，不模拟分布式锁。
    signal?.throwIfAborted();
    if (!navigator.locks) return work();
    return navigator.locks.request(
      `ste-memory:${this.db.name}:assistant:${id}`,
      wait ? { signal } : { ifAvailable: true },
      async (lock) => {
        if (!lock) throw new AssistantSessionBusyError();
        return work();
      },
    );
  }
  subscribe(onRows: (rows: AssistantSession[]) => void, onError: (error: unknown) => void) {
    const subscription = liveQuery(() => this.list()).subscribe({ next: onRows, error: onError });
    return () => subscription.unsubscribe();
  }
}
