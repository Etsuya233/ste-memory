import type { MemorySpaceId } from "@ste-memory/core/memory";
import { describe, expect, it } from "vitest";
// 必须先于 ./database.ts 导入：dexie 在模块加载时捕获全局 indexedDB，
// fake-indexeddb 必须在它之前求值（否则 MissingAPIError）
import { NOW, createTestDatabase } from "./test-support.ts";
import { DexieLogRepository } from "./log-repository.ts";
import type { LogAppendInput } from "../logging/log.ts";

function entry(overrides: Partial<LogAppendInput> = {}): LogAppendInput {
  return {
    type: "fill",
    key: "task-1",
    spaceId: "space-1" as MemorySpaceId,
    level: "info",
    data: { rounds: 2 },
    ...overrides,
  };
}

describe("Dexie log repository", () => {
  it("appends entries with auto-increment id and injected createdAt", async () => {
    const times = ["2026-07-28T00:00:00.000Z", "2026-07-28T01:00:00.000Z"];
    let index = 0;
    const logs = new DexieLogRepository(createTestDatabase(), { now: () => times[index++]! });

    await logs.append(entry({ key: "task-1", level: "info" }));
    await logs.append(entry({ key: "task-1", level: "error", data: { rounds: 0 } }));

    expect(await logs.byKey("task-1", 10)).toEqual([
      {
        id: 2,
        type: "fill",
        key: "task-1",
        spaceId: "space-1",
        level: "error",
        data: { rounds: 0 },
        createdAt: "2026-07-28T01:00:00.000Z",
      },
      {
        id: 1,
        type: "fill",
        key: "task-1",
        spaceId: "space-1",
        level: "info",
        data: { rounds: 2 },
        createdAt: "2026-07-28T00:00:00.000Z",
      },
    ]);
  });

  it("appends entries without a space id as null", async () => {
    const logs = new DexieLogRepository(createTestDatabase(), { now: () => NOW });

    await logs.append(entry({ spaceId: undefined }));

    const rows = await logs.byType("fill", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.spaceId).toBeNull();
  });

  it("queries by type newest first with limit", async () => {
    const logs = new DexieLogRepository(createTestDatabase(), { now: () => NOW });

    for (let i = 0; i < 3; i += 1) {
      await logs.append(entry({ type: "fill", key: `task-${i}` }));
    }
    await logs.append(entry({ type: "sync", key: "sync-1" }));

    expect((await logs.byType("fill", 10)).map((row) => row.key)).toEqual([
      "task-2",
      "task-1",
      "task-0",
    ]);
    expect((await logs.byType("fill", 2)).map((row) => row.key)).toEqual(["task-2", "task-1"]);
  });

  it("queries by key newest first with limit", async () => {
    const logs = new DexieLogRepository(createTestDatabase(), { now: () => NOW });

    await logs.append(entry({ key: "task-1", data: { block: 0 } }));
    await logs.append(entry({ key: "task-1", data: { block: 1 } }));
    await logs.append(entry({ key: "task-2" }));

    expect((await logs.byKey("task-1", 10)).map((row) => row.data)).toEqual([
      { block: 1 },
      { block: 0 },
    ]);
    expect((await logs.byKey("task-1", 1)).map((row) => row.data)).toEqual([{ block: 1 }]);
  });

  it("queries recent entries across all types newest first with limit", async () => {
    const logs = new DexieLogRepository(createTestDatabase(), { now: () => NOW });

    await logs.append(entry({ type: "fill", key: "task-1" }));
    await logs.append(entry({ type: "sync", key: "sync-1", spaceId: undefined }));
    await logs.append(entry({ type: "fill", key: "task-2" }));

    expect((await logs.recent(10)).map((row) => row.key)).toEqual(["task-2", "sync-1", "task-1"]);
    expect((await logs.recent(2)).map((row) => row.key)).toEqual(["task-2", "sync-1"]);
  });

  it("queries by space newest first; null-space rows are excluded", async () => {
    const logs = new DexieLogRepository(createTestDatabase(), { now: () => NOW });

    await logs.append(entry({ spaceId: "space-1" as MemorySpaceId }));
    await logs.append(entry({ spaceId: "space-2" as MemorySpaceId }));
    await logs.append(entry({ spaceId: undefined }));

    expect((await logs.bySpace("space-1" as MemorySpaceId, 10)).map((row) => row.id)).toEqual([1]);
  });

  it("prunes the oldest entries beyond the configured limit", async () => {
    const logs = new DexieLogRepository(createTestDatabase(), { limit: 3, now: () => NOW });

    for (let i = 1; i <= 5; i += 1) {
      await logs.append(entry({ key: `task-${i}` }));
    }

    expect((await logs.byType("fill", 10)).map((row) => row.key)).toEqual([
      "task-5",
      "task-4",
      "task-3",
    ]);
  });

  it("clearAll removes every entry", async () => {
    const logs = new DexieLogRepository(createTestDatabase(), { now: () => NOW });

    await logs.append(entry());
    await logs.append(entry({ key: "task-2" }));
    await logs.clearAll();

    expect(await logs.byType("fill", 10)).toEqual([]);
  });
});
