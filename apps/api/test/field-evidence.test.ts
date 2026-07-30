import { afterEach, describe, expect, it } from "vitest";
import type { buildServer } from "../src/adapters/inbound/http/server.ts";
import { createTestApplication } from "./test-application.ts";

const servers: Awaited<ReturnType<typeof buildServer>>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("field evidence API", () => {
  it("persists snapshot and reference evidence, reuses source identity, and archives old evidence", async () => {
    const application = await createTestApplication(
      "ste-field-evidence-",
      "2026-07-30T01:02:03.000Z",
    );
    servers.push(application.server);
    const space = await application.spaces.create("会话");
    await application.systemTables.install(space.id);
    const table = (await application.tableRepository.list(space.id)).find(
      (item) => item.key === "characters",
    )!;
    const fields = await application.fieldRepository.list(space.id, table.id);
    const name = fields.find((field) => field.name === "名称")!;
    const identity = fields.find((field) => field.name === "身份/定位")!;
    const snapshot = {
      source_type: "sillytavern_jsonl",
      source_id: 7,
      content: "林夏自称调查员。",
      storage_mode: "snapshot",
      extraProps: { name: "林夏", lineNumber: 8 },
    } as const;
    const reference = {
      source_type: "sillytavern_jsonl",
      source_id: 8,
      content: "这段正文只在 Source Store 中保留。",
      storage_mode: "reference",
      extraProps: { lineNumber: 9 },
    } as const;

    const created = await application.server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/tables/${table.id}/records`,
      payload: {
        payload: { [name.id]: "林夏", [identity.id]: "调查员" },
        fieldEvidence: { [name.id]: [snapshot], [identity.id]: [reference] },
      },
    });

    expect(created.statusCode).toBe(201);
    const record = created.json<{
      id: string;
      revisionId: string;
      fieldEvidence: Record<string, Array<Record<string, unknown>>>;
    }>();
    expect(record.fieldEvidence[name.id]![0]).toMatchObject({
      source_id: 7,
      storage_mode: "snapshot",
      content: snapshot.content,
      extraProps: snapshot.extraProps,
    });
    expect(record.fieldEvidence[identity.id]![0]).toMatchObject({
      source_id: 8,
      storage_mode: "reference",
      extraProps: reference.extraProps,
    });
    expect(record.fieldEvidence[identity.id]![0]).not.toHaveProperty("content");

    const duplicate = await application.server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/tables/${table.id}/records`,
      payload: {
        payload: { [name.id]: "林夏（化名）" },
        fieldEvidence: { [name.id]: [snapshot] },
      },
    });
    expect(duplicate.json().fieldEvidence[name.id][0].evidence_id).toBe(
      record.fieldEvidence[name.id]![0]!.evidence_id,
    );

    const updated = await application.server.inject({
      method: "PATCH",
      url: `/memory-spaces/${space.id}/tables/${table.id}/records/${record.id}`,
      payload: { expectedRevisionId: record.revisionId, patch: { [name.id]: "林夏（修订）" } },
    });
    expect(updated.json().fieldEvidence[name.id]).toEqual([]);
    expect(updated.json().fieldEvidence[identity.id]).toHaveLength(1);

    const history = await application.server.inject({
      method: "GET",
      url: `/memory-spaces/${space.id}/record-history?recordId=${record.id}`,
    });
    expect(history.json()[0].fieldEvidence[name.id][0]).toMatchObject({
      source_id: 7,
      content: snapshot.content,
    });
  });
});
