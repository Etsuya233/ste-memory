import type { MemoryFieldId, MemorySpaceId, MemoryTableKey } from "@ste-memory/core/memory";
import { describe, expect, it } from "vitest";
import { createServices, createTestDatabase } from "./test-support.ts";

describe("Dexie memory table repository", () => {
  it("creates, finds, enables/disables, updates and deletes a table", async () => {
    const { spaces, tables, tableRepository } = createServices(createTestDatabase());
    const space = await spaces.create("会话");

    const created = await tables.create(space.id, {
      key: "clues",
      kind: "custom",
      name: "线索",
      description: "值得追踪的线索",
      prompt: "只保留仍可能影响后续情节的内容。",
    });

    expect(created).toMatchObject({
      id: "table-1",
      memorySpaceId: space.id,
      key: "clues",
      kind: "custom",
      name: "线索",
      description: "值得追踪的线索",
      prompt: "只保留仍可能影响后续情节的内容。",
      enabled: true,
      displayStrategy: null,
    });
    expect(await tableRepository.find(space.id, created!.id)).toEqual(created);
    expect(await tableRepository.findByKey(space.id, "clues" as MemoryTableKey)).toEqual(created);
    expect(await tableRepository.list(space.id)).toEqual([created]);

    const updated = await tables.update(space.id, created!.id, {
      name: "关键线索",
      description: "只跟踪关键线索",
      prompt: "忽略已经完全回收的线索。",
      enabled: false,
    });
    expect(updated).toMatchObject({
      key: "clues",
      name: "关键线索",
      description: "只跟踪关键线索",
      prompt: "忽略已经完全回收的线索。",
      enabled: false,
      createdAt: created!.createdAt,
    });
    expect((await tableRepository.find(space.id, created!.id))?.enabled).toBe(false);

    const reEnabled = await tables.update(space.id, created!.id, { enabled: true });
    expect(reEnabled?.enabled).toBe(true);

    expect(await tableRepository.delete(space.id, created!.id)).toBe(true);
    expect(await tableRepository.find(space.id, created!.id)).toBeUndefined();
    expect(await tableRepository.delete(space.id, created!.id)).toBe(false);
  });

  it("isolates tables by memory space (跨空间互不可见)", async () => {
    const { spaces, tables, tableRepository } = createServices(createTestDatabase());
    const spaceA = await spaces.create("空间 A");
    const spaceB = await spaces.create("空间 B");

    const tableA = await tables.create(spaceA.id, {
      key: "clues",
      kind: "custom",
      name: "线索 A",
      description: "",
      prompt: "",
    });
    const tableB = await tables.create(spaceB.id, {
      key: "clues",
      kind: "custom",
      name: "线索 B",
      description: "",
      prompt: "",
    });

    // 相同 Key 在不同空间可以共存
    expect(await tableRepository.findByKey(spaceA.id, "clues" as MemoryTableKey)).toEqual(tableA);
    expect(await tableRepository.findByKey(spaceB.id, "clues" as MemoryTableKey)).toEqual(tableB);
    // 跨空间查询/更新/删除一律视为未命中
    expect(await tableRepository.find(spaceA.id, tableB!.id)).toBeUndefined();
    expect(await tableRepository.find(spaceB.id, tableA!.id)).toBeUndefined();
    expect(await tableRepository.update({ ...tableB!, memorySpaceId: spaceA.id })).toBe(false);
    expect(await tableRepository.delete(spaceA.id, tableB!.id)).toBe(false);
    expect(await tableRepository.list(spaceA.id)).toEqual([tableA]);
    expect(await tableRepository.list(spaceB.id)).toEqual([tableB]);
  });

  it("rejects a duplicate table key within the same space (core 规则)", async () => {
    const { spaces, tables } = createServices(createTestDatabase());
    const space = await spaces.create("会话");
    await tables.create(space.id, {
      key: "clues",
      kind: "custom",
      name: "线索",
      description: "",
      prompt: "",
    });

    await expect(
      tables.create(space.id, {
        key: "clues",
        kind: "custom",
        name: "另一个线索",
        description: "",
        prompt: "",
      }),
    ).rejects.toMatchObject({ type: "memory_table_key_conflict" });

    // 同空间内换一个 Key 即可创建
    const another = await tables.create(space.id, {
      key: "clues2",
      kind: "custom",
      name: "另一个线索",
      description: "",
      prompt: "",
    });
    expect(another?.key).toBe("clues2");
  });

  it("rename via service keeps the table in place", async () => {
    const { spaces, tables, tableRepository } = createServices(createTestDatabase());
    const space = await spaces.create("会话");
    const created = await tables.create(space.id, {
      key: "clues",
      kind: "custom",
      name: "线索",
      description: "",
      prompt: "",
    });

    const renamed = await tables.update(space.id, created!.id, { key: "trails", name: "轨迹" });
    expect(renamed).toMatchObject({ key: "trails", name: "轨迹" });
    expect(await tableRepository.findByKey(space.id, "clues" as MemoryTableKey)).toBeUndefined();
    expect(await tableRepository.findByKey(space.id, "trails" as MemoryTableKey)).toEqual(renamed);
  });

  it("lists tables in creation order with deterministic tiebreak", async () => {
    const times = [
      "2026-07-28T00:00:00.000Z",
      "2026-07-28T01:00:00.000Z",
      "2026-07-28T02:00:00.000Z",
    ];
    let index = 0;
    const { spaces, tables, tableRepository } = createServices(
      createTestDatabase(),
      () => times[index++]!,
    );
    const space = await spaces.create("会话");
    const first = await tables.create(space.id, {
      key: "clues",
      kind: "custom",
      name: "线索",
      description: "",
      prompt: "",
    });
    const second = await tables.create(space.id, {
      key: "items",
      kind: "custom",
      name: "物品",
      description: "",
      prompt: "",
    });

    expect(await tableRepository.list(space.id)).toEqual([first, second]);
  });

  it("service create returns undefined for a missing space", async () => {
    const { tables } = createServices(createTestDatabase());
    const created = await tables.create("missing" as MemorySpaceId, {
      key: "clues",
      kind: "custom",
      name: "线索",
      description: "",
      prompt: "",
    });
    expect(created).toBeUndefined();
  });

  it("cascades deletion to the table's fields", async () => {
    const { spaces, tables, fields, fieldRepository } = createServices(createTestDatabase());
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

    expect(await tables.delete(space.id, table!.id)).toBe(true);

    // 与 SQLite 参照实现 ON DELETE CASCADE 同语义：字段定义一并物理删除
    expect(await fieldRepository.list(space.id, table!.id)).toEqual([]);
    expect(await fieldRepository.find(space.id, table!.id, "field-1" as MemoryFieldId)).toBeUndefined();
  });
});
