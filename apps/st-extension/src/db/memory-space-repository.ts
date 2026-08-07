import type { MemorySpace, MemorySpaceId } from "@ste-memory/core/memory";
import type { MemorySpaceRepository } from "@ste-memory/core/memory/adapter";
import type { SteMemoryDatabase } from "./database.ts";

/** core MemorySpaceRepository 端口的 Dexie（IndexedDB）实现（ADR 0002）。 */
export class DexieMemorySpaceRepository implements MemorySpaceRepository {
  readonly #db: SteMemoryDatabase;

  constructor(db: SteMemoryDatabase) {
    this.#db = db;
  }

  async create(memorySpace: MemorySpace): Promise<void> {
    await this.#db.memorySpaces.add(memorySpace);
  }

  async delete(id: MemorySpaceId): Promise<boolean> {
    // 与 SQLite 参照实现的 ON DELETE CASCADE 同语义：删空间连带删其表格与字段
    return this.#db.transaction(
      "rw",
      [this.#db.memorySpaces, this.#db.memoryTables, this.#db.memoryFields],
      async () => {
        const space = await this.#db.memorySpaces.get(id);
        if (!space) return false;
        const tables = await this.#db.memoryTables.where("memorySpaceId").equals(id).toArray();
        for (const table of tables) {
          await this.#db.memoryFields
            .where("[memorySpaceId+tableId]")
            .equals([id, table.id])
            .delete();
        }
        await this.#db.memoryTables.where("memorySpaceId").equals(id).delete();
        await this.#db.memorySpaces.delete(id);
        return true;
      },
    );
  }

  async find(id: MemorySpaceId): Promise<MemorySpace | undefined> {
    return this.#db.memorySpaces.get(id);
  }

  async list(): Promise<MemorySpace[]> {
    const spaces = await this.#db.memorySpaces.toArray();
    // 与 SQLite 参照实现同语义：创建时间倒序（id 兜底，保证确定性）
    return spaces.sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );
  }

  async rename(
    id: MemorySpaceId,
    name: string,
    updatedAt: string,
  ): Promise<MemorySpace | undefined> {
    const count = await this.#db.memorySpaces.update(id, { name, updatedAt });
    return count > 0 ? this.find(id) : undefined;
  }
}
