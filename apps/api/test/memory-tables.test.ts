import type { MemoryFieldType } from "@ste-memory/core";
import { afterEach, describe, expect, it } from "vitest";
import type { buildServer } from "../src/server.ts";
import { createTestApplication } from "./test-application.ts";

const servers: Awaited<ReturnType<typeof buildServer>>[] = [];

async function testServer() {
  const { server, spaces } = await createTestApplication(
    "ste-memory-tables-",
    "2026-07-28T00:00:00.000Z",
  );
  servers.push(server);
  return { server, spaces };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("memory table API", () => {
  it("creates and lists an empty custom table in its memory space", async () => {
    const { server, spaces } = await testServer();
    const space = await spaces.create("会话");

    const response = await server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/tables`,
      payload: {
        key: "clues",
        name: "线索",
        description: "值得追踪的线索",
        prompt: "只保留仍可能影响后续情节的内容。",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      memorySpaceId: space.id,
      kind: "custom",
      name: "线索",
      description: "值得追踪的线索",
      prompt: "只保留仍可能影响后续情节的内容。",
      enabled: true,
    });
    expect(
      (await server.inject({ method: "GET", url: `/memory-spaces/${space.id}/tables` })).json(),
    ).toContainEqual(response.json());
  });

  it("updates, disables, reads, and physically deletes a table", async () => {
    const { server, spaces } = await testServer();
    const space = await spaces.create("会话");
    const created = await server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/tables`,
      payload: { key: "clues", name: "线索" },
    });
    const table = created.json<{ id: string }>();

    const updated = await server.inject({
      method: "PATCH",
      url: `/memory-spaces/${space.id}/tables/${table.id}`,
      payload: {
        name: "关键线索",
        description: "只跟踪关键线索",
        prompt: "忽略已经完全回收的线索。",
        enabled: false,
      },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      name: "关键线索",
      description: "只跟踪关键线索",
      prompt: "忽略已经完全回收的线索。",
      enabled: false,
    });
    expect(
      (
        await server.inject({
          method: "GET",
          url: `/memory-spaces/${space.id}/tables/${table.id}`,
        })
      ).json(),
    ).toEqual(updated.json());

    expect(
      (
        await server.inject({
          method: "DELETE",
          url: `/memory-spaces/${space.id}/tables/${table.id}`,
        })
      ).statusCode,
    ).toBe(204);
    const missing = await server.inject({
      method: "GET",
      url: `/memory-spaces/${space.id}/tables/${table.id}`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("creates and lists every v1 field type with its type-specific configuration", async () => {
    const { server, spaces } = await testServer();
    const space = await spaces.create("会话");
    const tableResponse = await server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/tables`,
      payload: { key: "people", name: "人物" },
    });
    const table = tableResponse.json<{ id: string }>();
    const types: MemoryFieldType[] = [
      "short_text",
      "long_text",
      "short_text_list",
      "integer",
      "decimal",
      "boolean",
      "date",
      "datetime",
      "single_select",
      "multi_select",
      "single_reference",
      "multi_reference",
    ];

    for (const [position, type] of types.entries()) {
      const response = await server.inject({
        method: "POST",
        url: `/memory-spaces/${space.id}/tables/${table.id}/fields`,
        payload: {
          key: `field-${position + 1}`,
          name: `字段 ${position + 1}`,
          type,
          required: position === 0,
          prompt: "字段填写规则",
          enabled: true,
          position,
          ...(type.endsWith("select") ? { options: ["选项 A", "选项 B"] } : {}),
          ...(type.endsWith("reference") ? { referenceTableId: table.id } : {}),
        },
      });
      expect(response.statusCode, response.body).toBe(201);
    }

    const listed = await server.inject({
      method: "GET",
      url: `/memory-spaces/${space.id}/tables/${table.id}/fields`,
    });
    expect(listed.json<{ type: MemoryFieldType }[]>().map((field) => field.type)).toEqual(types);
  });

  it("updates and deletes fields while enforcing display strategy and immutable types", async () => {
    const { server, spaces } = await testServer();
    const space = await spaces.create("会话");
    const table = (
      await server.inject({
        method: "POST",
        url: `/memory-spaces/${space.id}/tables`,
        payload: { key: "people", name: "人物" },
      })
    ).json<{ id: string }>();
    const field = (
      await server.inject({
        method: "POST",
        url: `/memory-spaces/${space.id}/tables/${table.id}/fields`,
        payload: {
          key: "name",
          name: "名称",
          type: "short_text",
          required: true,
          prompt: "",
          enabled: true,
          position: 0,
        },
      })
    ).json<{ id: string }>();

    const updated = await server.inject({
      method: "PATCH",
      url: `/memory-spaces/${space.id}/tables/${table.id}/fields/${field.id}`,
      payload: {
        name: "人物名称",
        required: true,
        prompt: "保留原始称呼。",
        enabled: false,
        position: 1,
      },
    });
    expect(updated.json()).toMatchObject({
      field: { name: "人物名称", enabled: false, position: 1 },
      warnings: ["停用必填字段后，Agent 可能无法创建合法记录"],
    });

    const changedType = await server.inject({
      method: "PATCH",
      url: `/memory-spaces/${space.id}/tables/${table.id}/fields/${field.id}`,
      payload: { type: "long_text" },
    });
    expect(changedType.statusCode).toBe(400);
    expect(changedType.json()).toMatchObject({ type: "memory_field_type_immutable" });

    await server.inject({
      method: "PATCH",
      url: `/memory-spaces/${space.id}/tables/${table.id}/fields/${field.id}`,
      payload: { enabled: true },
    });

    const display = await server.inject({
      method: "PUT",
      url: `/memory-spaces/${space.id}/tables/${table.id}/display-strategy`,
      payload: { type: "field", fieldId: field.id },
    });
    expect(display.json()).toMatchObject({ displayStrategy: { type: "field", fieldId: field.id } });

    const protectedDelete = await server.inject({
      method: "DELETE",
      url: `/memory-spaces/${space.id}/tables/${table.id}/fields/${field.id}`,
    });
    expect(protectedDelete.statusCode).toBe(400);
    expect(protectedDelete.json()).toMatchObject({ type: "memory_field_used_by_display_strategy" });
  });
});
