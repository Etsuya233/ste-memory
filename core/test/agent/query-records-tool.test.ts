import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  QUERY_RECORDS_TOOL_NAME,
  QueryRecordsToolError,
  buildMemorySpaceTableDigest,
  createQueryRecordsTool,
} from "../../src/memory/application/agent/index.ts";
import type { QueryRecordsInput } from "../../src/memory/index.ts";
import { createTestMemorySpace, type TestMemorySpace } from "./memory-space-fixture.ts";

async function toolWith(space: TestMemorySpace = createTestMemorySpace()) {
  const digest = await buildMemorySpaceTableDigest(space.reader, space.memorySpaceId);
  return createQueryRecordsTool({ reader: space.reader, digest });
}

function textOf(result: { content: { type: string; text?: string }[] }) {
  const text = result.content.find((block) => block.type === "text")?.text;
  expect(text).toBeDefined();
  return JSON.parse(text!) as Record<string, unknown>;
}

function captureQueries(space: TestMemorySpace) {
  const captured: QueryRecordsInput[] = [];
  const original = space.reader.queryRecords;
  space.reader.queryRecords = async (memorySpaceId, input) => {
    captured.push(input);
    return original(memorySpaceId, input);
  };
  return captured;
}

describe("query_records 参数 schema", () => {
  it("合法参数通过 pi 校验（形状错误由引擎在 execute 前拦截）", async () => {
    const tool = await toolWith();
    const args = {
      table: "characters",
      fields: ["name"],
      conditions: [{ field: "current_status", op: "contains", value: "受伤" }],
      paging: { page: 1, pageSize: 20 },
      orderBy: { field: "$updated_at", direction: "desc" },
    };
    const toolCall = { id: "call-1", name: QUERY_RECORDS_TOOL_NAME, arguments: args };
    expect(() => validateToolArguments(tool, toolCall)).not.toThrow();
  });

  it("未知 op 与非法分页被 pi 校验拦截", async () => {
    const tool = await toolWith();
    const call = (args: Record<string, unknown>) => ({
      id: "call-1",
      name: QUERY_RECORDS_TOOL_NAME,
      arguments: args,
    });

    expect(() =>
      validateToolArguments(
        tool,
        call({ table: "characters", conditions: [{ field: "name", op: "bogus", value: "x" }] }),
      ),
    ).toThrow(/must be equal to one of the allowed values/);
    expect(() =>
      validateToolArguments(
        tool,
        call({ table: "characters", paging: { page: 1, pageSize: "x" } }),
      ),
    ).toThrow(/must be integer/);
    expect(() =>
      validateToolArguments(
        tool,
        call({
          table: "characters",
          conditions: [{ field: "name", op: "equals", value: { x: 1 } }],
        }),
      ),
    ).toThrow(/Validation failed/);
  });
});

