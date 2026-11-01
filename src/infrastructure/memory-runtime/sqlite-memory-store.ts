import { MemoryCommitPersistenceError } from "../../features/memory/index.ts";
import type { MemorySpaceBackup } from "../../features/backup/backup-file.ts";
import type {
  MemoryEvidenceRepository,
  MemoryFieldRepository,
  MemoryRecordRepository,
  MemorySpaceRepository,
  MemoryTableRepository,
  MemoryRevisionId,
} from "../../features/memory/index.ts";
import type { SpaceStructureRebuild } from "../../features/space-maintenance/space-structure-rebuild.ts";
import type { SqliteMemoryClient, SqliteView } from "../sqlite/types.ts";
import { sqliteRepositories } from "./sqlite-repositories.ts";
import { consolidateTaskRevisions } from "./sqlite-task-revisions.ts";
export interface SqliteRepositories {
  spaces: MemorySpaceRepository;
  tables: MemoryTableRepository;
  fields: MemoryFieldRepository;
  records: MemoryRecordRepository & MemoryEvidenceRepository;
}

export interface SqliteMemoryStorePorts {
  readonly saveSnapshot: (
    snapshot: MemorySpaceBackup,
    saved?: () => Promise<void>,
  ) => Promise<void>;
  readonly assertCanEdit: (spaceId: string) => void;
  readonly reportRefreshError: (error: unknown) => void;
}

/** SQLite持有在线内容与事务；这里不管理任何本地空间缓存或辅助数据。 */
export class SqliteMemoryStore {
  readonly client: SqliteMemoryClient;
  readonly #loaded = new Set<string>();
  readonly #writers = new Map<string, symbol>();
  readonly #idle = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  #savepoint = 0;
  assertCanEdit: SqliteMemoryStorePorts["assertCanEdit"];
  saveSnapshot: SqliteMemoryStorePorts["saveSnapshot"];
  readonly #listeners = new Set<(spaceId: string) => void | Promise<void>>();
  private readonly reportRefreshError: (error: unknown) => void;
  constructor(client: SqliteMemoryClient, ports: SqliteMemoryStorePorts) {
    this.client = client;
    this.saveSnapshot = ports.saveSnapshot;
    this.assertCanEdit = ports.assertCanEdit;
    this.reportRefreshError = ports.reportRefreshError;
  }

  subscribe(listener: (spaceId: string) => void | Promise<void>): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  hasSpace(spaceId: string): boolean {
    return this.#loaded.has(spaceId);
  }

  private publish(spaceId: string): void {
    // 订阅刷新独立于文件保存；同步异常和异步拒绝均只报告，不撤销已提交数据。
    for (const listener of this.#listeners) {
      try {
        void Promise.resolve(listener(spaceId)).catch(this.reportRefreshError);
      } catch (error) {
        this.reportRefreshError(error);
      }
    }
  }

  async replace(snapshot: MemorySpaceBackup, owner?: symbol): Promise<void> {
    const id = snapshot.space.id;
    const token = owner ?? this.acquireWriter(id);
    this.assertWritable(id, token);
    try {
      await this.client.importSpace(snapshot);
      this.#loaded.add(id);
      this.publish(id);
    } finally {
      if (owner === undefined) this.releaseWriter(id);
    }
  }

  assertWritable(spaceId: string, token?: symbol): void {
    const writer = this.#writers.get(spaceId);
    if (token !== undefined && writer !== token) throw new Error("填表会话已结束，不能继续写入");
    if (token === undefined && writer) throw new Error("该记忆空间正在填写或保存，请等待任务结束");
  }

  async exclusive<T>(spaceId: string, work: (token: symbol) => Promise<T>): Promise<T> {
    const token = this.acquireWriter(spaceId);
    try {
      return await work(token);
    } finally {
      this.releaseWriter(spaceId);
    }
  }

  private acquireWriter(spaceId: string): symbol {
    this.assertWritable(spaceId);
    const token = Symbol(spaceId);
    this.#writers.set(spaceId, token);
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.#idle.set(spaceId, { promise, resolve });
    return token;
  }

  async begin(spaceId: string): Promise<symbol> {
    this.assertCanEdit(spaceId);
    const token = this.acquireWriter(spaceId);
    try {
      if (!this.hasSpace(spaceId)) throw new Error(`记忆空间不存在: ${spaceId}`);
      await this.client.begin(spaceId);
      return token;
    } catch (error) {
      this.releaseWriter(spaceId);
      throw error;
    }
  }

  async whenIdle(spaceId: string): Promise<void> {
    await this.#idle.get(spaceId)?.promise;
  }

