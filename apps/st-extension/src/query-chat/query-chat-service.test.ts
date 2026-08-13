import { describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  MUTATE_TOOL_NAME,
  PROPOSAL_PREVIEW_TOOL_NAME,
  SUBMIT_PROPOSAL_TOOL_NAME,
  type MemorySpaceReader,
} from "@ste-memory/core/memory/agent";
import {
  MemoryRecordQueryService,
  computeMemoryRecordDisplayText,
  type MemoryRecordHistoryId,
  type MemoryRecordId,
  type MemoryRecordMutationContext,
  type MemoryRevisionId,
  type MemorySpaceId,
} from "@ste-memory/core/memory";
import { SystemMemoryTableInstaller } from "@ste-memory/memory-host-shared";
import { createTestDatabase, createServices, type TestServices } from "../db/test-support.ts";
import type { SteMemoryDatabase } from "../db/database.ts";
import {
  assistantMessage,
  fakeModel,
  hangingStreamFn,
  lastToolResult,
  scriptedDeltaStreamFn,
  scriptedStreamFn,
  textMessage,
  thinkingMessage,
  toolCallMessage,
} from "../fill-tasks/stream-fn-support.ts";
import {
  QUERY_CHAT_SPACE_SWITCHED_NOTICE,
  QueryChatService,
  terminalQueryChatEvent,
  toAgentMessages,
  translateAgentEvent,
} from "./query-chat-service.ts";
import type { QueryChatEvent } from "./query-chat-state.ts";

const NOW = "2026-07-30T01:02:03.000Z";

/** 查询 Agent 脚本（增量流）：先 query_records，再思考 + 文本增量回答（两轮）。 */
function scriptedQueryAgent() {
  return scriptedDeltaStreamFn((context: Context) => {
    if (!lastToolResult(context)) {
      return assistantMessage(
        [toolCallMessage("call-1", "query_records", { table: "characters" })],
        "toolUse",
      );
    }
    return assistantMessage([thinkingMessage("查完了"), textMessage("共 1 条记录。")], "stop");
  });
}

