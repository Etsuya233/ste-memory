import { describe, expect, it } from "vitest";
import type { DatabaseHealthCheck } from "../src/application/ports/health.ts";
import type { MemorySpaceManager } from "../src/application/ports/memory-space.ts";
import type { MemoryTableManager } from "../src/application/ports/memory-table.ts";
import type { MemoryFieldManager } from "../src/application/ports/memory-field.ts";
import type { MemoryRecordManager } from "../src/application/ports/memory-record.ts";
import type { MemoryRecordQueryManager } from "../src/application/ports/memory-record-query.ts";
import { buildServer } from "../src/adapters/inbound/http/server.ts";

function healthCheck(connected: boolean): DatabaseHealthCheck {
  return {
    check: async () =>
      connected ? { connected: true } : { connected: false, error: "unavailable" },
  };
}

const memorySpaces: MemorySpaceManager = {
  create: () => {
    throw new Error("not used");
  },
  delete: async () => false,
  errors: async () => undefined,
  exists: async () => false,
  list: async () => [],
  messages: async () => undefined,
  rename: async () => undefined,
};

const memoryTables: MemoryTableManager = {
  create: async () => undefined,
  delete: async () => false,
  find: async () => undefined,
  list: async () => [],
  update: async () => undefined,
};

const memoryFields: MemoryFieldManager = {
  create: async () => undefined,
  delete: async () => false,
  find: async () => undefined,
  list: async () => [],
  setDisplayStrategy: async () => undefined,
  update: async () => undefined,
};

const memoryRecords: MemoryRecordManager = {
  create: async () => undefined,
  find: async () => undefined,
  list: async () => undefined,
  update: async () => undefined,
  delete: async () => false,
  listHistory: async () => [],
};

const memoryRecordQueries: MemoryRecordQueryManager = {
  query: async () => ({ records: [], page: 1, pageSize: 1, total: 0, totalPages: 0 }),
};

describe("GET /health", () => {
  it("reports API and database connection status", async () => {
    const server = await buildServer({
      database: healthCheck(false),
      memorySpaces,
      memoryTables,
      memoryFields,
      memoryRecords,
      memoryRecordQueries,
    });

    const response = await server.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      api: "ok",
      database: { connected: false, error: "unavailable" },
    });
    await server.close();
  });
});
