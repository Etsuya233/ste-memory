import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  MUTATE_TOOL_NAME,
  ProposalState,
  buildMemorySpaceTableDigest,
  createMutateTool,
} from "../../src/memory/application/agent/index.ts";
import { createTestMemorySpace, type TestMemorySpace } from "./memory-space-fixture.ts";

async function toolWith(space: TestMemorySpace = createTestMemorySpace()) {
  const digest = await buildMemorySpaceTableDigest(space.reader, space.memorySpaceId);
  return createMutateTool({
    digest,
    state: new ProposalState(),
    validateOperation: async () => [],
  });
}

describe("mutate 参数 schema：线上形状（OpenAI 兼容服务端）", () => {
  it("序列化后顶层 type 必须是 object（DeepSeek 等拒绝无顶层 type 的 anyOf schema，回归 2026-08-06）", async () => {
    const tool = await toolWith();
    // JSON 序列化 = 实际发往服务端 tools[].function.parameters 的形状
    const wire = JSON.parse(JSON.stringify(tool.parameters));
    expect(wire.type).toBe("object");
    // 判别式校验仍然保留（anyOf 兄弟关键字，不是宽松单对象）
    expect(wire.anyOf).toBeDefined();
  });
});

describe("mutate 参数 schema：本地校验仍然严格", () => {
  it("合法参数通过 pi 校验（三种 op 各自形状）", async () => {
    const tool = await toolWith();
    const call = (args: Record<string, unknown>) => ({
      id: "call-1",
      name: MUTATE_TOOL_NAME,
      arguments: args,
    });
    expect(() =>
      validateToolArguments(
        tool,
        call({ op: "create", table: "characters", patch: { name: "新角色" } }),
      ),
    ).not.toThrow();
    expect(() =>
      validateToolArguments(
        tool,
        call({
          op: "update",
          table: "characters",
          recordId: "r1",
          expectedRevisionId: "v1",
          patch: { name: "改名" },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateToolArguments(
        tool,
        call({ op: "delete", table: "characters", recordId: "r1", expectedRevisionId: "v1" }),
      ),
    ).not.toThrow();
  });

  it("跨 op 形状错误与未知 op 仍被 pi 在 execute 前拦截", async () => {
    const tool = await toolWith();
    const call = (args: Record<string, unknown>) => ({
      id: "call-1",
      name: MUTATE_TOOL_NAME,
      arguments: args,
    });
    expect(() => validateToolArguments(tool, call({ op: "create", table: "characters" }))).toThrow();
    expect(() =>
      validateToolArguments(tool, call({ op: "update", table: "characters", patch: {} })),
    ).toThrow();
    expect(() =>
      validateToolArguments(tool, call({ op: "delete", table: "characters", recordId: "r1" })),
    ).toThrow();
    expect(() => validateToolArguments(tool, call({ op: "upsert", table: "characters" }))).toThrow();
  });
});
