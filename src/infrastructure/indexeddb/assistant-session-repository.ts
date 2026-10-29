import type {
  AssistantSession,
  AssistantSessionRepository,
} from "../../features/query-chat/session-store.ts";
import type { SteMemoryDatabase } from "./database.ts";

export class IndexedDbAssistantSessions implements AssistantSessionRepository {
  private readonly db: SteMemoryDatabase;
  constructor(db: SteMemoryDatabase) {
    this.db = db;
  }
  list() {
    return this.db.assistantSessions.toArray();
  }
  async put(session: AssistantSession) {
    await this.db.assistantSessions.put(session);
  }
  async delete(id: string) {
    await this.db.assistantSessions.delete(id);
  }
}
