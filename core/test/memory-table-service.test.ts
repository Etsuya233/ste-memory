import {
  MemoryTableService,
  type MemoryField,
  type MemorySpace,
  type MemorySpaceId,
  type MemorySpaceRepository,
  type MemoryTable,
  type MemoryTableId,
  type MemoryTableKey,
  type MemoryTableRepository,
} from "../src/index.ts";
import { describe, expect, it } from "vitest";

class MemoryRepository implements MemorySpaceRepository, MemoryTableRepository {
  readonly spaces = new Map<MemorySpaceId, MemorySpace>();
  readonly tables = new Map<MemoryTableId, MemoryTable>();

  create(
    memorySpace: MemorySpace,
    systemTables: readonly MemoryTable[],
    systemFields: readonly MemoryField[],
  ): void;
  create(memoryTable: MemoryTable): void;
  create(
    value: MemorySpace | MemoryTable,
    systemTables?: readonly MemoryTable[],
    _systemFields?: readonly MemoryField[],
  ): void {
    if ("memorySpaceId" in value) this.tables.set(value.id, value);
    else {
      this.spaces.set(value.id, value);
      for (const table of systemTables!) this.tables.set(table.id, table);
    }
  }

  delete(id: MemorySpaceId): boolean;
  delete(memorySpaceId: MemorySpaceId, id: MemoryTableId): boolean;
  delete(memorySpaceId: MemorySpaceId, tableId?: MemoryTableId): boolean {
    if (tableId) {
      const table = this.find(memorySpaceId, tableId);
      return table ? this.tables.delete(table.id) : false;
    }
    return this.spaces.delete(memorySpaceId);
  }

  find(id: MemorySpaceId): MemorySpace | undefined;
  find(memorySpaceId: MemorySpaceId, id: MemoryTableId): MemoryTable | undefined;
  find(
    memorySpaceId: MemorySpaceId,
    tableId?: MemoryTableId,
  ): MemorySpace | MemoryTable | undefined {
    if (tableId) {
      const table = this.tables.get(tableId);
      return table?.memorySpaceId === memorySpaceId ? table : undefined;
    }
    return this.spaces.get(memorySpaceId);
  }

  findByKey(memorySpaceId: MemorySpaceId, key: MemoryTableKey): MemoryTable | undefined {
    return [...this.tables.values()].find(
      (table) => table.memorySpaceId === memorySpaceId && table.key === key,
    );
  }

  list(): MemorySpace[];
  list(memorySpaceId: MemorySpaceId): MemoryTable[];
  list(memorySpaceId?: MemorySpaceId): MemorySpace[] | MemoryTable[] {
    if (!memorySpaceId) return [...this.spaces.values()];
    return [...this.tables.values()].filter((table) => table.memorySpaceId === memorySpaceId);
  }

  rename(id: MemorySpaceId, name: string, updatedAt: string): MemorySpace | undefined {
    const space = this.spaces.get(id);
    if (!space) return undefined;
    const renamed = { ...space, name, updatedAt };
    this.spaces.set(id, renamed);
    return renamed;
  }

  update(memoryTable: MemoryTable): boolean {
    if (!this.find(memoryTable.memorySpaceId, memoryTable.id)) return false;
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
  it("creates an enabled empty custom table owned by its memory space", () => {
    const repository = new MemoryRepository();

    const created = service(repository).create(spaceId, {
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

  it("updates table configuration without changing its identity or ownership", () => {
    const repository = new MemoryRepository();
    const times = [now, "2026-07-28T01:00:00.000Z"];
    const tables = service(repository, () => times.shift()!);
    const created = tables.create(spaceId, {
      key: "clues",
      kind: "custom",
      name: "线索",
      description: "旧描述",
      prompt: "旧 Prompt",
    });

    const updated = tables.update(spaceId, tableId, {
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

  it("rejects duplicate table keys in the same memory space", () => {
    const repository = new MemoryRepository();
    const tables = service(repository);
    tables.create(spaceId, {
      key: "clues",
      kind: "custom",
      name: "线索",
      description: "",
      prompt: "",
    });

    expect(() =>
      tables.create(spaceId, {
        key: "clues",
        kind: "custom",
        name: "另一张表",
        description: "",
        prompt: "",
      }),
    ).toThrowError(expect.objectContaining({ type: "memory_table_key_conflict" }));
  });

  it("isolates same-named tables by memory space and physically deletes one table", () => {
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
    tables.create(spaceId, {
      key: "clues",
      kind: "custom",
      name: "线索",
      description: "A",
      prompt: "",
    });
    tables.create(secondSpaceId, {
      key: "clues",
      kind: "custom",
      name: "线索",
      description: "B",
      prompt: "",
    });

    expect(tables.list(spaceId)).toMatchObject([{ id: tableId, description: "A" }]);
    expect(tables.list(secondSpaceId)).toMatchObject([{ id: secondTableId, description: "B" }]);

    expect(tables.delete(spaceId, tableId)).toBe(true);
    expect(tables.find(spaceId, tableId)).toBeUndefined();
    expect(tables.list(secondSpaceId)).toMatchObject([{ id: secondTableId, description: "B" }]);
  });
});
