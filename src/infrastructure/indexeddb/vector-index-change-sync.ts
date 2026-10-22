import type { Transaction } from "dexie";
import type { MemorySpaceId } from "../../features/memory/index.ts";
import type { VectorIndexService, VectorScope } from "../../features/vector-index/index.ts";
import type { SteMemoryDatabase } from "./database.ts";

/** 记忆事务结束后合并核对向量，不把网络或索引登记放进记忆事务。 */
export class VectorIndexChangeSync {
  private readonly db: SteMemoryDatabase;
  private readonly vector: VectorIndexService;
  private readonly readEnabled: () => boolean;
  private readonly reportError: (error: unknown) => void;
  private readonly dirtySpaces = new Set<MemorySpaceId>();
  private readonly purges = new Map<string, VectorScope>();
  private pending: Promise<void> = Promise.resolve();
  private scheduled = false;

  constructor(
    db: SteMemoryDatabase,
    vector: VectorIndexService,
    readEnabled: () => boolean,
    reportError: (error: unknown) => void,
  ) {
    this.db = db;
    this.vector = vector;
    this.readEnabled = readEnabled;
    this.reportError = reportError;
  }

  start(): void {
    const onChange = (spaceId: MemorySpaceId, transaction: Transaction, purge?: VectorScope) => {
      transaction.on("complete", () => {
        if (purge) this.purges.set(JSON.stringify(purge), purge);
        this.dirtySpaces.add(spaceId);
        this.schedule();
      });
    };
    this.db.memorySpaces.hook("creating", (_key, row, tx) => onChange(row.id, tx));
    this.db.memorySpaces.hook("updating", (_changes, _key, row, tx) => onChange(row.id, tx));
    this.db.memorySpaces.hook("deleting", (_key, row, tx) =>
      onChange(row.id, tx, { memorySpaceId: row.id }),
    );
    this.db.memoryTables.hook("creating", (_key, row, tx) => onChange(row.memorySpaceId, tx));
    this.db.memoryTables.hook("updating", (_changes, _key, row, tx) =>
      onChange(row.memorySpaceId, tx),
    );
    this.db.memoryTables.hook("deleting", (_key, row, tx) =>
      onChange(row.memorySpaceId, tx, { memorySpaceId: row.memorySpaceId, tableId: row.id }),
    );
    this.db.memoryFields.hook("creating", (_key, row, tx) => onChange(row.memorySpaceId, tx));
    this.db.memoryFields.hook("updating", (_changes, _key, row, tx) =>
      onChange(row.memorySpaceId, tx),
    );
    this.db.memoryFields.hook("deleting", (_key, row, tx) => onChange(row.memorySpaceId, tx));
    this.db.memoryRecords.hook("creating", (_key, row, tx) => onChange(row.memorySpaceId, tx));
    this.db.memoryRecords.hook("updating", (_changes, _key, row, tx) =>
      onChange(row.memorySpaceId, tx),
    );
    this.db.memoryRecords.hook("deleting", (_key, row, tx) =>
      onChange(row.memorySpaceId, tx, {
        memorySpaceId: row.memorySpaceId,
        tableId: row.tableId,
        recordId: row.id,
      }),
    );
  }

  activate(spaceId: MemorySpaceId): void {
    this.dirtySpaces.add(spaceId);
    this.schedule();
  }

  async refreshSettings(): Promise<void> {
    const spaces = await this.db.memorySpaces.toArray();
    if (!this.readEnabled()) {
      for (const space of spaces) await this.vector.stop({ memorySpaceId: space.id });
      return;
    }
    this.vector.resumeConnection();
    for (const space of spaces) this.dirtySpaces.add(space.id);
    this.schedule();
    await this.pending;
  }

  /** 测试与显式刷新可等待所有已提交变更的核对完成。 */
  async flush(): Promise<void> {
    await Promise.resolve();
    await this.pending;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.pending = this.pending
      .then(async () => {
        this.scheduled = false;
        const purges = [...this.purges.values()];
        const spaces = [...this.dirtySpaces];
        this.purges.clear();
        this.dirtySpaces.clear();
        for (const scope of purges) await this.vector.purge(scope);
        if (!this.readEnabled()) return;
        for (const spaceId of spaces) {
          if (await this.db.memorySpaces.get(spaceId)) {
            await this.vector.reconcile({ memorySpaceId: spaceId });
          }
        }
      })
      .catch(this.reportError);
  }
}
