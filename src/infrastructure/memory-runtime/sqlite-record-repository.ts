import { MemoryCommitPersistenceError } from "../../features/memory/index.ts";
import type {
  MemoryRecord,
  MemoryRecordHistory,
  MemoryRecordId,
  MemoryTableId,
  MemoryEvidence,
  MemoryRecordMutation,
  MemoryRecordHistoryQuery,
  MemorySpaceId,
  MemoryRecordRepository,
  MemoryEvidenceRepository,
} from "../../features/memory/index.ts";
import type { SqliteRepositoryView } from "./sqlite-repository-view.ts";

/** 一个批次先校验全部修订，再统一写证据、历史与最终记录，保持乐观锁的整体语义。 */
export class SqliteRecordRepository implements MemoryRecordRepository, MemoryEvidenceRepository {
  private readonly context: SqliteRepositoryView;

  constructor(context: SqliteRepositoryView) {
    this.context = context;
  }

  create(record: MemoryRecord, evidence: readonly MemoryEvidence[]): Promise<void> {
    const { memory, client, token } = this.context;
    return memory.write(
      record.memorySpaceId,
      async () => {
        for (const item of evidence) {
          await client.putEntity(record.memorySpaceId, "evidence", item);
        }
        await client.putEntity(record.memorySpaceId, "record", record);
      },
      token,
    );
  }

  async find(
    id: MemorySpaceId,
    tableId: MemoryTableId,
    key: MemoryRecordId,
  ): Promise<MemoryRecord | undefined> {
    const record = await this.context.get(id, "record", key);
    return record?.tableId === tableId ? record : undefined;
  }

  async list(id: MemorySpaceId, tableId: MemoryTableId): Promise<MemoryRecord[]> {
    return (await this.context.list(id, "record")).filter((record) => record.tableId === tableId);
  }

  async commit(
    mutations: readonly MemoryRecordMutation[],
    evidence: readonly MemoryEvidence[],
  ): Promise<boolean> {
    if (mutations.length === 0) {
      return true;
    }
    const id = spaceOf(mutations[0]!);
    const { memory, token } = this.context;
    let applied = false;
    try {
      return await memory.write(
        id,
        async () => {
          if (!(await this.revisionsMatch(id, mutations))) {
            return false;
          }
          await this.writeMutations(id, mutations, evidence);
          applied = true;
          return true;
        },
        token,
      );
    } catch (error) {
      // 修订冲突未写入任何记录；即使保存未变快照失败，领域结果仍保留冲突。
      if (!applied && error instanceof MemoryCommitPersistenceError) {
        return false;
      }
      throw error;
    }
  }

  async listHistory(query: MemoryRecordHistoryQuery): Promise<MemoryRecordHistory[]> {
    return (await this.context.list(query.memorySpaceId, "history"))
      .filter((item) => historyMatches(item, query))
      .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt) || b.id.localeCompare(a.id));
  }

  async findEvidence(
    id: MemorySpaceId,
    sourceType: string,
    sourceId: string | number,
  ): Promise<MemoryEvidence | undefined> {
    return (await this.context.list(id, "evidence")).find(
      (item) => item.source_type === sourceType && item.source_id === sourceId,
    );
  }

  private async revisionsMatch(
    id: MemorySpaceId,
    mutations: readonly MemoryRecordMutation[],
  ): Promise<boolean> {
    for (const mutation of mutations) {
      if (spaceOf(mutation) !== id) {
        throw new Error("一个记忆批次不能跨空间");
      }
      if (mutation.kind === "replace") {
        // 必须读 writer 视图，让同批内的后续工具校验前一个工具刚写入的修订。
        const current = await this.context.client.getEntity(
          id,
          "record",
          mutation.previous.id,
          "write",
        );
        if (current?.revisionId !== mutation.previous.revisionId) {
          return false;
        }
      }
    }
    return true;
  }

  private async writeMutations(
    id: MemorySpaceId,
    mutations: readonly MemoryRecordMutation[],
    evidence: readonly MemoryEvidence[],
  ): Promise<void> {
    const { client, erase } = this.context;
    for (const item of evidence) {
      await client.putEntity(id, "evidence", item);
    }
    for (const mutation of mutations) {
      if (mutation.kind === "replace") {
        await client.putEntity(id, "history", mutation.history);
      }
      if (mutation.current) {
        await client.putEntity(id, "record", mutation.current);
      } else if (mutation.kind === "replace") {
        await erase(id, "record", mutation.previous.id);
      }
    }
  }
}

function spaceOf(mutation: MemoryRecordMutation): MemorySpaceId {
  return mutation.kind === "create"
    ? mutation.current.memorySpaceId
    : mutation.previous.memorySpaceId;
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
