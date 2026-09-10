import { describe, expect, it } from "vitest";
// 必须先于 ./log-database.ts 导入：dexie 在模块加载时捕获全局 indexedDB，
// fake-indexeddb 必须在它之前求值（否则 MissingAPIError）
import { NOW, createTestDatabase, createTestLogDatabase } from "./test-support.ts";
import { DexieLogRepository } from "./log-repository.ts";
import type { LogAppendInput } from "../logging/log.ts";

function input(overrides: Partial<LogAppendInput> = {}): LogAppendInput {
  return {
    type: "fill-task",
    key: "run-1",
    level: "info",
    text: '{\n  "phase": "start"\n}',
    ...overrides,
  };
}

describe("Dexie 通用日志仓库（独立数据库，ADR 0015）", () => {
  it("追加：自增 id + 注入 createdAt，行含 type/key/level/text 且无 spaceId", async () => {
    const times = ["2026-07-28T00:00:00.000Z", "2026-07-28T01:00:00.000Z"];
    let index = 0;
    const logs = new DexieLogRepository(createTestLogDatabase(), { now: () => times[index++]! });

    await logs.append(input({ level: "info" }));
    await logs.append(input({ level: "error", text: "文本载荷" }));

    const rows = await logs.byKey("run-1", 10);
    expect(rows).toEqual([
      {
        id: 2,
        type: "fill-task",
        key: "run-1",
        level: "error",
        text: "文本载荷",
        createdAt: "2026-07-28T01:00:00.000Z",
      },
      {
        id: 1,
        type: "fill-task",
        key: "run-1",
        level: "info",
        text: '{\n  "phase": "start"\n}',
        createdAt: "2026-07-28T00:00:00.000Z",
      },
    ]);
    // 独立库行结构：没有记忆空间字段（不随空间删除级联）
    expect(rows[0]).not.toHaveProperty("spaceId");
  });

  it("recent：跨类型按插入顺序倒序，limit 截断", async () => {
    const logs = new DexieLogRepository(createTestLogDatabase(), { now: () => NOW });

    await logs.append(input({ type: "fill-task", key: "run-1" }));
    await logs.append(input({ type: "fill-run", key: "run-1" }));
    await logs.append(input({ type: "fill-agent", key: "run-2" }));

    expect((await logs.recent(10)).map((row) => row.key)).toEqual(["run-2", "run-1", "run-1"]);
    expect((await logs.recent(2)).map((row) => row.key)).toEqual(["run-2", "run-1"]);
    expect((await logs.recent(10)).map((row) => row.id)).toEqual([3, 2, 1]);
  });

  it("byKey：指定 key 按插入顺序倒序，limit 截断；其他 key 不匹配", async () => {
    const logs = new DexieLogRepository(createTestLogDatabase(), { now: () => NOW });

    await logs.append(input({ key: "run-1", text: "第一条" }));
    await logs.append(input({ key: "run-2", text: "其他任务" }));
    await logs.append(input({ key: "run-1", text: "第二条" }));

    expect((await logs.byKey("run-1", 10)).map((row) => row.text)).toEqual(["第二条", "第一条"]);
    expect((await logs.byKey("run-1", 1)).map((row) => row.text)).toEqual(["第二条"]);
    expect(await logs.byKey("run-missing", 10)).toEqual([]);
  });

  it("修剪：追加后超过上限时同一事务删除最旧行", async () => {
    const logs = new DexieLogRepository(createTestLogDatabase(), { limit: 3, now: () => NOW });

    for (let i = 1; i <= 5; i += 1) {
      await logs.append(input({ key: `run-${i}` }));
    }

    expect((await logs.recent(10)).map((row) => row.key)).toEqual([
      "run-5",
      "run-4",
      "run-3",
    ]);
  });

  it("clearAll：清空全部行", async () => {
    const logs = new DexieLogRepository(createTestLogDatabase(), { now: () => NOW });

    await logs.append(input());
    await logs.append(input({ key: "run-2" }));
    await logs.clearAll();

    expect(await logs.recent(10)).toEqual([]);
  });

  it("旧主库日志表不受影响：独立库写入不触碰旧表（原地保留）", async () => {
    const mainDb = createTestDatabase();
    const legacy = mainDb.table("memoryLogs");
    await legacy.add({
      id: 1,
      type: "fill",
      key: "old-run",
      spaceId: null,
      level: "info",
      data: { legacy: true },
      createdAt: NOW,
    });

    const logs = new DexieLogRepository(createTestLogDatabase(), { now: () => NOW });
    await logs.append(input());
    await logs.clearAll();

    expect(await legacy.count()).toBe(1);
  });
});
