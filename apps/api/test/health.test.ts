import { describe, expect, it } from "vitest";
import type { DatabaseHealthCheck } from "../src/health/types.ts";
import type { MemorySpaceManager } from "../src/memory-spaces/types.ts";
import type { MemoryTableManager } from "../src/memory-tables/types.ts";
import { buildServer } from "../src/server.ts";

function healthCheck(connected: boolean): DatabaseHealthCheck {
  return {
    check: () => (connected ? { connected: true } : { connected: false, error: "unavailable" }),
  };
}

const memorySpaces: MemorySpaceManager = {
  create: () => {
    throw new Error("not used");
  },
  delete: () => false,
  errors: () => undefined,
  exists: () => false,
  list: () => [],
  messages: () => undefined,
  rename: () => undefined,
};

const memoryTables: MemoryTableManager = {
  createCustom: () => undefined,
  delete: () => false,
  find: () => undefined,
  list: () => [],
  update: () => undefined,
};

describe("GET /health", () => {
  it("reports API and database connection status", async () => {
    const server = await buildServer({
      coreDatabase: healthCheck(true),
      sourceStoreDatabase: healthCheck(false),
      memorySpaces,
      memoryTables,
    });

    const response = await server.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      api: "ok",
      databases: {
        core: { connected: true },
        sourceStore: { connected: false, error: "unavailable" },
      },
    });
    await server.close();
  });
});
