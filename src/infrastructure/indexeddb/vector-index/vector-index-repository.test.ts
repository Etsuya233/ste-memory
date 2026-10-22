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
