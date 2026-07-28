import {
  MemoryTableService,
  type MemorySpace,
  type MemorySpaceId,
  type MemorySpaceRepository,
  type MemoryTable,
  type MemoryTableId,
  type MemoryTableRepository,
} from "../src/index.ts";
import { describe, expect, it } from "vitest";

class MemoryRepository implements MemorySpaceRepository, MemoryTableRepository {
  readonly spaces = new Map<MemorySpaceId, MemorySpace>();
  readonly tables = new Map<MemoryTableId, MemoryTable>();

  create(memorySpace: MemorySpace): void;
  create(memoryTable: MemoryTable): void;
  create(value: MemorySpace | MemoryTable): void {
    if ("memorySpaceId" in value) this.tables.set(value.id, value);
    else this.spaces.set(value.id, value);
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

    const created = service(repository).createCustom(spaceId, {
      name: "  线索  ",
      description: "值得追踪的线索",
      prompt: "只记录仍可能影响后续情节的线索。",
    });

    expect(created).toEqual({
      id: tableId,
      memorySpaceId: spaceId,
      kind: "custom",
      name: "线索",
      description: "值得追踪的线索",
      prompt: "只记录仍可能影响后续情节的线索。",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    expect(repository.tables.get(tableId)).toEqual(created);
  });

  it("updates table configuration without changing its identity or ownership", () => {
    const repository = new MemoryRepository();
    const times = [now, "2026-07-28T01:00:00.000Z"];
    const tables = service(repository, () => times.shift()!);
    const created = tables.createCustom(spaceId, {
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
    tables.createCustom(spaceId, { name: "线索", description: "A", prompt: "" });
    tables.createCustom(secondSpaceId, { name: "线索", description: "B", prompt: "" });

    expect(tables.list(spaceId)).toMatchObject([{ id: tableId, description: "A" }]);
    expect(tables.list(secondSpaceId)).toMatchObject([{ id: secondTableId, description: "B" }]);

    expect(tables.delete(spaceId, tableId)).toBe(true);
    expect(tables.find(spaceId, tableId)).toBeUndefined();
    expect(tables.list(secondSpaceId)).toMatchObject([{ id: secondTableId, description: "B" }]);
  });
});
