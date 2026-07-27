import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("uses local-only and separate SQLite defaults", () => {
    expect(loadConfig({})).toEqual({
      host: "127.0.0.1",
      port: 3000,
      coreDatabaseUrl: "sqlite:../../data/core.sqlite",
      sourceStoreDatabaseUrl: "sqlite:../../data/source-store.sqlite",
    });
  });

  it("allows both stores to use the same SQLite file", () => {
    const config = loadConfig({
      API_HOST: "0.0.0.0",
      API_PORT: "4100",
      CORE_DATABASE_URL: "sqlite:./data/shared.sqlite",
      SOURCE_STORE_DATABASE_URL: "sqlite:./data/shared.sqlite",
    });

    expect(config).toEqual({
      host: "0.0.0.0",
      port: 4100,
      coreDatabaseUrl: "sqlite:./data/shared.sqlite",
      sourceStoreDatabaseUrl: "sqlite:./data/shared.sqlite",
    });
  });
});
