import { describe, expect, it } from "vitest";
import { prepareSummaryGroups } from "./summary-groups.ts";
import type {
  MemoryProposalPorts,
  MemorySpaceId,
  MemoryProposalOperation,
} from "../memory/index.ts";
import type { MemorySpaceTableDigest } from "./digest.ts";

async function setup(count = 20) {
  const digest = {
    summaryRules: [
      {
        sourceTableKey: "notes",
        targetTableKey: "summaries",
        referenceFieldKey: "group",
        groupSize: 15,
        retainCount: 5,
      },
    ],
    tables: [
      {
        id: "notes",
        key: "notes",
        fields: [
          { id: "group", key: "group", type: "single_reference", referenceTableKey: "summaries" },
        ],
      },
      { id: "summaries", key: "summaries", fields: [] },
    ],
  } as unknown as MemorySpaceTableDigest;
  const records = Array.from({ length: count }, (_, i) => ({
    id: `r${String(i).padStart(2, "0")}`,
    createdAt: "2026-01-01",
    payload: {},
  }));
  const ports = {
    records: { list: async () => [...records].reverse() },
  } as unknown as MemoryProposalPorts;
  const group = await prepareSummaryGroups(ports, "space" as MemorySpaceId, digest);
  const operations = [
    { type: "create", tableId: "summaries", tempId: "tmp:1", patch: {}, externalId: "M1" },
    ...records.slice(0, 15).map((record) => ({
      type: "update",
      tableId: "notes",
      recordId: record.id,
      patch: { group: "tmp:1" },
    })),
  ] as unknown as MemoryProposalOperation[];
  return { group, operations };
}

describe("总结归组提交校验", () => {
  it("恰好关联最早15条，保留至少5条时通过", async () => {
    const { group, operations } = await setup();
    expect(group.validate(operations)).toEqual([]);
    expect(group.instructions).toContain('"r00"');
  });
  it("漏关联一条时指出缺少的来源ID", async () => {
    const { group, operations } = await setup();
    expect(group.validate(operations.slice(0, -1))[0]!.message).toContain('"r14"');
  });
  it("不能把本批新建来源算入门槛", async () => {
    const { group, operations } = await setup(19);
    expect(group.validate(operations)[0]!.message).toContain("须达到 20 条");
  });
  it("即使条数正确也拒绝换成较新的来源", async () => {
    const { group, operations } = await setup();
    operations[1] = { ...operations[1], recordId: "r19" } as MemoryProposalOperation;
    expect(group.validate(operations)[0]!.message).toContain('"r00"');
  });
  it("拒绝把本批新建来源关联到新总结", async () => {
    const { group, operations } = await setup();
    operations.push({
      type: "create",
      tableId: "notes",
      tempId: "tmp:2",
      patch: { group: "tmp:1" },
    } as unknown as MemoryProposalOperation);
    expect(group.validate(operations)[0]!.message).toContain("不得关联本批新建记录");
  });
});