describe("query_records 执行器：key 校验与错误回喂", () => {
  it("未知表 key 报错并附带可用表 key 列表", async () => {
    const tool = await toolWith();
    await expect(tool.execute("call-1", { table: "characterss" })).rejects.toThrow(
      new QueryRecordsToolError(
        `表 key「characterss」不存在或未启用。可用表 key：characters、locations。`,
      ),
    );
  });

  it("未知/未启用字段 key 报错并附带可用字段 key 列表", async () => {
    const tool = await toolWith();
    await expect(tool.execute("call-1", { table: "characters", fields: ["nmae"] })).rejects.toThrow(
      /字段 key「nmae」在表「characters」中不存在或未启用（投影字段）/,
    );
    await expect(
      tool.execute("call-1", { table: "characters", fields: ["secret_notes"] }),
    ).rejects.toThrow(/字段 key「secret_notes」在表「characters」中不存在或未启用/);
    await expect(
      tool.execute("call-1", {
        table: "characters",
        conditions: [{ field: "nmae", op: "equals", value: "x" }],
      }),
    ).rejects.toThrow(/（条件字段）.*可用字段 key：name、current_status、location、aliases/);
  });

  it("系统字段不能用于投影，只可用于条件/排序", async () => {
    const tool = await toolWith();
    await expect(
      tool.execute("call-1", { table: "characters", fields: ["$record_id"] }),
    ).rejects.toThrow(/系统字段「\$record_id」不能用于投影 fields/);
  });

  it("服务层 op×类型不匹配转可读信息回喂（含字段 key）", async () => {
    const tool = await toolWith();
    await expect(
      tool.execute("call-1", {
        table: "characters",
        conditions: [{ field: "current_status", op: "contains", value: "受伤" }],
      }),
    ).rejects.toThrow(/查询被拒绝：操作符或值与字段类型不匹配，字段：current_status/);
  });

  it("分页默认 page 1 / pageSize 20，透传自定义分页", async () => {
    const space = createTestMemorySpace();
    const captured = captureQueries(space);
    const tool = await toolWith(space);

    await tool.execute("call-1", { table: "characters" });
    expect(captured[0]?.paging).toEqual({ page: 1, pageSize: 20 });

    await tool.execute("call-1", { table: "characters", paging: { page: 2, pageSize: 1 } });
    expect(captured[1]?.paging).toEqual({ page: 2, pageSize: 1 });
  });

  it("超过服务层 pageSize 上限（100）的查询被拒绝并回喂可读错误", async () => {
    const tool = await toolWith();
    await expect(
      tool.execute("call-1", { table: "characters", paging: { page: 1, pageSize: 101 } }),
    ).rejects.toThrow(/查询被拒绝：分页无效（page 从 1 起，pageSize 为 1–100）/);
  });
});

describe("query_records 执行器：结果形状", () => {
  it("返回 { id, revisionId, display, values }，values 用字段 key 键控，剥掉证据/来源噪音", async () => {
    const tool = await toolWith();
    const result = textOf(
      await tool.execute("call-1", {
        table: "characters",
        conditions: [{ field: "current_status", op: "equals", value: "受伤" }],
      }),
    );

    expect(result).toMatchObject({
      table: "characters",
      page: 1,
      pageSize: 20,
      total: 2,
      totalPages: 1,
    });
    const records = result.records as Record<string, unknown>[];
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      id: "record-1",
      revisionId: "revision-record-1",
      display: "云烬",
      values: {
        name: "云烬",
        current_status: "受伤",
        location: "loc-1",
        aliases: ["云烬", "烬"],
      },
    });
    expect(records[0]).not.toHaveProperty("fieldEvidence");
    expect(records[0]).not.toHaveProperty("source");
    expect(records[0]).not.toHaveProperty("tableId");
    expect(records[0]).not.toHaveProperty("memorySpaceId");
  });

  it("不指定 fields 返回全部启用字段；指定 fields 只做投影", async () => {
    const tool = await toolWith();
    const projected = textOf(
      await tool.execute("call-1", { table: "characters", fields: ["name"] }),
    );
    const records = projected.records as Record<string, unknown>[];
    expect(Object.keys(records[0]!.values as Record<string, unknown>)).toEqual(["name"]);

    const all = textOf(await tool.execute("call-1", { table: "characters" }));
    const allRecords = all.records as Record<string, unknown>[];
    expect(Object.keys(allRecords[0]!.values as Record<string, unknown>).sort()).toEqual([
      "aliases",
      "current_status",
      "location",
      "name",
    ]);
  });

  it("系统字段条件（$display_text）与排序走通", async () => {
    const tool = await toolWith();
    const result = textOf(
      await tool.execute("call-1", {
        table: "characters",
        conditions: [{ field: "$display_text", op: "contains", value: "云" }],
        orderBy: { field: "$updated_at", direction: "desc" },
      }),
    );
    const records = result.records as { display: string }[];
    expect(records.map((record) => record.display)).toEqual(["云烬"]);
  });

  it("空结果返回空 records 数组（模型据此判断「该新建」）", async () => {
    const tool = await toolWith();
    const result = textOf(
      await tool.execute("call-1", {
        table: "characters",
        conditions: [{ field: "current_status", op: "equals", value: "死亡" }],
      }),
    );
    expect(result).toMatchObject({ total: 0, totalPages: 0, records: [] });
  });
});
