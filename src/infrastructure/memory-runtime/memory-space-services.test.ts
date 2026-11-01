import type { MemorySpaceId } from "../../features/memory/index.ts";
import { describe, expect, it } from "vitest";
// 必须先于 ./database.ts 导入：dexie 在模块加载时捕获全局 indexedDB，
// fake-indexeddb 必须在它之前求值（否则 MissingAPIError）
import { NOW, createServices, createTestDatabase } from "../indexeddb/test-support.ts";

describe("SQLite memory space services", () => {
  it("creates and finds a memory space with all fields", async () => {
    const { spaces, spaceRepository } = await createServices(createTestDatabase());

    const space = await spaces.create("会话");

    expect(space).toEqual({
      id: "space-1",
      name: "会话",
      initializationSource: null,
      macros: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(await spaceRepository.find(space.id)).toEqual(space);
    expect(await spaceRepository.find("missing" as MemorySpaceId)).toBeUndefined();
  });

  it("renames a memory space and bumps updatedAt", async () => {
    const { spaces, spaceRepository } = await createServices(createTestDatabase());
    const space = await spaces.create("会话");

    const renamed = await spaceRepository.rename(
      space.id,
      "重命名会话",
      "2026-07-28T02:00:00.000Z",
    );

    expect(renamed).toEqual({
      id: space.id,
      name: "重命名会话",
      initializationSource: null,
      macros: [],
      createdAt: NOW,
      updatedAt: "2026-07-28T02:00:00.000Z",
    });
    expect(await spaceRepository.find(space.id)).toEqual(renamed);
  });

  it("rename returns undefined for a missing space", async () => {
    const { spaceRepository } = await createServices(createTestDatabase());

    expect(await spaceRepository.rename("missing" as MemorySpaceId, "新名字", NOW)).toBeUndefined();
  });
});
