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
    if (!navigator.locks) throw new Error("当前浏览器未提供会话锁，无法安全执行助手会话");
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
