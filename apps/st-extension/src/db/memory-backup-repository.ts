import type {
  MemoryBackupRepository,
  MemoryBackupSnapshot,
  MemorySpaceBackup,
} from "@ste-memory/core/memory/export";
import type { SteMemoryDatabase } from "./database.ts";
import { toDomainEvidence, toEvidenceRow } from "./evidence-conversion.ts";

/**
 * core MemoryBackupRepository 端口的 Dexie（IndexedDB）实现（ADR 0002 / 0021）。
 *
 * - loadSnapshot：读全部六张表，把证据行还原为领域对象（evidence_id / 去掉
 *   memorySpaceId 包装），按空间分组；各数组按 id 排序保证确定性。
 * - restoreSnapshot：整体替换——六张表清空后按空间单元依次写入，全部包在
 *   同一个读写事务里：任一步失败（如主键冲突）整体回滚，绝不产生半导入状态
 *   （导入前校验由 core codec 负责，这里只兜底物理约束）。
 */
export class DexieMemoryBackupRepository implements MemoryBackupRepository {
  readonly #db: SteMemoryDatabase;

  constructor(db: SteMemoryDatabase) {
    this.#db = db;
  }

  async loadSnapshot(): Promise<MemoryBackupSnapshot> {
    const [spaces, tables, fields, records, history, evidenceRows] = await Promise.all([
      this.#db.memorySpaces.toArray(),
      this.#db.memoryTables.toArray(),
      this.#db.memoryFields.toArray(),
      this.#db.memoryRecords.toArray(),
      this.#db.memoryRecordHistory.toArray(),
      this.#db.memoryEvidence.toArray(),
    ]);
    const sorted = {
      spaces: [...spaces].sort((left, right) => left.id.localeCompare(right.id)),
      tables: [...tables].sort((left, right) => left.id.localeCompare(right.id)),
      fields: [...fields].sort((left, right) => left.id.localeCompare(right.id)),
      records: [...records].sort((left, right) => left.id.localeCompare(right.id)),
      history: [...history].sort((left, right) => left.id.localeCompare(right.id)),
      evidence: [...evidenceRows].sort((left, right) => left.id.localeCompare(right.id)),
    };
    return {
      spaces: sorted.spaces.map((space) => ({
        space,
        tables: sorted.tables.filter((table) => table.memorySpaceId === space.id),
        fields: sorted.fields.filter((field) => field.memorySpaceId === space.id),
        records: sorted.records.filter((record) => record.memorySpaceId === space.id),
        history: sorted.history.filter((item) => item.memorySpaceId === space.id),
        evidence: sorted.evidence
          .filter((row) => row.memorySpaceId === space.id)
          .map(toDomainEvidence),
      })),
    };
  }

  async restoreSnapshot(snapshot: MemoryBackupSnapshot): Promise<void> {
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
        await Promise.all([
          this.#db.memorySpaces.clear(),
          this.#db.memoryTables.clear(),
          this.#db.memoryFields.clear(),
          this.#db.memoryRecords.clear(),
          this.#db.memoryRecordHistory.clear(),
          this.#db.memoryEvidence.clear(),
        ]);
        for (const unit of snapshot.spaces) {
          await this.#writeUnit(unit);
        }
      },
    );
  }

  /**
   * 按空间恢复单个单元（镜像恢复，ADR 0023）：先删该空间在六张表的全部行，
   * 再写入单元数据——只影响目标空间，其他空间原样保留；与 restoreSnapshot
   * 同事务语义：任一步失败整体回滚。
   */
  async restoreSpace(unit: MemorySpaceBackup): Promise<void> {
    const spaceId = unit.space.id;
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
        await Promise.all([
          this.#db.memorySpaces.where("id").equals(spaceId).delete(),
          this.#db.memoryTables.where("memorySpaceId").equals(spaceId).delete(),
          // memoryFields 无 memorySpaceId 索引：filter 删除（字段行数少，与
          // DexieSyncChangeSource 同口径，v1 可接受）
          this.#db.memoryFields.filter((field) => field.memorySpaceId === spaceId).delete(),
          this.#db.memoryRecords.where("memorySpaceId").equals(spaceId).delete(),
          this.#db.memoryRecordHistory.where("memorySpaceId").equals(spaceId).delete(),
          this.#db.memoryEvidence.where("memorySpaceId").equals(spaceId).delete(),
        ]);
        await this.#writeUnit(unit);
      },
    );
  }

  /** 写入单个空间单元（restoreSnapshot / restoreSpace 共用；调用方已包事务）。 */
  async #writeUnit(unit: MemorySpaceBackup): Promise<void> {
    await this.#db.memorySpaces.add(unit.space);
    if (unit.tables.length > 0) await this.#db.memoryTables.bulkAdd([...unit.tables]);
    if (unit.fields.length > 0) await this.#db.memoryFields.bulkAdd([...unit.fields]);
    if (unit.records.length > 0) await this.#db.memoryRecords.bulkAdd([...unit.records]);
    if (unit.history.length > 0) {
      await this.#db.memoryRecordHistory.bulkAdd([...unit.history]);
    }
    if (unit.evidence.length > 0) {
      await this.#db.memoryEvidence.bulkAdd(
        unit.evidence.map((evidence) => toEvidenceRow(unit.space.id, evidence)),
      );
    }
  }
}