/** 填写 Agent 脚本：mutate(create characters 云烬) → preview → submit → 自然结束。 */
function scriptedFillAgent() {
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

/** 用户不同意（软闸门）：Agent 陈述变更但不提交，自然结束。 */
function scriptedDeclineAgent() {
  return scriptedStreamFn(() => assistantMessage([textMessage("好的，未做任何变更。")], "stop"));
}

/** 模型失败：stopReason "error" + errorMessage。 */
function scriptedFailingAgent() {
  return scriptedStreamFn(() => assistantMessage([textMessage("模型炸了")], "error", "模型炸了"));
}

interface Harness {
  readonly service: QueryChatService;
  readonly db: SteMemoryDatabase;
  readonly services: TestServices;
  readonly spaceId: MemorySpaceId;
  readonly currentSpace: { value: MemorySpaceId | undefined };
  /** 组装第二个服务（多轮历史测试注入自定义 streamFn 用）。 */
  readonly buildService: (streamFn: StreamFn) => QueryChatService;
}

let harnessSeq = 0;

async function createHarness(
  options: {
    readonly streamFn?: StreamFn;
    readonly createLlmThrows?: boolean;
    readonly currentSpace?: () => MemorySpaceId | undefined;
  } = {},
): Promise<Harness> {
  const db = createTestDatabase(`ste-query-chat-${++harnessSeq}-`);
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
  const ports = {
    tables: services.tableRepository,
    fields: services.fieldRepository,
    records: services.recordRepository,
  };
  let recordSeq = 0;
  let historySeq = 0;
  let revisionSeq = 0;
  const commitContext: MemoryRecordMutationContext = {
    tables: services.tableRepository,
    fields: services.fieldRepository,
    records: services.recordRepository,
    createId: () => `record-${++recordSeq}` as MemoryRecordId,
    createHistoryId: () => `history-${++historySeq}` as MemoryRecordHistoryId,
    createRevisionId: () => `revision-${++revisionSeq}` as MemoryRevisionId,
    now: () => NOW,
    displayText: (table, fieldList, payload) =>
      computeMemoryRecordDisplayText(services.recordRepository, spaceId, table, fieldList, payload),
  };
  const currentSpace = { value: spaceId };
  const runInTransaction = (work: () => Promise<void>): Promise<void> =>
    db.transaction(
      "rw",
      [
        db.memoryTables,
        db.memoryFields,
        db.memoryRecords,
        db.memoryRecordHistory,
        db.memoryEvidence,
      ],
      async () => {
        await work();
      },
    );
  const buildService = (streamFn: StreamFn): QueryChatService =>
    new QueryChatService({
      reader,
      ports,
      commitContext,
      runInTransaction,
      createLlm: () => {
        if (options.createLlmThrows)
          throw new Error("Chat Completion 源未知：请在 ST 中配置可用源");
        return { streamFn, model: fakeModel() };
      },
      getCurrentSpaceId: () => options.currentSpace?.() ?? currentSpace.value,
    });
  const service = buildService(options.streamFn ?? scriptedQueryAgent());
  return { service, db, services, spaceId, currentSpace, buildService };
}

/** 收集事件 + 返回 run 结果。 */
async function run(
  harness: Harness,
  input: {
    readonly mode: "query" | "fill";
    readonly messages?: readonly { role: "user" | "assistant"; text: string }[];
    readonly signal?: AbortSignal;
  },
) {
  const events: QueryChatEvent[] = [];
  const result = await harness.service.run({
    mode: input.mode,
    memorySpaceId: harness.spaceId,
    messages: input.messages ?? [{ role: "user", text: "你好" }],
    signal: input.signal ?? new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  return { events, result };
}

describe("QueryChatService（问答双模式 run 编排，ticket 20）", () => {
  it("查询模式：整循环（工具调用 → 回答）事件齐全，done 收尾", async () => {
    const harness = await createHarness();
    const { events, result } = await run(harness, {
      mode: "query",
      messages: [{ role: "user", text: "有多少角色？" }],
    });

    expect(events.map((e) => e.type)).toEqual([
      "tool_start",
      "tool_result",
      "thinking_delta",
      "message_delta",
      "done",
    ]);
    expect(result.stopReason).toBe("stop");
    expect(result.answer).toBe("共 1 条记录。");
    expect(result.commit).toBeUndefined();

    const done = events.at(-1)!;
    expect(done).toEqual({
      type: "done",
      stopReason: "stop",
      errorMessage: null,
      commit: undefined,
    });
    expect(events[2]).toEqual({ type: "thinking_delta", text: "查完了" });
    expect(events[3]).toEqual({ type: "message_delta", text: "共 1 条记录。" });
    const toolResult = events[1]!;
    expect(toolResult.type).toBe("tool_result");
    if (toolResult.type !== "tool_result") throw new Error("unreachable");
    expect(toolResult.isError).toBe(false);
    // 测试空间还没有记录：query_records 如实返回 0（只读工具结果以 details 呈现）
    expect(toolResult.result).toMatchObject({ table: "characters", total: 0 });
  });

  it("查询模式：多轮历史以 user/assistant 文本回传（思考与工具不跨轮）", async () => {
    const harness = await createHarness();
    const contexts: Context[] = [];
    const streamFn = scriptedStreamFn((context) => {
      contexts.push(context);
      return assistantMessage([textMessage("好的。")], "stop");
    });
    const service = harness.buildService(streamFn);
    await service.run({
      mode: "query",
      memorySpaceId: harness.spaceId,
      messages: [
        { role: "user", text: "第一问" },
        { role: "assistant", text: "第一答" },
        { role: "user", text: "第二问" },
      ],
      signal: new AbortController().signal,
      onEvent: () => undefined,
    });
    expect(contexts).toHaveLength(1);
    const contextMessages = contexts[0]!.messages.map((m) => m.role);
    expect(contextMessages).toEqual(["user", "assistant", "user"]);
  });

  it("填写模式：提案提交直通 repository（revisionSource agent），done 携带已提交摘要", async () => {
    const harness = await createHarness({ streamFn: scriptedFillAgent() });
    const { events, result } = await run(harness, {
      mode: "fill",
      messages: [{ role: "user", text: "记一下：云烬" }],
    });

    const done = events.at(-1)!;
    expect(done.type).toBe("done");
    if (done.type !== "done") throw new Error("unreachable");
    expect(done.commit).toEqual({ status: "committed", created: 1, updated: 0, deleted: 0 });
    expect(result.commit).toEqual({ status: "committed", created: 1, updated: 0, deleted: 0 });

    // 记录真实落库
    const records = await harness.services.records.list(
      harness.spaceId,
      (await harness.services.tables.list(harness.spaceId)).find((t) => t.key === "characters")!.id,
      { page: 1, pageSize: 10 },
    );
    expect(records?.records ?? []).toHaveLength(1);
  });

  it("填写模式：用户不同意 → Agent 不提交自然结束，无 commit", async () => {
    const harness = await createHarness({ streamFn: scriptedDeclineAgent() });
    const { events, result } = await run(harness, {
      mode: "fill",
      messages: [{ role: "user", text: "不同意" }],
    });
    const done = events.at(-1)!;
    expect(done.type).toBe("done");
    if (done.type !== "done") throw new Error("unreachable");
    expect(done.commit).toBeUndefined();
    expect(result.commit).toBeUndefined();
  });

  it("填写模式：提交前空间已切换 → 放弃提案（abandoned 提示）", async () => {
    const harness = await createHarness({ streamFn: scriptedFillAgent() });
    const otherSpace = "space-other" as MemorySpaceId;
    harness.currentSpace.value = otherSpace;
    const { events, result } = await run(harness, {
      mode: "fill",
      messages: [{ role: "user", text: "记一下：云烬" }],
    });
    const done = events.at(-1)!;
    expect(done.type).toBe("done");
    if (done.type !== "done") throw new Error("unreachable");
    expect(done.commit).toEqual({ status: "abandoned", notice: QUERY_CHAT_SPACE_SWITCHED_NOTICE });
    expect(result.commit).toEqual({
      status: "abandoned",
      notice: QUERY_CHAT_SPACE_SWITCHED_NOTICE,
    });
    // 未落库
    const tables = await harness.services.tables.list(harness.spaceId);
    const characters = tables.find((t) => t.key === "characters")!;
    const records = await harness.services.records.list(harness.spaceId, characters.id, {
      page: 1,
      pageSize: 10,
    });
    expect(records?.records ?? []).toHaveLength(0);
  });

  it("取消：AbortController → 「已取消」终态，无提交", async () => {
    const harness = await createHarness({ streamFn: hangingStreamFn() });
    const controller = new AbortController();
    const promise = run(harness, { mode: "query", signal: controller.signal });
    // 等 run 进入挂起流再取消
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const { events, result } = await promise;
    expect(events.at(-1)).toEqual({ type: "error", message: "已取消" });
    expect(result.stopReason).toBe("aborted");
  });

  it("模型失败：stopReason error → error 终态（不阻塞继续操作）", async () => {
    const harness = await createHarness({ streamFn: scriptedFailingAgent() });
    const { events, result } = await run(harness, { mode: "query" });
    expect(events.at(-1)).toEqual({ type: "error", message: "模型炸了" });
    expect(result.errorMessage).toBe("模型炸了");
  });

  it("LLM 配置缺失：createLlm 抛错 → error 终态", async () => {
    const harness = await createHarness({ createLlmThrows: true });
    const { events, result } = await run(harness, { mode: "query" });
    expect(events.at(-1)).toEqual({
      type: "error",
      message: "Chat Completion 源未知：请在 ST 中配置可用源",
    });
    expect(result.stopReason).toBe("error");
  });

  it("消息为空 / 末尾非 user / 启动前已取消 → error 终态，不抛异常", async () => {
    const harness = await createHarness();
    for (const messages of [[], [{ role: "assistant" as const, text: "答" }]]) {
      const events: QueryChatEvent[] = [];
      const result = await harness.service.run({
        mode: "query",
        memorySpaceId: harness.spaceId,
        messages: messages as never,
        signal: new AbortController().signal,
        onEvent: (event) => events.push(event),
      });
      expect(events.at(-1)?.type).toBe("error");
      expect(result.stopReason).toBe("error");
    }
    const controller = new AbortController();
    controller.abort();
    const events: QueryChatEvent[] = [];
    await harness.service.run({
      mode: "query",
      memorySpaceId: harness.spaceId,
      messages: [{ role: "user", text: "问" }],
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    });
    expect(events.at(-1)).toEqual({ type: "error", message: "已取消" });
  });
});

describe("terminalQueryChatEvent（终态翻译）", () => {
  const signal = new AbortController().signal;
  const abortedSignal = (() => {
    const c = new AbortController();
    c.abort();
    return c.signal;
  })();

  it("stop/length → done（携带 commit）", () => {
    expect(
      terminalQueryChatEvent(
        { stopReason: "stop", errorMessage: undefined, answer: "x" },
        signal,
        undefined,
      ),
    ).toEqual({
      type: "done",
      stopReason: "stop",
      errorMessage: null,
      commit: undefined,
    });
    expect(
      terminalQueryChatEvent(
        { stopReason: "length", errorMessage: undefined, answer: "x" },
        signal,
        { status: "committed", created: 1, updated: 0, deleted: 0 },
      ),
    ).toEqual({
      type: "done",
      stopReason: "length",
      errorMessage: null,
      commit: { status: "committed", created: 1, updated: 0, deleted: 0 },
    });
  });

  it("error → error（模型失败文案）", () => {
    expect(
      terminalQueryChatEvent(
        { stopReason: "error", errorMessage: "上游 500", answer: "" },
        signal,
        undefined,
      ),
    ).toEqual({
      type: "error",
      message: "上游 500",
    });
  });

  it("aborted：调用方取消 = 已取消；超时 = 5 分钟提示", () => {
    expect(
      terminalQueryChatEvent(
        { stopReason: "aborted", errorMessage: "请求已取消", answer: "" },
        abortedSignal,
        undefined,
      ),
    ).toEqual({
      type: "error",
      message: "已取消",
    });
    expect(
      terminalQueryChatEvent(
        { stopReason: "aborted", errorMessage: "请求已取消", answer: "" },
        signal,
        undefined,
      ),
    ).toEqual({
      type: "error",
      message: "Agent 运行超时（默认 5 分钟），请重试或缩小问题范围",
    });
  });

  it("未知 stopReason → 未产生回答", () => {
    expect(
      terminalQueryChatEvent(
        { stopReason: undefined, errorMessage: undefined, answer: "" },
        signal,
        undefined,
      ),
    ).toEqual({
      type: "error",
      message: "未产生回答",
    });
  });
});

describe("translateAgentEvent / toAgentMessages（历史组装）", () => {
  it("translateAgentEvent 只透传思考/回答增量与工具调用，其余事件不产生噪音", () => {
    expect(
      translateAgentEvent({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "想想" },
      } as never),
    ).toEqual([{ type: "thinking_delta", text: "想想" }]);
    expect(
      translateAgentEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "答" },
      } as never),
    ).toEqual([{ type: "message_delta", text: "答" }]);
    expect(
      translateAgentEvent({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "query_records",
        args: { table: "characters" },
      }),
    ).toEqual([
      {
        type: "tool_start",
        callId: "call-1",
        name: "query_records",
        args: { table: "characters" },
      },
    ]);
    expect(
      translateAgentEvent({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "query_records",
        result: { details: { total: 1 } },
        isError: false,
      }),
    ).toEqual([
      {
        type: "tool_result",
        callId: "call-1",
        name: "query_records",
        result: { total: 1 },
        isError: false,
      },
    ]);
    expect(translateAgentEvent({ type: "agent_start" })).toEqual([]);
    expect(translateAgentEvent({ type: "turn_start" })).toEqual([]);
  });

  it("toAgentMessages：user 保留文本；assistant 补模型元数据与零用量", () => {
    const messages = toAgentMessages(
      [
        { role: "user", text: "问" },
        { role: "assistant", text: "答" },
      ],
      "gpt-4o",
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user" });
    expect(messages[1]).toMatchObject({ role: "assistant", model: "gpt-4o", stopReason: "stop" });
    // 思考/工具块不跨轮回传：历史只含纯文本块
    const assistantContent = (messages[1] as { content: unknown[] }).content;
    expect(assistantContent).toEqual([{ type: "text", text: "答" }]);
  });
});
