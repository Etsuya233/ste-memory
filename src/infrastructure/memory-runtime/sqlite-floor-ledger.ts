import type { MemorySpaceId } from "../../features/memory/index.ts";
import type {
  FloorLedgerEntry,
  FloorLedgerRepository,
} from "../../features/fill-tasks/fill-task.ts";
import type { SqliteMemoryStore } from "./sqlite-memory-store.ts";

/** 楼层进度属于空间领域内容；批次使用其 writer，手动修改独立提交完整快照。 */
export class SqliteFloorLedger implements FloorLedgerRepository {
  private readonly memory: SqliteMemoryStore;
  private readonly now: () => string;
  private readonly token?: symbol;
  constructor(memory: SqliteMemoryStore, now: () => string, token?: symbol) {
    this.memory = memory;
    this.now = now;
    this.token = token;
  }

  markProcessed(id: MemorySpaceId, floors: readonly number[]): Promise<void> {
    return this.mark(id, floors, "processed");
  }

  markError(id: MemorySpaceId, floors: readonly number[]): Promise<void> {
    return this.mark(id, floors, "error");
  }

  private mark(
    id: MemorySpaceId,
    floors: readonly number[],
    status: "processed" | "error",
  ): Promise<void> {
    return this.memory.write(
      id,
      async () => {
        const updatedAt = this.now();
        for (const floor of floors) {
          await this.memory.client.putEntity(id, "floor", {
            id: String(floor),
            floor,
            status,
            updatedAt,
          });
        }
      },
      this.token,
    );
  }

  async statuses(
    id: MemorySpaceId,
    from: number,
    to: number,
  ): Promise<readonly FloorLedgerEntry[]> {
    const rows = await this.memory.client.listEntities(id, "floor");
    const stored = new Map(rows.map((row) => [row.floor, row.status]));
    return Array.from({ length: Math.max(0, to - from + 1) }, (_, offset) => ({
      floor: from + offset,
      status: stored.get(from + offset) ?? "untracked",
    }));
  }

  async processedCount(id: MemorySpaceId, from: number, to: number): Promise<number> {
    return (await this.statuses(id, from, to)).filter((row) => row.status === "processed").length;
  }

  deleteStatuses(id: MemorySpaceId, from: number, to: number): Promise<void> {
    return this.memory.write(
      id,
      async () => {
        const rows = await this.memory.client.listEntities(id, "floor", "write");
        for (const row of rows) {
          if (row.floor >= from && row.floor <= to) {
            await this.memory.client.deleteEntity(id, "floor", row.id);
          }
        }
      },
      this.token,
    );
  }

  clear(id: MemorySpaceId): Promise<void> {
    return this.deleteStatuses(id, 0, Number.MAX_SAFE_INTEGER);
  }
}
