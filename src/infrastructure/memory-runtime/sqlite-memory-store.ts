import { parseMemoryMacros } from "../../features/macros/macro-expression.ts";
import { MemoryCommitPersistenceError } from "../../features/memory/index.ts";
import type { Table } from "dexie";
import type { MemorySpaceBackup } from "../../features/backup/backup-file.ts";
import type {
  MemoryEvidenceRepository,
  MemoryFieldRepository,
  MemoryRecordRepository,
  MemoryRecordHistoryQuery,
  MemoryRecordMutation,
  MemoryRecordHistory,
  MemoryRecord,
  MemoryRevisionId,
  MemorySpaceRepository,
  MemoryTableRepository,
  MemorySpaceId,
} from "../../features/memory/index.ts";
import type { SpaceStructureRebuild } from "../../features/space-maintenance/space-structure-rebuild.ts";
import type { SqliteMemoryClient, SqliteView } from "../sqlite/types.ts";
import type { SteMemoryDatabase } from "../indexeddb/database.ts";
import { DexieMemoryBackupRepository } from "../indexeddb/backup/memory-backup-repository.ts";
import { toEvidenceRow } from "../indexeddb/memory/evidence-conversion.ts";

export interface SqliteRepositories {
  spaces: MemorySpaceRepository;
  tables: MemoryTableRepository;
  fields: MemoryFieldRepository;
  records: MemoryRecordRepository & MemoryEvidenceRepository;
}

/** SQLite is the live store. Dexie keeps serializable snapshots and independent task/vector data. */
export class SqliteMemoryStore {
  readonly client: SqliteMemoryClient;
  readonly #db: SteMemoryDatabase;
  readonly #local: DexieMemoryBackupRepository;
  readonly #loaded = new Map<string, Promise<boolean>>();
  readonly #writers = new Map<string, symbol>();
  readonly #idle = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  #wholeStoreOwner: symbol | undefined;
  #wholeStoreIdle: Promise<void> | undefined;
  #savepoint = 0;
  onCommitted: (snapshot: MemorySpaceBackup) => Promise<void> = async () => {};

  constructor(client: SqliteMemoryClient, db: SteMemoryDatabase) {
    this.client = client;
    this.#db = db;
    this.#local = new DexieMemoryBackupRepository(db);
  }

  async ensure(spaceId: string): Promise<boolean> {
    const pending = this.#loaded.get(spaceId);
    if (pending) return pending;
    const loading = (async () => {
      const snapshot = (await this.#local.loadSnapshot()).spaces.find(
        (unit) => unit.space.id === spaceId,
      );
      if (!snapshot) {
        this.#loaded.delete(spaceId);
        return false;
      }
      await this.client.importSpace(snapshot);
      return true;
    })();
    this.#loaded.set(spaceId, loading);
    try {
      return await loading;
    } catch (error) {
      this.#loaded.delete(spaceId);
      throw error;
    }
  }

  async replace(snapshot: MemorySpaceBackup, owner?: symbol): Promise<void> {
    const id = snapshot.space.id;
    const token = owner ?? this.acquireWriter(id);
    this.assertWritable(id, token);
    try {
      await this.client.importSpace(snapshot);
      this.#loaded.set(id, Promise.resolve(true));
      await this.cache(snapshot);
    } finally {
      if (owner === undefined) this.releaseWriter(id);
    }
  }

