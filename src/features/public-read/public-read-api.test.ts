import { describe, expect, it } from "vitest";
import {
  PublicMemoryReader,
  type MemoryReadContext,
  type MemoryReadSnapshot,
} from "./public-read-api.ts";

describe("public memory read boundary", () => {
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
