import "../test-support.ts";
import { describe, expect, it } from "vitest";
import type { MemorySpaceId } from "../../../features/memory/index.ts";
import { createTestDatabase } from "../test-support.ts";
import { DexieVectorIndexRepository } from "./vector-index-repository.ts";

describe("DexieVectorIndexRepository", () => {
  it("按空间清理向量和持久抑制，保留其他空间", async () => {
    const db = createTestDatabase();
    const repository = new DexieVectorIndexRepository(db);
    const one = "one" as MemorySpaceId;
    const two = "two" as MemorySpaceId;
    await repository.saveSuppression({
      id: "one\u0000table\u0000record\u0000group\u0000fingerprint",
      memorySpaceId: one,
      fingerprint: "fingerprint",
      reason: "cancelled",
    });
    await repository.saveSuppression({
      id: "two\u0000table\u0000record\u0000group\u0000fingerprint",
      memorySpaceId: two,
      fingerprint: "fingerprint",
      reason: "failed",
    });
    await repository.saveVector({
      id: "one\u0000table\u0000record\u0000group",
      memorySpaceId: one,
      tableId: "table" as never,
      recordId: "record" as never,
      groupId: "group",
      fingerprint: "fingerprint",
      values: [1, 2],
      model: "m",
      version: "v",
      updatedAt: "2026-01-01",
    });
    await repository.deleteSuppressions({ memorySpaceId: one });
    await repository.deleteVectors({ memorySpaceId: one });
    expect(await repository.listSuppressions()).toHaveLength(1);
    expect(await repository.listVectors({ memorySpaceId: one })).toHaveLength(0);
    expect((await repository.listSuppressions())[0]?.memorySpaceId).toBe(two);
  });
});

it("仅指定recordId时跨表限定该记录，删除保留同空间其他记录与其他空间", async () => {
  const db = createTestDatabase();
  const repository = new DexieVectorIndexRepository(db);
  for (const [space, table, record] of [
    ["one", "first", "target"],
    ["one", "second", "target"],
    ["one", "first", "other"],
    ["two", "first", "target"],
  ]) {
    await repository.saveVector({
      id: `${space}/${table}/${record}`,
      memorySpaceId: space as MemorySpaceId,
      tableId: table as never,
      recordId: record as never,
      groupId: "group",
      fingerprint: "fingerprint",
      values: [1, 0],
      model: "m",
      version: "v",
      updatedAt: "2026-01-01",
    });
  }
  const emptyRecordScope = { memorySpaceId: "one" as MemorySpaceId, recordId: "" as never };
  expect(await repository.listVectors(emptyRecordScope)).toEqual([]);
  await repository.deleteVectors(emptyRecordScope);
  expect(
    await repository.listVectors({ memorySpaceId: "one" as MemorySpaceId, tableId: "" as never }),
  ).toEqual([]);
  expect(await db.recordVectors.count()).toBe(4);
  const scope = { memorySpaceId: "one" as MemorySpaceId, recordId: "target" as never };
  expect((await repository.listVectors(scope)).map((vector) => vector.id).sort()).toEqual([
    "one/first/target",
    "one/second/target",
  ]);
  await repository.deleteVectors(scope);
  expect((await db.recordVectors.toArray()).map((vector) => vector.id).sort()).toEqual([
    "one/first/other",
    "two/first/target",
  ]);
});
