import type {
  SpaceStructureRebuild,
  SpaceStructureRebuildInput,
} from "../../../features/space-maintenance/space-structure-rebuild.ts";
import type { SteMemoryDatabase } from "../database.ts";
import type { DexieMemorySpaceRepository } from "../memory/memory-space-repository.ts";

/**
 * 空间结构重建的 Dexie 实现（spec 10.3）：八张表（空间/表格/字段/记录/历史/
 * 证据/填表任务/楼层台账）在同一读写事务内清空并重建，任一步失败整体回滚。
 *
 * 事务范围刻意覆盖 memoryFillTasks 与 floorFillLedger：填表任务的批次提交
 * （ticket 13 的 runInTransaction）在同一事务内复检任务行——重建删除任务行与
 * 批次提交在任务表上互斥，旧任务在重建后不可能再写入（AC-12）。
 */
export class DexieSpaceStructureRebuild implements SpaceStructureRebuild {
  readonly #db: SteMemoryDatabase;
  readonly #spaces: DexieMemorySpaceRepository;

  constructor(db: SteMemoryDatabase, spaces: DexieMemorySpaceRepository) {
    this.#db = db;
    this.#spaces = spaces;
  }

  async rebuild(input: SpaceStructureRebuildInput): Promise<boolean> {
    const memorySpaceId = input.memorySpaceId;
    return this.#db.transaction(
      "rw",
      [
        this.#db.memorySpaces,
        this.#db.memoryTables,
        this.#db.memoryFields,
        this.#db.memoryRecords,
        this.#db.memoryRecordHistory,
        this.#db.memoryEvidence,
        this.#db.memoryFillTasks,
        this.#db.floorFillLedger,
        this.#db.vectorTasks,
        this.#db.recordVectors,
        this.#db.vectorSuppressions,
      ],
      async () => {
        if (!(await this.#db.memorySpaces.get(memorySpaceId))) return false;
        // 任务与进度先清：进度台账标记（提交回滚点）不属于重建后空间
        await this.#db.memoryFillTasks.where("memorySpaceId").equals(memorySpaceId).delete();
        await this.#db.floorFillLedger.where("memorySpaceId").equals(memorySpaceId).delete();
        await this.#db.vectorTasks.where("memorySpaceId").equals(memorySpaceId).delete();
        await this.#db.recordVectors.where("memorySpaceId").equals(memorySpaceId).delete();
        await this.#db.vectorSuppressions.where("memorySpaceId").equals(memorySpaceId).delete();
        // 表格删除级联字段/记录/历史；证据按空间删除
        await this.#spaces.deleteAllTables(memorySpaceId);
        if (input.tables.length > 0) await this.#db.memoryTables.bulkAdd([...input.tables]);
        if (input.fields.length > 0) await this.#db.memoryFields.bulkAdd([...input.fields]);
        await this.#db.memorySpaces.update(memorySpaceId, {
          prompt: input.prompt ?? "",
          initializationSource: input.initializationSource,
          updatedAt: input.initializationSource.appliedAt,
        });
        return true;
      },
    );
  }
}
