import type { SteMemoryDatabase } from "./database.ts";
import type { SpaceFingerprint, SyncChangeSource } from "../cloud/space-fingerprint.ts";

/**
 * 云同步变更来源的 Dexie 实现（ADR 0002）：空间 id 清单 + 逐空间指纹。
 *
 * - 行数：各表按 memorySpaceId 过滤后计数（memoryFields 无 memorySpaceId
 *   索引，用 filter 全表扫——字段行数少，v1 可接受）；
 * - 最大 updatedAt：空间/表格/字段/记录/历史五处取最大（记录与历史的
 *   updatedAt 由 core 服务在每次提交时刷新，能反映全部数据变更）；
 *   记录/历史行整体读入求 max——个人记忆库行数少，2s 轮询可接受，
 *   规模增长时改索引键前缀范围查询。
 */
export class DexieSyncChangeSource implements SyncChangeSource {
  readonly #db: SteMemoryDatabase;

  constructor(db: SteMemoryDatabase) {
    this.#db = db;
  }

  async listSpaceIds(): Promise<readonly string[]> {
    const spaces = await this.#db.memorySpaces.toArray();
    return spaces.map((space) => space.id).sort((left, right) => left.localeCompare(right));
  }

  async fingerprint(spaceId: string): Promise<SpaceFingerprint> {
    const [spaces, tables, fields, records, history, evidenceCount] = await Promise.all([
      this.#db.memorySpaces.where("id").equals(spaceId).toArray(),
      this.#db.memoryTables.where("memorySpaceId").equals(spaceId).toArray(),
      this.#db.memoryFields.filter((field) => field.memorySpaceId === spaceId).toArray(),
      this.#db.memoryRecords.where("memorySpaceId").equals(spaceId).toArray(),
      this.#db.memoryRecordHistory.where("memorySpaceId").equals(spaceId).toArray(),
      this.#db.memoryEvidence.where("memorySpaceId").equals(spaceId).count(),
    ]);

    let updatedAt = "";
    for (const entity of [...spaces, ...tables, ...fields, ...records, ...history]) {
      if (entity.updatedAt > updatedAt) updatedAt = entity.updatedAt;
    }

    return {
      tables: tables.length,
      fields: fields.length,
      records: records.length,
      history: history.length,
      evidence: evidenceCount,
      updatedAt,
    };
  }
}
