import { describe, expect, it } from "vitest";
import {
  PublicMemoryReader,
  type MemoryReadContext,
  type MemoryReadSnapshot,
} from "./public-read-api.ts";
import type { MemoryDatabasePort, MemoryDatabaseQueryResult } from "./database-api.ts";

describe("public memory read boundary", () => {
  it("database rejects stale chat bindings before calling the worker and after a pending result", async () => {
    let identity = "chat";
    let resolve!: (result: MemoryDatabaseQueryResult) => void;
    let queries = 0;
    const port: MemoryDatabasePort = {
      describeDatabase: async () => {
        throw new Error("unused");
      },
      registerDatabaseViews: async () => {},
      queryDatabase: () => {
        queries++;
        return new Promise((done) => {
          resolve = done;
        });
      },
    };
    const reader = new PublicMemoryReader(
      () => ({
        chatIdentity: identity,
        chatName: "聊天",
        spaceId: "space",
        spaceName: "空间",
        available: true,
        message: null,
      }),
      async () => {
        throw new Error("unused");
      },
      port,
    );
    const input = {
      chatIdentity: "chat",
      spaceId: "space",
      schemaKey: "schema",
      namespace: "phone",
      sql: "SELECT 1",
    };
    await expect(reader.database!.query({ ...input, chatIdentity: "wrong" })).rejects.toThrow(
      "对话",
    );
    expect(queries).toBe(0);
    const pending = reader.database!.query(input);
    await Promise.resolve();
    identity = "next-chat";
    resolve({ columns: [], rows: [], maxRows: 200, truncated: false, elapsedMs: 1 });
    await expect(pending).rejects.toThrow("对话");
  });

  it("database accepts committed record notifications and checks binding again after loading", async () => {
    let identity = "chat";
    let queryCalls = 0;
    let prepareCalls = 0;
    const reader = new PublicMemoryReader(
      () => ({
        chatIdentity: identity,
        chatName: "聊天",
        spaceId: "space",
        spaceName: "空间",
        available: true,
        message: null,
      }),
      async () => {
        throw new Error("unused");
      },
      {
        describeDatabase: async () => {
          throw new Error("unused");
        },
        registerDatabaseViews: async () => {},
        queryDatabase: async () => {
          queryCalls++;
          reader.invalidate();
          return { columns: ["n"], rows: [[1]], maxRows: 200, truncated: false, elapsedMs: 1 };
        },
      },
      async () => {
        prepareCalls++;
        if (prepareCalls === 2) identity = "other";
      },
    );
    const input = {
      chatIdentity: "chat",
      spaceId: "space",
      schemaKey: "schema",
      namespace: "phone",
      sql: "SELECT 1",
    };
    expect((await reader.database!.query(input)).rows).toEqual([[1]]);
    await expect(reader.database!.query(input)).rejects.toThrow("对话");
    expect(queryCalls).toBe(1);
  });
  it("rejects a read invalidated in the same space and notifies subscribers", async () => {
    let resolve!: (snapshot: MemoryReadSnapshot) => void;
    const reader = new PublicMemoryReader(
      () => ({
        chatIdentity: "chat",
        chatName: "聊天",
        spaceId: "space",
        spaceName: "空间",
        available: true,
        message: null,
      }),
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    let changes = 0;
    reader.subscribe(() => changes++);
    const pending = reader.read();
    reader.invalidate();
    resolve({} as MemoryReadSnapshot);
    await expect(pending).rejects.toThrow("读取期间");
    expect(changes).toBe(1);
  });

  it("checks chat identity even when the space and revision have not changed", async () => {
    let identity = "chat";
    let resolve!: (snapshot: MemoryReadSnapshot) => void;
    const context = (): Omit<MemoryReadContext, "revision"> => ({
      chatIdentity: identity,
      chatName: "聊天",
      spaceId: "space",
      spaceName: "空间",
      available: true,
      message: null,
    });
    const reader = new PublicMemoryReader(
      context,
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = reader.read();
    identity = "other";
    resolve({} as MemoryReadSnapshot);
    await expect(pending).rejects.toThrow("读取期间");
  });
});
