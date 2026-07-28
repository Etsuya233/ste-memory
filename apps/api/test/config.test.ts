import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("uses a local-only application database default", () => {
    expect(loadConfig({})).toEqual({
      host: "127.0.0.1",
      port: 3000,
      databaseUrl: "sqlite:../../data/ste-memory.sqlite",
    });
  });

  it("accepts one application database URL", () => {
    const config = loadConfig({
      API_HOST: "0.0.0.0",
      API_PORT: "4100",
      DATABASE_URL: "sqlite:./data/application.sqlite",
    });

    expect(config).toEqual({
      host: "0.0.0.0",
      port: 4100,
      databaseUrl: "sqlite:./data/application.sqlite",
    });
  });
});
