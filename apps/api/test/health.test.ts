import { describe, expect, it } from "vitest";
import type { DatabaseHealthCheck } from "../src/health/types.ts";
import { buildServer } from "../src/server.ts";

function healthCheck(connected: boolean): DatabaseHealthCheck {
  return {
    check: () => (connected ? { connected: true } : { connected: false, error: "unavailable" }),
  };
}

describe("GET /health", () => {
  it("reports API and database connection status", async () => {
    const server = await buildServer({
      coreDatabase: healthCheck(true),
      sourceStoreDatabase: healthCheck(false),
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
