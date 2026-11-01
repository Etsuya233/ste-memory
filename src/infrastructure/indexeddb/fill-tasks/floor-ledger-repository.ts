import type { MemorySpaceId } from "../../../features/memory/index.ts";
import type {
  FloorLedgerEntry,
  FloorLedgerRepository,
} from "../../../features/fill-tasks/fill-task.ts";
import type { FloorLedgerRow, SteMemoryDatabase } from "../database.ts";

/** 楼层台账行 id：`${memorySpaceId}:${floor}`（唯一索引键的一部分，防跨空间冲突）。 */
function ledgerRowId(memorySpaceId: MemorySpaceId, floor: number): string {
  return `${memorySpaceId}:${floor}`;
}

export class DexieFloorLedgerRepository implements FloorLedgerRepository {
  readonly #db: SteMemoryDatabase;
  readonly #now: () => string;

  constructor(db: SteMemoryDatabase, now: () => string = () => new Date().toISOString()) {
    this.#db = db;
    this.#now = now;
  }

  async markProcessed(memorySpaceId: MemorySpaceId, floors: readonly number[]): Promise<void> {
    await this.#upsert(memorySpaceId, floors, "processed");
  }

  async markError(memorySpaceId: MemorySpaceId, floors: readonly number[]): Promise<void> {
    await this.#upsert(memorySpaceId, floors, "error");
  }

  async statuses(
    memorySpaceId: MemorySpaceId,
    from: number,
    to: number,
  ): Promise<readonly FloorLedgerEntry[]> {
    const rows = await this.#db.floorFillLedger
      .where("[memorySpaceId+floor]")
      // Dexie 4.4：between 默认上界开（includeUpper === true 才闭），闭区间必须显式传 true, true
      .between([memorySpaceId, from], [memorySpaceId, to], true, true)
      .toArray();
    const byFloor = new Map(rows.map((row) => [row.floor, row.status]));
    const entries: FloorLedgerEntry[] = [];
    for (let floor = from; floor <= to; floor += 1) {
      entries.push({ floor, status: byFloor.get(floor) ?? "untracked" });
    }
    return entries;
  }

  async processedCount(memorySpaceId: MemorySpaceId, from: number, to: number): Promise<number> {
    const statuses = await this.statuses(memorySpaceId, from, to);
    return statuses.filter((entry) => entry.status === "processed").length;
  }

  async deleteStatuses(memorySpaceId: MemorySpaceId, from: number, to: number): Promise<void> {
    await this.#db.floorFillLedger
      .where("[memorySpaceId+floor]")
      .between([memorySpaceId, from], [memorySpaceId, to], true, true)
      .delete();
  }

  /** 清除空间记录/重置空间（spec reset-space）：删除该空间全部台账行。 */
  async clear(memorySpaceId: MemorySpaceId): Promise<void> {
    await this.#db.floorFillLedger.where("memorySpaceId").equals(memorySpaceId).delete();
  }

  async #upsert(
    memorySpaceId: MemorySpaceId,
    floors: readonly number[],
    status: Exclude<FloorLedgerEntry["status"], "untracked">,
  ): Promise<void> {
    const updatedAt = this.#now();
    const rows: FloorLedgerRow[] = floors.map((floor) => ({
      id: ledgerRowId(memorySpaceId, floor),
      memorySpaceId,
      floor,
      status,
      updatedAt,
    }));
    await this.#db.floorFillLedger.bulkPut(rows);
  }
}
