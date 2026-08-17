/**
 * FillAgentRunner 组装模块单测（spec Seam 2）：fixture digest（Dexie 系统表
 * 安装 + buildMemorySpaceTableDigest）+ scriptedStreamFn 驱动真实 Agent 循环。
 * 只测外部行为：守卫、system 合并/前缀顺序、run 结果形状、submit_proposal
 * 冻结提案；digest 构建/State/工具工厂各自的行为由 core 契约测试锁定。
 */
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  buildMemorySpaceTableDigest,
  MUTATE_TOOL_NAME,
  PROPOSAL_PREVIEW_TOOL_NAME,
  SUBMIT_PROPOSAL_TOOL_NAME,
  type MemorySpaceReader,
  type MemorySpaceTableDigest,
} from "@ste-memory/core/memory/agent";
import {
  MemoryRecordQueryService,
  type MemoryEvidence,
  type MemoryMessageRange,
  type MemoryProposalPorts,
  type MemorySpaceId,
} from "@ste-memory/core/memory";
import { SystemMemoryTableInstaller } from "@ste-memory/memory-host-shared";
import { createTestDatabase, createServices, type TestServices } from "../db/test-support.ts";
import {
  assistantMessage,
  fakeModel,
  lastToolResult,
  scriptedStreamFn,
  textMessage,
  toolCallMessage,
} from "../fill-tasks/stream-fn-support.ts";
import {
  runFillAgent,
  type FillAgentRunInput,
  type FillAgentRunResult,
} from "./fill-agent-runner.ts";

const NOW = "2026-07-30T01:02:03.000Z";

const MESSAGE_RANGE: MemoryMessageRange = { from: 1, to: 3 };
const EVIDENCE: readonly MemoryEvidence[] = [
  {
    evidence_id: "ev-1" as never,
    source_type: "chat",
    source_id: 1,
    storage_mode: "reference" as const,
    extraProps: {},
  },
];

interface Harness {
  readonly services: TestServices;
  readonly spaceId: MemorySpaceId;
  readonly reader: MemorySpaceReader;
  readonly ports: MemoryProposalPorts;
  readonly digest: MemorySpaceTableDigest;
}

let harnessSeq = 0;

/** 装配测试记忆空间：Dexie 库 + 系统表安装 + reader/ports + 真实 digest。 */
async function createHarness(): Promise<Harness> {
  const db = createTestDatabase(`ste-fill-agent-${++harnessSeq}-`);
  const services = createServices(db, () => NOW);
  const { spaces, tables, fields } = services;
  const space = await spaces.create("会话");
  await new SystemMemoryTableInstaller(tables, fields).install(space.id);
  const spaceId = space.id;
  const reader: MemorySpaceReader = {
    listTables: (memorySpaceId) => tables.list(memorySpaceId),
    listFields: (memorySpaceId, tableId) => fields.list(memorySpaceId, tableId),
    queryRecords: (memorySpaceId, input) =>
      new MemoryRecordQueryService(
        services.tableRepository,
        services.fieldRepository,
        services.recordRepository,
      ).query(memorySpaceId, input),
  };
  const ports: MemoryProposalPorts = {
    tables: services.tableRepository,
    fields: services.fieldRepository,
    records: services.recordRepository,
  };
  const digest = await buildMemorySpaceTableDigest(reader, spaceId);
  return { services, spaceId, reader, ports, digest };
}

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

interface RunOverrides {
  readonly composedMessages?: FillAgentRunInput["composedMessages"];
  readonly messages?: readonly AgentMessage[];
  readonly signal?: AbortSignal;
  readonly onEvent?: FillAgentRunInput["onEvent"];
}

function runInput(harness: Harness, streamFn: StreamFn, overrides: RunOverrides = {}) {
  return {
    llm: { streamFn, model: fakeModel() },
    reader: harness.reader,
    ports: harness.ports,
    memorySpaceId: harness.spaceId,
    digest: harness.digest,
    composedMessages: overrides.composedMessages ?? [],
    messages: overrides.messages ?? [userMessage("填写表格")],
    messageRange: MESSAGE_RANGE,
    evidence: EVIDENCE,
    timeoutMs: 5 * 60 * 1000,
    signal: overrides.signal,
    onEvent: overrides.onEvent,
  } satisfies FillAgentRunInput;
}

/** 自然停止（无工具调用）的脚本化 streamFn。 */
function scriptedStopAgent(text = "无需变更。") {
  return scriptedStreamFn(() => assistantMessage([textMessage(text)], "stop"));
}

/** 完整流程脚本：mutate(create) → preview → submit → 自然结束。 */
function scriptedSubmitAgent() {
  return scriptedStreamFn((context: Context) => {
    if (!lastToolResult(context)) {
      return assistantMessage(
        [
          toolCallMessage("call-1", MUTATE_TOOL_NAME, {
            op: "create",
            table: "characters",
            patch: { name: "云烬" },
          }),
          toolCallMessage("call-2", PROPOSAL_PREVIEW_TOOL_NAME, {}),
          toolCallMessage("call-3", SUBMIT_PROPOSAL_TOOL_NAME, {}),
        ],
        "toolUse",
      );
    }
    return assistantMessage([textMessage("已提交。")], "stop");
  });
}

