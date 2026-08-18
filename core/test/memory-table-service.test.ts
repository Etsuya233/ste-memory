import {
  MemoryTableService,
  type MemorySpace,
  type MemorySpaceId,
  type MemoryTable,
  type MemoryTableId,
  type MemoryTableKey,
} from "../src/memory/index.ts";
import type { MemorySpaceRepository, MemoryTableRepository } from "../src/memory/adapter.ts";
import { describe, expect, it } from "vitest";

class MemoryRepository implements MemorySpaceRepository, MemoryTableRepository {
  readonly spaces = new Map<MemorySpaceId, MemorySpace>();
  readonly tables = new Map<MemoryTableId, MemoryTable>();

  create(memorySpace: MemorySpace): Promise<void>;
  create(memoryTable: MemoryTable): Promise<void>;
  async create(value: MemorySpace | MemoryTable): Promise<void> {
    if ("memorySpaceId" in value) this.tables.set(value.id, value);
    else this.spaces.set(value.id, value);
  }

  delete(id: MemorySpaceId): Promise<boolean>;
  delete(memorySpaceId: MemorySpaceId, id: MemoryTableId): Promise<boolean>;
  async delete(memorySpaceId: MemorySpaceId, tableId?: MemoryTableId): Promise<boolean> {
    if (tableId) {
      const table = this.tables.get(tableId);
      if (table?.memorySpaceId !== memorySpaceId) return false;
      return table ? this.tables.delete(table.id) : false;
    }
    return this.spaces.delete(memorySpaceId);
  }

  find(id: MemorySpaceId): Promise<MemorySpace | undefined>;
  find(memorySpaceId: MemorySpaceId, id: MemoryTableId): Promise<MemoryTable | undefined>;
  async find(
    memorySpaceId: MemorySpaceId,
    tableId?: MemoryTableId,
  ): Promise<MemorySpace | MemoryTable | undefined> {
    if (tableId) {
      const table = this.tables.get(tableId);
      return table?.memorySpaceId === memorySpaceId ? table : undefined;
    }
    return this.spaces.get(memorySpaceId);
  }

  async findByKey(
    memorySpaceId: MemorySpaceId,
    key: MemoryTableKey,
  ): Promise<MemoryTable | undefined> {
    return [...this.tables.values()].find(
      (table) => table.memorySpaceId === memorySpaceId && table.key === key,
    );
  }

  list(): Promise<MemorySpace[]>;
  list(memorySpaceId: MemorySpaceId): Promise<MemoryTable[]>;
  async list(memorySpaceId?: MemorySpaceId): Promise<MemorySpace[] | MemoryTable[]> {
    if (!memorySpaceId) return [...this.spaces.values()];
    return [...this.tables.values()].filter((table) => table.memorySpaceId === memorySpaceId);
  }

  async rename(
    id: MemorySpaceId,
    name: string,
    updatedAt: string,
  ): Promise<MemorySpace | undefined> {
    const space = this.spaces.get(id);
    if (!space) return undefined;
    const renamed = { ...space, name, updatedAt };
    this.spaces.set(id, renamed);
    return renamed;
  }

  async clearRecords(): Promise<boolean> {
    return false;
  }

  async deleteAllTables(): Promise<boolean> {
    return false;
  }

  async update(memoryTable: MemoryTable): Promise<boolean> {
    const current = this.tables.get(memoryTable.id);
    if (current?.memorySpaceId !== memoryTable.memorySpaceId) return false;
    this.tables.set(memoryTable.id, memoryTable);
    return true;
  }
}

const spaceId = "space-1" as MemorySpaceId;
const tableId = "table-1" as MemoryTableId;
const now = "2026-07-28T00:00:00.000Z";

function service(
  repository: MemoryRepository,
  clock: () => string = () => now,
): MemoryTableService {
  repository.spaces.set(spaceId, { id: spaceId, name: "会话", createdAt: now, updatedAt: now });
  return new MemoryTableService(repository, repository, () => tableId, clock);
}

describe("MemoryTableService", () => {
  it("creates an enabled empty custom table owned by its memory space", async () => {
    const repository = new MemoryRepository();

    const created = await service(repository).create(spaceId, {
      key: "clues",
      kind: "custom",
      name: "  线索  ",
      description: "值得追踪的线索",
      prompt: "只记录仍可能影响后续情节的线索。",
    });

    expect(created).toEqual({
      id: tableId,
      memorySpaceId: spaceId,
      key: "clues",
      kind: "custom",
      name: "线索",
      description: "值得追踪的线索",
      prompt: "只记录仍可能影响后续情节的线索。",
      enabled: true,
      displayStrategy: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(repository.tables.get(tableId)).toEqual(created);
  });

  it("updates table configuration without changing its identity or ownership", async () => {
    const repository = new MemoryRepository();
    const times = [now, "2026-07-28T01:00:00.000Z"];
    const tables = service(repository, () => times.shift()!);
    const created = await tables.create(spaceId, {
      key: "clues",
      kind: "custom",
      name: "线索",
      description: "旧描述",
      prompt: "旧 Prompt",
    });

    const updated = await tables.update(spaceId, tableId, {
      name: "  关键线索  ",
      description: "新描述",
      prompt: "新 Prompt\n保留换行。",
      enabled: false,
    });

    expect(updated).toEqual({
      ...created,
      name: "关键线索",
      description: "新描述",
      prompt: "新 Prompt\n保留换行。",
      enabled: false,
      updatedAt: "2026-07-28T01:00:00.000Z",
    });
  });

  it("rejects duplicate table keys in the same memory space", async () => {
    const repository = new MemoryRepository();
    const tables = service(repository);
    await tables.create(spaceId, {
      key: "clues",
      kind: "custom",
      name: "线索",
      description: "",
      prompt: "",
    });

    await expect(
      tables.create(spaceId, {
        key: "clues",
        kind: "custom",
        name: "另一张表",
        description: "",
        prompt: "",
      }),
    ).rejects.toThrowError(expect.objectContaining({ type: "memory_table_key_conflict" }));
  });

  it("isolates same-named tables by memory space and physically deletes one table", async () => {
    const repository = new MemoryRepository();
    const secondSpaceId = "space-2" as MemorySpaceId;
    const secondTableId = "table-2" as MemoryTableId;
    repository.spaces.set(spaceId, {
      id: spaceId,
      name: "会话",
      createdAt: now,
      updatedAt: now,
    });
    repository.spaces.set(secondSpaceId, {
      id: secondSpaceId,
      name: "另一会话",
      createdAt: now,
      updatedAt: now,
    });
    const ids = [tableId, secondTableId];
    const tables = new MemoryTableService(
      repository,
      repository,
      () => ids.shift()!,
      () => now,
    );
    await tables.create(spaceId, {
      key: "clues",
      kind: "custom",
      name: "线索",
      description: "A",
      prompt: "",
    });
    await tables.create(secondSpaceId, {
      key: "clues",
      kind: "custom",
      name: "线索",
      description: "B",
      prompt: "",
    });

    expect(await tables.list(spaceId)).toMatchObject([{ id: tableId, description: "A" }]);
    expect(await tables.list(secondSpaceId)).toMatchObject([
      { id: secondTableId, description: "B" },
    ]);

    expect(await tables.delete(spaceId, tableId)).toBe(true);
    expect(await tables.find(spaceId, tableId)).toBeUndefined();
    expect(await tables.list(secondSpaceId)).toMatchObject([
      { id: secondTableId, description: "B" },
    ]);
  });
});
