import type { MemorySpaceId } from "@ste-memory/core/memory";
import { describe, expect, it } from "vitest";
// 必须先于 ./database.ts 导入：dexie 在模块加载时捕获全局 indexedDB，
// fake-indexeddb 必须在它之前求值（否则 MissingAPIError）
import { NOW, createServices, createTestDatabase } from "./test-support.ts";
import { SteMemoryDatabase } from "./database.ts";
import { DexieLogRepository } from "./log-repository.ts";
import { DexieMemorySpaceRepository } from "./memory-space-repository.ts";

describe("Dexie memory space repository", () => {
  it("creates and finds a memory space with all fields", async () => {
    const { spaces, spaceRepository } = createServices(createTestDatabase());

    const space = await spaces.create("会话");

    expect(space).toEqual({
      id: "space-1",
      name: "会话",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(await spaceRepository.find(space.id)).toEqual(space);
    expect(await spaceRepository.find("missing" as MemorySpaceId)).toBeUndefined();
  });

  it("lists all memory spaces newest first", async () => {
    const times = [
      "2026-07-28T00:00:00.000Z",
      "2026-07-28T01:00:00.000Z",
      "2026-07-28T02:00:00.000Z",
    ];
    let index = 0;
    const { spaces, spaceRepository } = createServices(createTestDatabase(), () => times[index++]!);

    const oldest = await spaces.create("最早");
    const middle = await spaces.create("中间");
    const newest = await spaces.create("最新");

    expect(await spaceRepository.list()).toEqual([newest, middle, oldest]);
  });

  it("renames a memory space and bumps updatedAt", async () => {
    const { spaces, spaceRepository } = createServices(createTestDatabase());
    const space = await spaces.create("会话");

    const renamed = await spaceRepository.rename(
      space.id,
      "重命名会话",
      "2026-07-28T02:00:00.000Z",
    );

    expect(renamed).toEqual({
      id: space.id,
      name: "重命名会话",
      createdAt: NOW,
      updatedAt: "2026-07-28T02:00:00.000Z",
    });
    expect(await spaceRepository.find(space.id)).toEqual(renamed);
  });

  it("rename returns undefined for a missing space", async () => {
    const { spaceRepository } = createServices(createTestDatabase());

    expect(
      await spaceRepository.rename("missing" as MemorySpaceId, "新名字", NOW),
    ).toBeUndefined();
  });

  it("deletes a memory space and reports absence on repeat", async () => {
    const { spaces, spaceRepository } = createServices(createTestDatabase());
    const space = await spaces.create("会话");

    expect(await spaceRepository.delete(space.id)).toBe(true);
    expect(await spaceRepository.find(space.id)).toBeUndefined();
    expect(await spaceRepository.delete(space.id)).toBe(false);
  });

  it("cascades deletion to the space's tables and fields", async () => {
    const { spaces, tables, fields, tableRepository, fieldRepository } =
      createServices(createTestDatabase());
    const space = await spaces.create("会话");
    const table = await tables.create(space.id, {
      key: "clues",
      kind: "custom",
      name: "线索",
      description: "",
      prompt: "",
    });
    await fields.create(space.id, table!.id, {
      key: "name",
      name: "名称",
      type: "short_text",
      required: false,
      prompt: "",
      enabled: true,
      position: 0,
    });

    expect(await spaces.delete(space.id)).toBe(true);

    // 与 SQLite 参照实现 ON DELETE CASCADE 同语义：表格与字段一并物理删除
    expect(await tableRepository.list(space.id)).toEqual([]);
    expect(await fieldRepository.list(space.id, table!.id)).toEqual([]);
  });

  it("cascades deletion to the space's logs (ADR 0008)", async () => {
    const db = createTestDatabase();
    const { spaces } = createServices(db);
    const space = await spaces.create("会话");
    const logs = new DexieLogRepository(db, { now: () => NOW });
    await logs.append({
      type: "fill",
      key: "task-1",
      spaceId: space.id,
      level: "info",
      data: {},
    });

    expect(await spaces.delete(space.id)).toBe(true);

    expect(await logs.bySpace(space.id, 10)).toEqual([]);
  });

  it("persists across a database reopen (页面刷新语义)", async () => {
    const name = "ste-memory-test-reopen";
    const first = new SteMemoryDatabase(name);
    const { spaces } = createServices(first);
    const space = await spaces.create("会话");
    first.close();

    const second = new SteMemoryDatabase(name);
    try {
      const reopened = new DexieMemorySpaceRepository(second);
      expect(await reopened.find(space.id)).toEqual(space);
      expect(await reopened.list()).toEqual([space]);
    } finally {
      await second.delete();
    }
  });
});