  assertWritable(spaceId: string, token?: symbol): void {
    if (this.#wholeStoreOwner !== undefined) {
      if (token === this.#wholeStoreOwner) return;
      throw new Error("正在恢复记忆数据，请等待保存结束");
    }
    const writer = this.#writers.get(spaceId);
    if (token !== undefined && writer !== token) throw new Error("填表会话已结束，不能继续写入");
    if (token === undefined && writer) throw new Error("该记忆空间正在填写或保存，请等待任务结束");
  }

  assertIdle(): void {
    if (this.#writers.size > 0 || this.#wholeStoreOwner !== undefined)
      throw new Error("记忆空间正在填写或保存，不能恢复全部数据");
  }

  async discardLoaded(token?: symbol): Promise<void> {
    if (token === undefined) this.assertIdle();
    else this.assertWritable("", token);
    for (const id of this.#loaded.keys()) await this.client.removeSpace(id);
    this.#loaded.clear();
  }

  async exclusive<T>(spaceId: string, work: (token: symbol) => Promise<T>): Promise<T> {
    const token = this.acquireWriter(spaceId);
    try {
      return await work(token);
    } finally {
      this.releaseWriter(spaceId);
    }
  }

  async exclusiveAll<T>(work: (token: symbol) => Promise<T>): Promise<T> {
    this.assertIdle();
    const token = Symbol("restore");
    this.#wholeStoreOwner = token;
    let resolve!: () => void;
    this.#wholeStoreIdle = new Promise<void>((done) => {
      resolve = done;
    });
    try {
      return await work(token);
    } finally {
      this.#wholeStoreOwner = undefined;
      resolve();
      this.#wholeStoreIdle = undefined;
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
    const token = this.acquireWriter(spaceId);
    try {
      if (!(await this.ensure(spaceId))) throw new Error(`记忆空间不存在: ${spaceId}`);
      await this.client.begin(spaceId);
      return token;
    } catch (error) {
      this.releaseWriter(spaceId);
      throw error;
    }
  }

  async whenIdle(spaceId: string): Promise<void> {
    await this.#wholeStoreIdle;
    await this.#idle.get(spaceId)?.promise;
  }

  private releaseWriter(spaceId: string): void {
    this.#writers.delete(spaceId);
    this.#idle.get(spaceId)?.resolve();
    this.#idle.delete(spaceId);
  }

  async finish(spaceId: string, token: symbol, commit: boolean): Promise<void> {
    this.assertWritable(spaceId, token);
    try {
      if (commit) {
        try {
          await this.client.commit(spaceId);
        } catch (error) {
          await this.client.rollback(spaceId);
          throw error;
        }
        const snapshot = await this.client.exportSpace(spaceId);
        await this.cache(snapshot);
        await this.onCommitted(snapshot);
      } else await this.client.rollback(spaceId);
    } finally {
      this.releaseWriter(spaceId);
    }
  }

  async write<T>(spaceId: string, work: () => Promise<T>, token?: symbol): Promise<T> {
    this.assertWritable(spaceId, token);
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
    try {
      const result = await work();
      await this.client.commit(spaceId);
      committed = true;
      const snapshot = await this.client.exportSpace(spaceId);
      await this.cache(snapshot);
      await this.onCommitted(snapshot);
      return result;
    } catch (error) {
      if (!committed) await this.client.rollback(spaceId);
      else throw new MemoryCommitPersistenceError(error);
      throw error;
    } finally {
      this.releaseWriter(spaceId);
    }
  }

  async snapshot(spaceId: string): Promise<MemorySpaceBackup | undefined> {
    if (!(await this.ensure(spaceId))) return undefined;
    return this.client.exportSpace(spaceId);
  }

  /** Collapse tool-level revisions into the final task's single revision batch. */
  async consolidateTask(
    baseline: MemorySpaceBackup,
    token: symbol,
    revisionId: MemoryRevisionId,
    archivedAt: string,
  ): Promise<void> {
    // Empty evidence lists and map insertion order do not represent a memory change.
    const comparable = (record: MemoryRecord): MemoryRecord => ({
      ...record,
      payload: Object.fromEntries(
        Object.entries(record.payload).sort(([left], [right]) => left.localeCompare(right)),
      ),
      fieldEvidence: Object.fromEntries(
        Object.entries(record.fieldEvidence)
          .filter(([, evidence]) => evidence.length > 0)
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    });
    const id = baseline.space.id;
    this.assertWritable(id, token);
    const current = await this.client.exportSpace(id, "write");
    const previousRecords = new Map(baseline.records.map((record) => [record.id, record]));
    const records = new Map(current.records.map((record) => [record.id, record]));
    const oldHistoryIds = new Set(baseline.history.map((item) => item.id));
    const taskHistory = current.history.filter((item) => !oldHistoryIds.has(item.id));
    await this.write(
      id,
      async () => {
        for (const item of taskHistory) await this.client.deleteEntity(id, "history", item.id);
        for (const key of new Set([...previousRecords.keys(), ...records.keys()])) {
          const previous = previousRecords.get(key);
          const record = records.get(key);
          if (previous && record && sameMemory(comparable(previous), comparable(record))) {
            if (previous.revisionId !== record.revisionId)
              await this.client.putEntity(id, "record", previous);
            continue;
          }
          if (record)
            await this.client.putEntity(id, "record", {
              ...record,
              revisionId,
              revisionSource: "agent",
            });
          if (previous) {
            const first = taskHistory.find((item) => item.recordId === key);
            if (!first) throw new Error("任务修订缺少原记录历史");
            const history: MemoryRecordHistory = {
              ...first,
              payload: previous.payload,
              fieldEvidence: previous.fieldEvidence,
              displayText: previous.displayText,
              source: previous.source,
              previousRevisionId: previous.revisionId,
              previousRevisionSource: previous.revisionSource,
              createdAt: previous.createdAt,
              updatedAt: previous.updatedAt,
              revisionId,
              revisionSource: "agent",
              archivedAt,
            };
            await this.client.putEntity(id, "history", history);
          }
        }
        const referencedEvidence = new Set(
          current.records.flatMap((record) =>
            Object.values(record.fieldEvidence)
              .flat()
              .map((item) => item.evidence_id),
          ),
        );
        const oldEvidenceIds = new Set(baseline.evidence.map((item) => item.evidence_id));
        for (const item of current.evidence) {
          if (!oldEvidenceIds.has(item.evidence_id) && !referencedEvidence.has(item.evidence_id))
            await this.client.deleteEntity(id, "evidence", item.evidence_id);
        }
      },
      token,
    );
  }

  async unload(spaceId: string, token?: symbol): Promise<void> {
    this.assertWritable(spaceId, token);
    if (!this.#loaded.has(spaceId)) return;
    await this.client.removeSpace(spaceId);
    this.#loaded.delete(spaceId);
  }

  async cache(unit: MemorySpaceBackup): Promise<void> {
    const id = unit.space.id;
    // Do not use restoreSpace: that operation intentionally deletes vector data.
    await this.#db.transaction(
      "rw",
      [
        this.#db.memorySpaces,
        this.#db.memoryTables,
        this.#db.memoryFields,
        this.#db.memoryRecords,
        this.#db.memoryRecordHistory,
        this.#db.memoryEvidence,
      ],
      async () => {
        await this.#db.memorySpaces.put(unit.space);
        await syncRows(
          this.#db.memoryTables,
          unit.tables,
          await this.#db.memoryTables.where("memorySpaceId").equals(id).toArray(),
        );
        await syncRows(
          this.#db.memoryFields,
          unit.fields,
          await this.#db.memoryFields.filter((field) => field.memorySpaceId === id).toArray(),
        );
        await syncRows(
          this.#db.memoryRecords,
          unit.records,
          await this.#db.memoryRecords.where("memorySpaceId").equals(id).toArray(),
        );
        await syncRows(
          this.#db.memoryRecordHistory,
          unit.history,
          await this.#db.memoryRecordHistory.where("memorySpaceId").equals(id).toArray(),
        );
        await syncRows(
          this.#db.memoryEvidence,
          unit.evidence.map((item) => toEvidenceRow(id, item)),
          await this.#db.memoryEvidence.where("memorySpaceId").equals(id).toArray(),
        );
      },
    );
  }

  repositories(view: SqliteView = "committed", token?: symbol): SqliteRepositories {
    const client = this.client;
    const get: SqliteMemoryClient["getEntity"] = async (id, kind, key) =>
      (await this.ensure(id)) ? client.getEntity(id, kind, key, view) : undefined;
    const list: SqliteMemoryClient["listEntities"] = async (id, kind) =>
      (await this.ensure(id)) ? client.listEntities(id, kind, view) : [];
    const save: SqliteMemoryClient["putEntity"] = (id, kind, entity) =>
      this.write(id, () => client.putEntity(id, kind, entity), token);
    const erase = (
      id: string,
      kind: Parameters<SqliteMemoryClient["deleteEntity"]>[1],
      key: string,
    ) => client.deleteEntity(id, kind, key);
    const deleteTable = async (id: string, tableId: string) => {
      for (const field of await list(id, "field"))
        if (field.tableId === tableId) await erase(id, "field", field.id);
      for (const record of await list(id, "record"))
        if (record.tableId === tableId) await erase(id, "record", record.id);
      for (const history of await list(id, "history"))
        if (history.tableId === tableId) await erase(id, "history", history.id);
      await erase(id, "table", tableId);
    };
    const spaces: MemorySpaceRepository = {
      create: async (space) => {
        this.assertWritable(space.id);
        if (await this.#db.memorySpaces.get(space.id)) throw new Error("记忆空间 ID 已存在");
        await this.replace({
          space,
          tables: [],
          fields: [],
          records: [],
          history: [],
          evidence: [],
        });
      },
      find: (id) => get(id, "space", id),
      list: async () =>
        (await this.#db.memorySpaces.toArray()).sort(
          (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
        ),
      setMacros: async (id, macros, updatedAt) => {
        return this.write(
          id,
          async () => {
            const current = await get(id, "space", id);
            if (!current) return undefined;
            const next = { ...current, macros: parseMemoryMacros(macros), updatedAt };
            await client.putEntity(id, "space", next);
            return next;
          },
          token,
        );
      },
      rename: async (id, name, updatedAt) => {
        const current = await get(id, "space", id);
        if (!current) return undefined;
        const next = { ...current, name, updatedAt };
        await save(id, "space", next);
        return next;
      },
      delete: async (id) => {
        this.assertWritable(id, token);
        if (!(await get(id, "space", id))) return false;
        await this.client.removeSpace(id);
        this.#loaded.delete(id);
        // Auxiliary task/vector deletion remains the responsibility of the local storage adapter.
        const { DexieMemorySpaceRepository } =
          await import("../indexeddb/memory/memory-space-repository.ts");
        return new DexieMemorySpaceRepository(this.#db).delete(id);
      },
      clearRecords: async (id) => {
        if (!(await get(id, "space", id))) return false;
        return this.write(
          id,
          async () => {
            for (const kind of ["record", "history", "evidence"] as const) {
              for (const item of await list(id, kind))
                await erase(id, kind, "evidence_id" in item ? item.evidence_id : item.id);
            }
            return true;
          },
          token,
        );
      },
      deleteAllTables: async (id) => {
        if (!(await get(id, "space", id))) return false;
        return this.write(
          id,
          async () => {
            for (const table of await list(id, "table")) await deleteTable(id, table.id);
            for (const item of await list(id, "evidence"))
              await erase(id, "evidence", item.evidence_id);
            return true;
          },
          token,
        );
      },
    };
    const tables: MemoryTableRepository = {
      create: (table) => save(table.memorySpaceId, "table", table),
      find: (id, key) => get(id, "table", key),
      findByKey: async (id, key) => (await list(id, "table")).find((item) => item.key === key),
      list: async (id) =>
        (await list(id, "table")).sort(
          (a, b) => a.position - b.position || a.id.localeCompare(b.id),
        ),
      update: async (table) => {
        if (!(await get(table.memorySpaceId, "table", table.id))) return false;
        await save(table.memorySpaceId, "table", table);
        return true;
      },
      delete: async (id, key) => {
        if (!(await get(id, "table", key))) return false;
        return this.write(
          id,
          async () => {
            await deleteTable(id, key);
            return true;
          },
          token,
        );
      },
    };
    const fields: MemoryFieldRepository = {
      create: (field) => save(field.memorySpaceId, "field", field),
      find: async (id, tableId, key) => {
        const field = await get(id, "field", key);
        return field?.tableId === tableId ? field : undefined;
      },
      findByKey: async (id, tableId, key) =>
        (await list(id, "field")).find((item) => item.tableId === tableId && item.key === key),
      list: async (id, tableId) =>
        (await list(id, "field"))
          .filter((item) => item.tableId === tableId)
          .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
      update: async (field) => {
        if (!(await get(field.memorySpaceId, "field", field.id))) return false;
        await save(field.memorySpaceId, "field", field);
        return true;
      },
      delete: async (id, tableId, key) => {
        const field = await get(id, "field", key);
        if (field?.tableId !== tableId) return false;
        return this.write(
          id,
          async () => {
            await erase(id, "field", key);
            return true;
          },
          token,
        );
      },
    };
    const records: SqliteRepositories["records"] = {
      create: (record, evidence) =>
        this.write(
          record.memorySpaceId,
          async () => {
            for (const item of evidence)
              await client.putEntity(record.memorySpaceId, "evidence", item);
            await client.putEntity(record.memorySpaceId, "record", record);
          },
          token,
        ),
      find: async (id, tableId, key) => {
        const record = await get(id, "record", key);
        return record?.tableId === tableId ? record : undefined;
      },
      list: async (id, tableId) =>
        (await list(id, "record")).filter((record) => record.tableId === tableId),
      commit: async (mutations, evidence) => {
        if (mutations.length === 0) return true;
        const id = spaceOf(mutations[0]!);
        let applied = false;
        try {
          return await this.write(
            id,
            async () => {
              for (const mutation of mutations) {
                if (spaceOf(mutation) !== id) throw new Error("一个记忆批次不能跨空间");
                if (mutation.kind === "replace") {
                  const current = await client.getEntity(
                    id,
                    "record",
                    mutation.previous.id,
                    "write",
                  );
                  if (current?.revisionId !== mutation.previous.revisionId) return false;
                }
              }
              for (const item of evidence) await client.putEntity(id, "evidence", item);
              for (const mutation of mutations) {
                if (mutation.kind === "replace")
                  await client.putEntity(id, "history", mutation.history);
                if (mutation.current) await client.putEntity(id, "record", mutation.current);
                else if (mutation.kind === "replace")
                  await erase(id, "record", mutation.previous.id);
              }
              applied = true;
              return true;
            },
            token,
          );
        } catch (error) {
          // A rejected optimistic lock committed no record changes. Preserve that result
          // even if persisting the unchanged snapshot also failed.
          if (!applied && error instanceof MemoryCommitPersistenceError) return false;
          throw error;
        }
      },
      listHistory: async (query) =>
        (await list(query.memorySpaceId, "history"))
          .filter((item) => historyMatches(item, query))
          .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt) || b.id.localeCompare(a.id)),
      findEvidence: async (id, sourceType, sourceId) =>
        (await list(id, "evidence")).find(
          (item) => item.source_type === sourceType && item.source_id === sourceId,
        ),
    };
    return { spaces, tables, fields, records };
  }

  structureRebuild(): SpaceStructureRebuild {
    return {
      rebuild: async (input) => {
        const id = input.memorySpaceId;
        const token = this.acquireWriter(id);
        try {
          const unit = await this.snapshot(id);
          if (!unit) return false;
          await this.replace(
            {
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
            },
            token,
          );
          await this.#db.transaction(
            "rw",
            [
              this.#db.memoryFillTasks,
              this.#db.floorFillLedger,
              this.#db.vectorTasks,
              this.#db.recordVectors,
              this.#db.vectorSuppressions,
            ],
            async () => {
              for (const table of [
                this.#db.memoryFillTasks,
                this.#db.floorFillLedger,
                this.#db.vectorTasks,
                this.#db.recordVectors,
                this.#db.vectorSuppressions,
              ])
                await table.where("memorySpaceId").equals(id).delete();
            },
          );
          await this.onCommitted((await this.snapshot(id))!);
          return true;
        } finally {
          this.releaseWriter(id);
        }
      },
    };
  }
}

/** Preserve unchanged rows: delete hooks intentionally purge derived vectors. */
async function syncRows<T extends { readonly id: string }, K extends string>(
  table: Table<T, K>,
  next: readonly T[],
  previous: readonly T[],
): Promise<void> {
  const old = new Map(previous.map((item) => [item.id, item]));
  const remaining = new Set(next.map((item) => item.id));
  await table.bulkDelete(
    previous.filter((item) => !remaining.has(item.id)).map((item) => item.id as K),
  );
  await table.bulkPut(
    next.filter((item) => JSON.stringify(old.get(item.id)) !== JSON.stringify(item)),
  );
}

function spaceOf(mutation: MemoryRecordMutation): MemorySpaceId {
  return mutation.kind === "create"
    ? mutation.current.memorySpaceId
    : mutation.previous.memorySpaceId;
}

function sameMemory(left: MemoryRecord, right: MemoryRecord): boolean {
  return (
    JSON.stringify([left.payload, left.fieldEvidence, left.displayText, left.source]) ===
    JSON.stringify([right.payload, right.fieldEvidence, right.displayText, right.source])
  );
}

function historyMatches(
  item: Awaited<ReturnType<MemoryRecordRepository["listHistory"]>>[number],
  query: MemoryRecordHistoryQuery,
): boolean {
  return (
    (query.tableId === undefined || item.tableId === query.tableId) &&
    (query.recordId === undefined || item.recordId === query.recordId) &&
    (query.revisionId === undefined || item.revisionId === query.revisionId) &&
    (query.archivedFrom === undefined || item.archivedAt >= query.archivedFrom) &&
    (query.archivedTo === undefined || item.archivedAt <= query.archivedTo)
  );
}
