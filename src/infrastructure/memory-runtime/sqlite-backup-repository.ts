import type { MemoryBackupSnapshot } from "../../features/backup/backup-port.ts";
import type { MemorySpaceBackup } from "../../features/backup/backup-file.ts";
import type { SteMemoryDatabase } from "../indexeddb/database.ts";
import { DexieMemoryBackupRepository } from "../indexeddb/backup/memory-backup-repository.ts";
import type { SqliteMemoryClient } from "../sqlite/types.ts";
import type { SqliteMemoryStore } from "./sqlite-memory-store.ts";

/** Explicit restore invalidates live databases; ordinary snapshot caching does not purge vectors. */
export class SqliteMemoryBackupRepository extends DexieMemoryBackupRepository {
  private readonly memory: SqliteMemoryStore;
  private readonly createClient: () => SqliteMemoryClient | Promise<SqliteMemoryClient>;
  constructor(
    db: SteMemoryDatabase,
    memory: SqliteMemoryStore,
    createClient: () => SqliteMemoryClient | Promise<SqliteMemoryClient>,
  ) {
    super(db);
    this.memory = memory;
    this.createClient = createClient;
  }

  private async validate(units: readonly MemorySpaceBackup[]): Promise<void> {
    const validator = await this.createClient();
    try {
      for (const unit of units) await validator.importSpace(unit);
    } finally {
      await validator.close();
    }
  }

  override async restoreSpace(unit: MemorySpaceBackup): Promise<void> {
    await this.memory.exclusive(unit.space.id, async (token) => {
      await this.validate([unit]);
      await super.restoreSpace(unit);
      await this.memory.unload(unit.space.id, token);
      await this.memory.ensure(unit.space.id);
      await this.memory.onCommitted(unit);
    });
  }

  override async restoreSnapshot(snapshot: MemoryBackupSnapshot): Promise<void> {
    await this.memory.exclusiveAll(async (token) => {
      await this.validate(snapshot.spaces);
      await super.restoreSnapshot(snapshot);
      await this.memory.discardLoaded(token);
      for (const unit of snapshot.spaces) await this.memory.onCommitted(unit);
    });
  }
}
