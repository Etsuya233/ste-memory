import { afterEach, describe, expect, it } from "vitest";
import type { buildServer } from "../src/adapters/inbound/http/server.ts";
import { createTestApplication } from "./test-application.ts";

const servers: Awaited<ReturnType<typeof buildServer>>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("query records API", () => {
  it("queries by typed AND conditions with field projection and stable pagination", async () => {
    const { server, spaces, systemTables, tableRepository, fieldRepository } =
      await createTestApplication("ste-query-records-", "2026-07-30T01:02:03.000Z");
    servers.push(server);
    const space = await spaces.create("会话");
    await systemTables.install(space.id);
    const table = (await tableRepository.list(space.id)).find((item) => item.key === "characters")!;
    const fields = await fieldRepository.list(space.id, table.id);
    const name = fields.find((field) => field.name === "名称")!;
    const identity = fields.find((field) => field.name === "身份/定位")!;

    for (const payload of [
      { [name.id]: "顾川", [identity.id]: "主角" },
      { [name.id]: "周遥", [identity.id]: "配角" },
      { [name.id]: "林夏", [identity.id]: "主角" },
    ]) {
      expect(
        (
          await server.inject({
            method: "POST",
            url: `/memory-spaces/${space.id}/tables/${table.id}/records`,
            payload: { payload },
          })
        ).statusCode,
      ).toBe(201);
    }

    const response = await server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/query-records`,
      payload: {
        tableId: table.id,
        fieldIds: [name.id],
        conditions: [{ fieldId: identity.id, operator: "equals", value: "主角" }],
        paging: { page: 1, pageSize: 1 },
        order: { fieldId: name.id, direction: "asc" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      total: 2,
      totalPages: 2,
      records: [{ displayText: "林夏", payload: { [name.id]: "林夏" } }],
    });
    expect(response.json().records[0].payload[identity.id]).toBeUndefined();
  });

  it("returns query context for invalid field conditions", async () => {
    const { server, spaces, systemTables, tableRepository, fieldRepository } =
      await createTestApplication("ste-query-records-invalid-", "2026-07-30T01:02:03.000Z");
    servers.push(server);
    const space = await spaces.create("会话");
    await systemTables.install(space.id);
    const table = (await tableRepository.list(space.id)).find((item) => item.key === "characters")!;
    const name = (await fieldRepository.list(space.id, table.id)).find(
      (field) => field.name === "名称",
    )!;
    const conditions = [{ fieldId: "missing-field", operator: "equals", value: "林夏" }];
    const paging = { page: 3, pageSize: 7 };
    const order = { fieldId: name.id, direction: "desc" };

    const response = await server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/query-records`,
      payload: { tableId: table.id, fieldIds: [name.id], conditions, paging, order },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      type: "memory_record_query_invalid",
      param: {
        tableId: table.id,
        fieldId: "missing-field",
        conditions,
        paging,
        order,
        reason: "condition_field_not_found",
      },
    });
  });
});
