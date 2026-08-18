import { afterEach, describe, expect, it } from "vitest";
import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { buildServer } from "../src/adapters/inbound/http/server.ts";
import { createTestApplication } from "./test-application.ts";

const servers: Awaited<ReturnType<typeof buildServer>>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/**
 * SQLite 参照实现（spec reset-space）：清除空间记录 / 重置空间的删除语义
 * （本轮不加 API 路由，直接经 core MemorySpaceService 验证 Kysely 实现）。
 */
describe("SQLite 参照实现：清除空间记录 / 重置空间（spec reset-space）", () => {
  it("clearRecords 删除记录/历史/证据，保留表格结构", async () => {
    const {
      server,
      spaces,
      systemTables,
      tableRepository,
      fieldRepository,
      memoryRecords,
      recordRepository,
    } = await createTestApplication("ste-memory-reset-", "2026-07-27T00:00:00.000Z");
    servers.push(server);
    const space = await spaces.create("会话");
    await systemTables.install(space.id);

    const tables = await tableRepository.list(space.id);
    expect(tables).toHaveLength(8);
    const characters = tables.find((table) => table.key === "characters")!;
    const fields = await fieldRepository.list(space.id, characters.id);
    const name = fields.find((field) => field.name === "名称")!;
    const record = await memoryRecords.create(space.id, characters.id, {
      payload: { [name.id]: "林夏" },
      fieldEvidence: {
        [name.id]: [{ source_type: "message", source_id: 7, storage_mode: "reference" }],
      },
    });
    expect(record).toBeDefined();
    // 更新一次 → 历史行
    await memoryRecords.update(space.id, characters.id, record!.id, {
      expectedRevisionId: record!.revisionId,
      revisionSource: "user",
      patch: { [name.id]: "林夏（改）" },
    });

    const existed = await spaces.clearRecords(space.id);
    expect(existed).toBe(true);

    expect((await recordRepository.list(space.id, characters.id)).length).toBe(0);
    expect((await recordRepository.listHistory({ memorySpaceId: space.id })).length).toBe(0);
    expect(await recordRepository.findEvidence(space.id, "message", 7)).toBeUndefined();
    // 表格结构保留
    expect(await tableRepository.list(space.id)).toHaveLength(8);
    expect(await spaces.find(space.id)).toMatchObject({ id: space.id, name: "会话" });
  });

  it("deleteAllTables 删除全部表格（级联字段/记录/历史/证据），空间实体保留", async () => {
    const {
      server,
      spaces,
      systemTables,
      tableRepository,
      fieldRepository,
      memoryRecords,
      recordRepository,
    } = await createTestApplication("ste-memory-reset-", "2026-07-27T00:00:00.000Z");
    servers.push(server);
    const space = await spaces.create("会话");
    await systemTables.install(space.id);
    const tables = await tableRepository.list(space.id);
    const characters = tables.find((table) => table.key === "characters")!;
    const fields = await fieldRepository.list(space.id, characters.id);
    const name = fields.find((field) => field.name === "名称")!;
    const record = await memoryRecords.create(space.id, characters.id, {
      payload: { [name.id]: "林夏" },
      fieldEvidence: {
        [name.id]: [{ source_type: "message", source_id: 8, storage_mode: "reference" }],
      },
    });
    expect(record).toBeDefined();

    const existed = await spaces.deleteAllTables(space.id);
    expect(existed).toBe(true);

    expect(await tableRepository.list(space.id)).toEqual([]);
    expect(await fieldRepository.list(space.id, characters.id)).toEqual([]);
    expect((await recordRepository.list(space.id, characters.id)).length).toBe(0);
    expect((await recordRepository.listHistory({ memorySpaceId: space.id })).length).toBe(0);
    expect(await recordRepository.findEvidence(space.id, "message", 8)).toBeUndefined();
    // 空间实体保留
    expect(await spaces.find(space.id)).toMatchObject({ id: space.id, name: "会话" });
  });

  it("空间不存在：clearRecords / deleteAllTables 返回 false", async () => {
    const { server, spaces } = await createTestApplication(
      "ste-memory-reset-",
      "2026-07-27T00:00:00.000Z",
    );
    servers.push(server);

    expect(await spaces.clearRecords("missing-space" as MemorySpaceId)).toBe(false);
    expect(await spaces.deleteAllTables("missing-space" as MemorySpaceId)).toBe(false);
  });
});