describe("runFillAgent", () => {
  it("守卫：编排消息与本轮消息都为空时抛错", async () => {
    const harness = await createHarness();
    await expect(
      runFillAgent(runInput(harness, scriptedStopAgent(), { composedMessages: [], messages: [] })),
    ).rejects.toThrow(/至少一条消息/);
  });

  it("编排：system 合并进系统提示词（空行分隔），user/assistant 进前缀（run 消息之前）", async () => {
    const harness = await createHarness();
    const contexts: Context[] = [];
    const streamFn = scriptedStreamFn((context) => {
      contexts.push(context);
      return assistantMessage([textMessage("无需变更。")], "stop");
    });

    const result = await runFillAgent(
      runInput(harness, streamFn, {
        composedMessages: [
          { role: "system", text: "编排指令 A" },
          { role: "system", text: "编排指令 B" },
          { role: "user", text: "编排问题" },
          { role: "assistant", text: "编排回答" },
        ],
      }),
    );

    expect(result.errorMessage).toBeUndefined();
    // system 文本进系统提示词（空行分隔、按顺序），不进对话消息
    expect(contexts[0]?.systemPrompt).toBe("编排指令 A\n\n编排指令 B");
    expect(contexts[0]?.systemPrompt).not.toContain("编排问题");
    // 对话前缀 = 编排 user/assistant + run 消息，顺序原样
    expect(contexts[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const texts = contexts[0]!.messages
      .filter((m) => m.role !== "toolResult")
      .map((m) =>
        typeof m.content === "string"
          ? m.content
          : m.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join(""),
      );
    expect(texts).toEqual(["编排问题", "编排回答", "填写表格"]);
  });

  it("编排兜底：{{msg}} 接管场景（本轮消息为空，对话由编排消息驱动）", async () => {
    const harness = await createHarness();
    const contexts: Context[] = [];
    const streamFn = scriptedStreamFn((context) => {
      contexts.push(context);
      return assistantMessage([textMessage("无需变更。")], "stop");
    });

    const result = await runFillAgent(
      runInput(harness, streamFn, {
        composedMessages: [
          { role: "system", text: "指令" },
          { role: "user", text: "请总结：块内容" },
        ],
        messages: [],
      }),
    );

    expect(result.errorMessage).toBeUndefined();
    expect(contexts[0]!.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("无「最后一条必须 user」守卫：assistant 结尾的编排消息直接进入 run", async () => {
    const harness = await createHarness();
    const contexts: Context[] = [];
    const streamFn = scriptedStreamFn((context) => {
      contexts.push(context);
      return assistantMessage([textMessage("无需变更。")], "stop");
    });

    const result = await runFillAgent(
      runInput(harness, streamFn, {
        composedMessages: [
          { role: "user", text: "问题" },
          { role: "assistant", text: "回答" },
        ],
        messages: [],
      }),
    );

    expect(result.errorMessage).toBeUndefined();
    expect(contexts[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("run 结果形状：自然停止 = stop/无错误/回答文本/完整对话记录，无提案", async () => {
    const harness = await createHarness();
    const streamFn = scriptedStopAgent("无需变更。");
    const events: string[] = [];

    const result = await runFillAgent(
      runInput(harness, streamFn, { onEvent: (event) => events.push(event.type) }),
    );

    expect(streamFn.calls.count).toBe(1);
    expect(result.stopReason).toBe("stop");
    expect(result.errorMessage).toBeUndefined();
    expect(result.answer).toBe("无需变更。");
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.proposal).toBeUndefined();
    // 生命周期事件经 onEvent 转发（含 agent_end）
    expect(events).toContain("agent_end");
  });

  it("submit_proposal 冻结提案：范围/证据随注入，batch 为统一 MutationBatch，全程无落库", async () => {
    const harness = await createHarness();
    const streamFn = scriptedSubmitAgent();

    const result = await runFillAgent(runInput(harness, streamFn));

    expect(result.stopReason).toBe("stop");
    expect(result.errorMessage).toBeUndefined();
    // 提案冻结：范围/证据随外部注入
    const proposal = result.proposal!;
    expect(proposal).toBeDefined();
    expect(proposal.messageRange).toEqual(MESSAGE_RANGE);
    expect(proposal.evidence).toEqual(EVIDENCE);
    expect(proposal.batch.create).toHaveLength(1);
    expect(proposal.batch.update).toHaveLength(0);
    expect(proposal.batch.delete).toHaveLength(0);
    expect(proposal.batch.create[0]!.tempId).toBeDefined();
    // patch 以字段 id 为键：经 digest 的 id→key 映射断言内容
    const charactersDigest = harness.digest.tables.find((table) => table.key === "characters")!;
    const nameFieldId = charactersDigest.fields.find((field) => field.key === "name")!.id;
    expect(proposal.batch.create[0]!.patch).toEqual({ [nameFieldId]: "云烬" });
    // 提交只是冻结：记录未写入数据库
    const characters = (await harness.services.tableRepository.findByKey(
      harness.spaceId,
      "characters" as never,
    ))!;
    const records = await harness.services.recordRepository.list(harness.spaceId, characters.id);
    expect(records).toHaveLength(0);
  });

  it("取消语义：run 启动前 signal 已中止 = aborted 结果，不创建 Agent", async () => {
    const harness = await createHarness();
    const controller = new AbortController();
    controller.abort();

    const result: FillAgentRunResult = await runFillAgent(
      runInput(harness, scriptedStopAgent(), { signal: controller.signal }),
    );

    expect(result.stopReason).toBe("aborted");
    expect(result.errorMessage).toContain("已取消");
    expect(result.answer).toBe("");
    expect(result.messages).toEqual([]);
    expect(result.proposal).toBeUndefined();
  });
});
