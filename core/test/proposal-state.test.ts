import { describe, expect, it } from "vitest";
import { ProposalState } from "../src/memory/application/agent/index.ts";

function create(overrides: Partial<Parameters<ProposalState["apply"]>[0]> = {}) {
  return {
    op: "create" as const,
    tableKey: "characters",
    tempId: "tmp:1",
    patch: { name: "张三" },
    ...overrides,
  };
}

function update(overrides: Partial<Parameters<ProposalState["apply"]>[0]> = {}) {
  return {
    op: "update" as const,
    tableKey: "characters",
    recordId: "record-1",
    expectedRevisionId: "revision-record-1",
    patch: { current_status: "死亡" },
    ...overrides,
  };
}

function remove(overrides: Partial<Parameters<ProposalState["apply"]>[0]> = {}) {
  return {
    op: "delete" as const,
    tableKey: "characters",
    recordId: "record-2",
    expectedRevisionId: "revision-record-2",
    patch: {},
    ...overrides,
  };
}

describe("ProposalState", () => {
  it("分配 mutationId（M1 起）与 tempId（tmp:n 起，独立计数）", () => {
    const state = new ProposalState();
    expect(state.allocateTempId()).toBe("tmp:1");
    expect(state.allocateTempId()).toBe("tmp:2");
    expect(state.apply(create({ tempId: "tmp:1" })).mutationId).toBe("M1");
    expect(state.apply(update()).mutationId).toBe("M2");
    expect(state.operations).toHaveLength(2);
  });

  it("同表同 tempId 的 create 覆盖：mutationId 保持不变、replaced 为 true", () => {
    const state = new ProposalState();
    const first = state.apply(create({ tempId: "tmp:1", patch: { name: "张三" } }));
    const second = state.apply(create({ tempId: "tmp:1", patch: { name: "李四" } }));
    expect(first.mutationId).toBe("M1");
    expect(second.mutationId).toBe("M1");
    expect(second.replaced).toBe(true);
    expect(state.operations).toHaveLength(1);
    expect(state.operations[0]!.patch).toEqual({ name: "李四" });
  });

  it("同表同 recordId 跨 op 覆盖：update 后 delete 变成 delete，delete 后 update 取消删除", () => {
    const state = new ProposalState();
    const updated = state.apply(update());
    const deleted = state.apply(remove({ recordId: "record-1" }));
    expect(deleted.mutationId).toBe(updated.mutationId);
    expect(state.operations[0]!.op).toBe("delete");

    const restored = state.apply(update());
    expect(restored.mutationId).toBe(updated.mutationId);
    expect(restored.replaced).toBe(true);
    expect(state.operations[0]!.op).toBe("update");
    expect(state.operations).toHaveLength(1);
  });

  it("不同表同 recordId 不冲突，各自独立", () => {
    const state = new ProposalState();
    state.apply(update({ tableKey: "characters" }));
    state.apply(update({ tableKey: "locations", recordId: "record-1" }));
    expect(state.operations).toHaveLength(2);
    expect(state.operations.map((operation) => operation.mutationId)).toEqual(["M1", "M2"]);
  });

  it("drop 按 mutationId 移除并返回剩余数；不存在返回 undefined", () => {
    const state = new ProposalState();
    const first = state.apply(create());
    state.apply(update());
    const dropped = state.drop(first.mutationId);
    expect(dropped).toMatchObject({ dropped: "M1", remaining: 1 });
    expect(state.drop("M99")).toBeUndefined();
    expect(state.drop("M1")).toBeUndefined();
  });

  it("createTempIds 汇总批次内 create 的 tempId", () => {
    const state = new ProposalState();
    state.apply(create({ tempId: "tmp:1" }));
    state.apply(create({ tempId: "tmp:2", tableKey: "locations" }));
    state.apply(update());
    expect([...state.createTempIds()].sort()).toEqual(["tmp:1", "tmp:2"]);
  });

  it("findByTempId 返回对应 create 操作，跨表复用可被工具层拒绝", () => {
    const state = new ProposalState();
    state.apply(create({ tempId: "tmp:1" }));
    expect(state.findByTempId("tmp:1")).toMatchObject({ tableKey: "characters" });
    expect(state.findByTempId("tmp:9")).toBeUndefined();
  });

  it("提交后锁定：apply/drop 抛错，frozenProposal 可提取", () => {
    const state = new ProposalState();
    state.apply(create());
    const proposal = { marker: "frozen" } as never;
    state.markSubmitted(proposal);
    expect(state.submitted).toBe(true);
    expect(state.frozenProposal).toBe(proposal);
    expect(() => state.apply(update())).toThrow(/已提交并冻结/);
    expect(() => state.drop("M1")).toThrow(/已提交并冻结/);
  });

  it("未提交时 frozenProposal 为 undefined", () => {
    expect(new ProposalState().frozenProposal).toBeUndefined();
  });
});
