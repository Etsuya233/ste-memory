import { Dexie } from "dexie";
import type {
  MemoryEvidence,
  MemoryRecord,
  MemoryRecordHistory,
  MemoryRecordId,
  MemorySpaceId,
  MemoryTableId,
} from "@ste-memory/core/memory";
import type {
  MemoryEvidenceRepository,
  MemoryRecordHistoryQuery,
  MemoryRecordMutation,
  MemoryRecordRepository,
} from "@ste-memory/core/memory/adapter";
import type { SteMemoryDatabase } from "./database.ts";
import { toDomainEvidence, toEvidenceRow } from "./evidence-conversion.ts";

/** 事务内乐观锁失效（记录已被其他变更更新）：提交整体回滚，commit 返回 false。 */
class StaleRecordError extends Error {}

/**
 * core MemoryRecordRepository / MemoryEvidenceRepository 端口的 Dexie（IndexedDB）
 * 实现（ADR 0002）。
 *
 * - 作用域规则：find 以「id 命中 + 空间/表格匹配」为准，跨空间或跨表一律未命中
 *   （与 SQLite 参照实现同语义）。
 * - create/commit 把记录写入与证据写入包在同一个读写事务里：任一步失败整批回滚
 *   （与参照实现 UnitOfWork 同语义，field-evidence 测试验证过「失败请求不残留
 *   孤儿证据」）。
 * - commit 的乐观锁与参照实现同语义：replace 变更新旧状态历史快照后，仅当当前
 *   记录的 revisionId 仍等于 previous.revisionId 才写入/删除，否则回滚返回 false，
 *   core 服务层把它转成 memory_record_revision_conflict。
 */
export class DexieMemoryRecordRepository
  implements MemoryRecordRepository, MemoryEvidenceRepository
{
  readonly #db: SteMemoryDatabase;

  constructor(db: SteMemoryDatabase) {
    this.#db = db;
  }

  async create(record: MemoryRecord, evidence: readonly MemoryEvidence[]): Promise<void> {
    await this.#db.transaction(
      "rw",
      [this.#db.memoryRecords, this.#db.memoryEvidence],
      async () => {
        await this.#saveEvidence(record.memorySpaceId, evidence);
        await this.#db.memoryRecords.add(record);
      },
    );
  }

  async find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryRecordId,
  ): Promise<MemoryRecord | undefined> {
    const record = await this.#db.memoryRecords.get(id);
    return record?.memorySpaceId === memorySpaceId && record.tableId === tableId
      ? record
      : undefined;
  }

  async list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): Promise<MemoryRecord[]> {
    const records = await this.#db.memoryRecords
      .where("[memorySpaceId+tableId]")
      .equals([memorySpaceId, tableId])
      .toArray();
    // 与 SQLite 参照实现同语义：创建时间升序（id 兜底，保证确定性）
    return records.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  }

  async commit(
    mutations: readonly MemoryRecordMutation[],
    evidence: readonly MemoryEvidence[],
  ): Promise<boolean> {
    if (mutations.length === 0) return true;
    try {
      await this.#db.transaction(
        "rw",
        [this.#db.memoryRecords, this.#db.memoryRecordHistory, this.#db.memoryEvidence],
        async () => {
          const first = mutations[0]!;
          const memorySpaceId =
            first.kind === "create" ? first.current.memorySpaceId : first.previous.memorySpaceId;
          await this.#saveEvidence(memorySpaceId, evidence);
          for (const mutation of mutations) {
            if (mutation.kind === "create") {
              await this.#db.memoryRecords.add(mutation.current);
              continue;
            }
            // 乐观锁：与参照实现 update/delete 的 WHERE revision_id 同语义
            const current = await this.#db.memoryRecords.get(mutation.previous.id);
            if (
              !current ||
              current.memorySpaceId !== mutation.previous.memorySpaceId ||
              current.tableId !== mutation.previous.tableId ||
              current.revisionId !== mutation.previous.revisionId
            ) {
              throw new StaleRecordError();
            }
            await this.#db.memoryRecordHistory.add(mutation.history);
            if (mutation.current) await this.#db.memoryRecords.put(mutation.current);
            else await this.#db.memoryRecords.delete(mutation.previous.id);
          }
        },
      );
      return true;
    } catch (error) {
      if (error instanceof StaleRecordError) return false;
      throw error;
    }
  }

  async listHistory(query: MemoryRecordHistoryQuery): Promise<MemoryRecordHistory[]> {
    // 按最具体的索引收敛，剩余过滤条件（revisionId/时间窗）在内存过滤——
    // 与参照实现同样返回满足全部条件的历史，排序 archivedAt 倒序（id 兜底）。
    let rows: MemoryRecordHistory[];
    if (query.tableId !== undefined && query.recordId !== undefined) {
      rows = await this.#db.memoryRecordHistory
        .where("[memorySpaceId+tableId+recordId]")
        .equals([query.memorySpaceId, query.tableId, query.recordId])
        .toArray();
    } else if (query.tableId !== undefined) {
      rows = await this.#db.memoryRecordHistory
        .where("[memorySpaceId+tableId+recordId]")
        .between(
          [query.memorySpaceId, query.tableId, Dexie.minKey],
          [query.memorySpaceId, query.tableId, Dexie.maxKey],
        )
        .toArray();
    } else if (query.recordId !== undefined) {
      rows = await this.#db.memoryRecordHistory
        .where("[memorySpaceId+recordId]")
        .equals([query.memorySpaceId, query.recordId])
        .toArray();
    } else {
      rows = await this.#db.memoryRecordHistory
        .where("memorySpaceId")
        .equals(query.memorySpaceId)
        .toArray();
    }
    if (query.revisionId !== undefined) {
      rows = rows.filter((row) => row.revisionId === query.revisionId);
    }
    if (query.archivedFrom !== undefined) {
      rows = rows.filter((row) => row.archivedAt >= query.archivedFrom!);
    }
    if (query.archivedTo !== undefined) {
      rows = rows.filter((row) => row.archivedAt <= query.archivedTo!);
    }
    return rows.sort(
      (left, right) =>
        right.archivedAt.localeCompare(left.archivedAt) || left.id.localeCompare(right.id),
    );
  }

  async findEvidence(
    memorySpaceId: MemorySpaceId,
    sourceType: string,
    sourceId: string | number,
  ): Promise<MemoryEvidence | undefined> {
    const row = await this.#db.memoryEvidence
      .where("[memorySpaceId+source_type+source_id]")
      .equals([memorySpaceId, sourceType, sourceId])
      .first();
    if (!row) return undefined;
    // 与参照实现同语义：快照证据缺少正文视为存储损坏（toDomainEvidence 内置护栏）
    return toDomainEvidence(row);
  }

  async #saveEvidence(
    memorySpaceId: MemorySpaceId,
    evidenceEntries: readonly MemoryEvidence[],
  ): Promise<void> {
    for (const evidence of evidenceEntries) {
      await this.#db.memoryEvidence.add(toEvidenceRow(memorySpaceId, evidence));
    }
  }
}