  private releaseWriter(spaceId: string): void {
    this.#writers.delete(spaceId);
    this.#idle.get(spaceId)?.resolve();
    this.#idle.delete(spaceId);
  }

  async finish(
    spaceId: string,
    token: symbol,
    commit: boolean,
    saved?: () => Promise<void>,
  ): Promise<void> {
    this.assertWritable(spaceId, token);
    let saving: Promise<void> | undefined;
    try {
      if (!commit) {
        await this.client.rollback(spaceId);
        return;
      }
      try {
        await this.client.commit(spaceId);
      } catch (error) {
        await this.client.rollback(spaceId);
        throw error;
      }
      try {
        this.publish(spaceId);
        const snapshot = await this.client.exportSpace(spaceId);
        // 同步交接独立快照后释放SQL writer；文件网络不再阻挡切聊天和后续编辑。
        saving = this.saveSnapshot(snapshot, saved);
      } catch (cause) {
        throw new MemoryCommitPersistenceError(cause);
      }
    } finally {
      this.releaseWriter(spaceId);
    }
    try {
      await saving;
    } catch (cause) {
      throw new MemoryCommitPersistenceError(cause);
    }
  }

  async write<T>(spaceId: string, work: () => Promise<T>, token?: symbol): Promise<T> {
    this.assertWritable(spaceId, token);
    if (!token) this.assertCanEdit(spaceId);
    if (token) {
      const point = `tool_${++this.#savepoint}`;
      await this.client.savepoint(spaceId, point);
      try {
        const result = await work();
        await this.client.release(spaceId, point);
        return result;
      } catch (error) {
        await this.client.rollbackTo(spaceId, point);
        await this.client.release(spaceId, point);
        throw error;
      }
    }
    await this.begin(spaceId);
    let committed = false;
    let result!: T;
    let saving!: Promise<void>;
    try {
      result = await work();
      await this.client.commit(spaceId);
      committed = true;
      this.publish(spaceId);
      const snapshot = await this.client.exportSpace(spaceId);
      saving = this.saveSnapshot(snapshot);
    } catch (error) {
      if (!committed) await this.client.rollback(spaceId);
      else throw new MemoryCommitPersistenceError(error);
      throw error;
    } finally {
      this.releaseWriter(spaceId);
    }
    try {
      await saving;
    } catch (cause) {
      throw new MemoryCommitPersistenceError(cause);
    }
    return result;
  }

  async snapshot(spaceId: string): Promise<MemorySpaceBackup | undefined> {
    if (!this.hasSpace(spaceId)) return undefined;
    return this.client.exportSpace(spaceId);
  }

  consolidateTask(
    baseline: MemorySpaceBackup,
    token: symbol,
    revisionId: MemoryRevisionId,
    archivedAt: string,
  ): Promise<void> {
    return consolidateTaskRevisions(this, baseline, token, revisionId, archivedAt);
  }

  async unload(spaceId: string, token?: symbol): Promise<void> {
    this.assertWritable(spaceId, token);
    if (!this.#loaded.has(spaceId)) return;
    await this.client.removeSpace(spaceId);
    this.#loaded.delete(spaceId);
  }

  repositories(view: SqliteView = "committed", token?: symbol): SqliteRepositories {
    return sqliteRepositories(this, view, token);
  }

  structureRebuild(
    afterSaved?: (spaceId: MemorySpaceBackup["space"]["id"]) => Promise<void>,
  ): SpaceStructureRebuild {
    return {
      rebuild: async (input) => {
        this.assertCanEdit(input.memorySpaceId);
        let saving: Promise<void> | undefined;
        const rebuilt = await this.exclusive(input.memorySpaceId, async (token) => {
          const unit = await this.snapshot(input.memorySpaceId);
          if (!unit) return false;
          const snapshot: MemorySpaceBackup = {
            schemaVersion: unit.schemaVersion,
            space: {
              ...unit.space,
              prompt: input.prompt ?? "",
              macros: input.macros ?? [],
              initializationSource: input.initializationSource,
              updatedAt: input.initializationSource.appliedAt,
            },
            tables: input.tables,
            fields: input.fields,
            records: [],
            history: [],
            evidence: [],
          };
          await this.replace(snapshot, token);
          try {
            saving = this.saveSnapshot(
              snapshot,
              afterSaved ? () => afterSaved(input.memorySpaceId) : undefined,
            );
          } catch (cause) {
            throw new MemoryCommitPersistenceError(cause);
          }
          return true;
        });
        if (!rebuilt) return false;
        try {
          await saving;
        } catch (cause) {
          throw new MemoryCommitPersistenceError(cause);
        }
        return true;
      },
    };
  }
}
