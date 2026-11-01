import type { MemorySpaceId } from "../../features/memory/index.ts";
import { describe, expect, it } from "vitest";
import { PublicSqlDatabase } from "./public-query.ts";

describe("public database schema identity", () => {
  it("invalidates mappings for a replacement stable space identity while ignoring publication time", () => {
    const input = {
      databaseKey: "loaded-database",
      space: {
        id: "space" as MemorySpaceId,
        stableId: "stable-space",
        name: "空间",
        macros: [],
        initializationSource: null,
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
      },
      tables: [],
      fields: [],
    };
    const initial = PublicSqlDatabase.schema(input);
    const published = PublicSqlDatabase.schema({
      ...input,
      space: { ...input.space, updatedAt: "2026-11-02T00:00:00.000Z" },
    });
    const replacement = PublicSqlDatabase.schema({
      ...input,
      space: { ...input.space, stableId: "replacement-space" },
    });
    expect(published.schemaKey).toBe(initial.schemaKey);
    expect(replacement.schemaKey).not.toBe(initial.schemaKey);
  });
});
