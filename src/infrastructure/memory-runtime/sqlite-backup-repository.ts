import { migrateMemorySpaceSnapshot } from "../../features/memory-snapshot/snapshot-migration.ts";
import type { MemorySpaceBackup } from "../../features/backup/backup-file.ts";
import type { MemoryBackupRepository } from "../../features/backup/backup-port.ts";
import type { SqliteMemoryClient } from "../sqlite/types.ts";
import type { SqliteMemoryStore } from "./sqlite-memory-store.ts";

/** 当前空间导出与候选SQLite约束校验；无本地空间目录和第二份持久化内容。 */
export class SqliteMemoryBackupRepository implements MemoryBackupRepository {
  private readonly memory: SqliteMemoryStore;
  private readonly currentSpaceId: () => string | undefined;
  private readonly createClient: () => SqliteMemoryClient | Promise<SqliteMemoryClient>;
  constructor(
    memory: SqliteMemoryStore,
    currentSpaceId: () => string | undefined,
    createClient: () => SqliteMemoryClient | Promise<SqliteMemoryClient>,
  ) {
    this.memory = memory;
    this.currentSpaceId = currentSpaceId;
    this.createClient = createClient;
  }

  async exportCurrentSpace(): Promise<MemorySpaceBackup> {
    const id = this.currentSpaceId();
    if (!id) {
      throw new Error("当前聊天的记忆空间尚未就绪");
    }
    const snapshot = await this.memory.snapshot(id);
    if (!snapshot) {
      throw new Error("当前聊天的记忆空间尚未加载");
    }
    return snapshot;
  }
  async validateSnapshot(unit: MemorySpaceBackup): Promise<void> {
    migrateMemorySpaceSnapshot({ version: unit.schemaVersion, snapshot: unit });
    const client = await this.createClient();
    try {
      await client.importSpace(unit);
    } finally {
      await client.close();
    }
  }
}
