import { describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { SemanticQueryExecutor } from "../semantic-query/semantic-query-session.ts";
import {
  MemoryCommitPersistenceError,
  MemoryRecordQueryService,
  MemoryRecordService,
  type MemoryRecordHistoryId,
  type MemoryRecordId,
  type MemoryRevisionId,
  type MemorySpaceId,
  type MemorySpaceReader,
} from "../memory/index.ts";
import {
  createTestDatabase,
  createServices,
  installDefaultPreset,
  type TestServices,
} from "../../infrastructure/indexeddb/test-support.ts";
import type { SteMemoryDatabase } from "../../infrastructure/indexeddb/database.ts";
import { IndexedDbAssistantSessions } from "../../infrastructure/indexeddb/assistant-session-repository.ts";
import {
  assistantMessage,
  fakeModel,
  hangingStreamFn,
  lastToolResult,
  scriptedStreamFn,
  textMessage,
  toolCallMessage,
} from "../fill-tasks/stream-fn-support.ts";
import { QueryChatStore } from "./session-store.ts";
import { QueryChatService } from "./query-chat-service.ts";
const NOW = "2026-07-30T01:02:03.000Z";
interface Harness {
  readonly service: QueryChatService;
  readonly store: QueryChatStore;
  readonly db: SteMemoryDatabase;
  readonly services: TestServices;
  readonly spaceId: MemorySpaceId;
  readonly currentSpace: { value: MemorySpaceId | undefined; generation: number };
  /** 组装第二个服务（多轮历史测试注入自定义 streamFn 用）。 */
  readonly buildService: (streamFn: StreamFn, sessionStore?: QueryChatStore) => QueryChatService;
}

let harnessSeq = 0;

async function createHarness(
  options: {
    readonly streamFn?: StreamFn;
    readonly semanticQuery?: SemanticQueryExecutor;
    readonly createLlmThrows?: boolean;
    readonly currentSpace?: () => MemorySpaceId | undefined;
  } = {},
): Promise<Harness> {
  const db = createTestDatabase(`ste-query-chat-${++harnessSeq}-`);
  const services = createServices(db, () => NOW);
  const { spaces, tables, fields } = services;
  const space = await spaces.create("会话");
  await installDefaultPreset(db, space.id);
  const spaceId = space.id;

  const reader: MemorySpaceReader = {
    getSpace: async () => undefined,
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
  const recordWriter = new MemoryRecordService(
    services.tableRepository,
    services.fieldRepository,
    services.recordRepository,
    () => `record-${++recordSeq}` as MemoryRecordId,
    () => `history-${++historySeq}` as MemoryRecordHistoryId,
    () => `revision-${++revisionSeq}` as MemoryRevisionId,
    () => NOW,
  );
  const currentSpace = { value: spaceId, generation: 0 };
  const store = new QueryChatStore(new IndexedDbAssistantSessions(db));
  await store.ready;
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
  const buildService = (
    streamFn: StreamFn,
    sessionStore: QueryChatStore = store,
  ): QueryChatService =>
    new QueryChatService({
      store: sessionStore,
      semanticQuery: options.semanticQuery,
      reader,
      ports,
      recordWriter,
      runInTransaction,
      createLlm: () => {
        if (options.createLlmThrows)
          throw new Error("Chat Completion 源未知：请在 ST 中配置可用源");
        return { streamFn, model: fakeModel() };
      },
      getCurrentContext: () =>
        currentSpace.value
          ? {
              chatKey: "chat-a",
              spaceId: options.currentSpace?.() ?? currentSpace.value,
              generation: currentSpace.generation,
            }
          : undefined,
    });
  const service = buildService(
    options.streamFn ?? scriptedStreamFn(() => assistantMessage([textMessage("你好")], "stop")),
  );
  return { service, store, db, services, spaceId, currentSpace, buildService };
}

function createSession(h: Harness) {
  return h.store.create({ chatKey: "chat-a", spaceId: h.spaceId });
}
function draftScript() {
  return scriptedStreamFn((context: Context) => {
    const last = lastToolResult(context);
    const users = context.messages.filter((message) => message.role === "user");
    if (users.length === 1 && !last)
      return assistantMessage(
        [
          toolCallMessage("draft", "mutate", {
            op: "create",
            table: "characters",
            patch: { name: "云烬" },
          }),
        ],
        "toolUse",
      );
    if (users.length > 1 && context.messages.at(-1)?.role === "user")
      return assistantMessage([toolCallMessage("preview", "proposal_preview", {})], "toolUse");
    return assistantMessage([textMessage("请查看变更并确认。")], "stop");
  });
}
describe("记忆助手会话", () => {
  it("跨用户轮次保留草稿和工具上下文，刷新后继续检查并确认精确提案", async () => {
    const h = await createHarness({ streamFn: draftScript() });
    const session = createSession(h);
    await h.service.run({ sessionId: session.id, text: "新增云烬" });
    expect(h.store.get(session.id).proposal.operations).toHaveLength(1);
    expect(h.store.get(session.id).transcript.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    await h.service.run({ sessionId: session.id, text: "检查刚才的提案" });
    const preview = h.store.get(session.id);
    expect(preview.preview?.operations).toHaveLength(1);
    expect(preview.transcript.filter((message) => message.role === "user")).toHaveLength(2);
    const restored = new QueryChatStore(new IndexedDbAssistantSessions(h.db));
    await restored.ready;
    expect(restored.get(session.id).proposal).toEqual(preview.proposal);
    const resumed = h.buildService(draftScript(), restored);
    await resumed.run({ sessionId: session.id, text: "刷新后检查提案" });
    const commit = await resumed.confirm(session.id, restored.get(session.id).previewId!);
    expect(commit).toEqual({ status: "committed", created: 1, updated: 0, deleted: 0 });
    expect(restored.get(session.id).proposal.operations).toHaveLength(0);
    await expect(resumed.confirm(session.id, preview.previewId!)).rejects.toThrow("提案已变化");
    const table = (await h.services.tables.list(h.spaceId)).find(
      (table) => table.key === "characters",
    )!;
    expect(
      (await h.services.records.list(h.spaceId, table.id, { page: 1, pageSize: 10 }))!.records,
    ).toHaveLength(1);
  });
  it("连接配置失败后仍保留原始用户消息，修复连接可以继续", async () => {
    const seen: Context[] = [];
    const options = {
      createLlmThrows: true,
      streamFn: scriptedStreamFn((context) => {
        seen.push(context);
        return assistantMessage([textMessage("继续处理")], "stop");
      }),
    };
    const h = await createHarness(options);
    const session = createSession(h);
    await h.service.run({ sessionId: session.id, text: "查询云烬的关系" });
    expect(h.store.get(session.id).messages.at(-1)).toMatchObject({ status: "error" });
    options.createLlmThrows = false;
    await h.service.run({ sessionId: session.id, text: "连接已修好，继续" });
    expect(seen[0]!.messages.filter((message) => message.role === "user")).toHaveLength(2);
    expect(
      h.store.get(session.id).transcript.filter((message) => message.role === "user"),
    ).toHaveLength(2);
  });
  it("模型调用 submit_proposal 仅准备确认，不自动写入", async () => {
    const stream = scriptedStreamFn((context) => {
      const last = lastToolResult(context);
      if (!last)
        return assistantMessage(
          [
            toolCallMessage("m", "mutate", {
              op: "create",
              table: "characters",
              patch: { name: "云烬" },
            }),
            toolCallMessage("s", "submit_proposal", {}),
          ],
          "toolUse",
        );
      return assistantMessage([textMessage("等待确认")], "stop");
    });
    const h = await createHarness({ streamFn: stream });
    const session = createSession(h);
    await h.service.run({ sessionId: session.id, text: "记一下" });
    expect(h.store.get(session.id).preview?.valid).toBe(true);
    const table = (await h.services.tables.list(h.spaceId)).find(
      (table) => table.key === "characters",
    )!;
    expect(
      (await h.services.records.list(h.spaceId, table.id, { page: 1, pageSize: 10 }))!.records,
    ).toHaveLength(0);
  });
  it("新一轮修改使旧确认失效，提交失败保留草稿", async () => {
    const h = await createHarness({ streamFn: draftScript() });
    const session = createSession(h);
    await h.service.run({ sessionId: session.id, text: "新增" });
    const old = h.store.get(session.id).previewId!;
    await h.service.run({ sessionId: session.id, text: "重新检查" });
    await expect(h.service.confirm(session.id, old)).rejects.toThrow("提案已变化");
    const writer = vi
      .spyOn(MemoryRecordService.prototype, "commitProposal")
      .mockRejectedValueOnce(new Error("版本冲突"));
    const result = await h.service.confirm(session.id, h.store.get(session.id).previewId!);
    expect(result).toMatchObject({ status: "failed", error: "版本冲突" });
    expect(h.store.get(session.id).proposal.operations).toHaveLength(1);
    expect(h.store.get(session.id).preview).toBeUndefined();
    writer.mockRestore();
  });
  it("数据已提交但快照保存失败时清空提案，阻止重复写入", async () => {
    const h = await createHarness({ streamFn: draftScript() });
    const session = createSession(h);
    await h.service.run({ sessionId: session.id, text: "新增" });
    const original = MemoryRecordService.prototype.commitProposal;
    const writer = vi
      .spyOn(MemoryRecordService.prototype, "commitProposal")
      .mockImplementationOnce(async function (this: MemoryRecordService, ...args) {
        await original.apply(this, args);
        throw new MemoryCommitPersistenceError(new Error("文件写回失败"));
      });
    try {
      const result = await h.service.confirm(session.id, h.store.get(session.id).previewId!);
      expect(result).toMatchObject({
        status: "committed",
        created: 1,
        warning: expect.stringContaining("文件写回失败"),
      });
      expect(h.store.get(session.id).proposal.operations).toHaveLength(0);
    } finally {
      writer.mockRestore();
    }
  });
  it("提交成功后可在同一会话准备下一份提案，重复确认在途提交被拒绝", async () => {
    const h = await createHarness({ streamFn: draftScript() });
    const session = createSession(h);
    await h.service.run({ sessionId: session.id, text: "新增" });
    const id = h.store.get(session.id).previewId!;
    const first = h.service.confirm(session.id, id);
    await expect(h.service.confirm(session.id, id)).rejects.toThrow("会话正在执行");
    await first;
    const next = h.buildService(
      scriptedStreamFn((context) => {
        if (context.messages.at(-1)?.role === "user")
          return assistantMessage(
            [
              toolCallMessage("next", "mutate", {
                op: "create",
                table: "characters",
                patch: { name: "第二个人" },
              }),
            ],
            "toolUse",
          );
        return assistantMessage([textMessage("准备完成")], "stop");
      }),
    );
    await next.run({ sessionId: session.id, text: "再新增一个" });
    expect(h.store.get(session.id).proposal.operations).toHaveLength(1);
    expect(h.store.get(session.id).preview?.valid).toBe(true);
  });
  it("并行会话隔离，取消和删除不会串入其他会话", async () => {
    const h = await createHarness({ streamFn: hangingStreamFn() });
    const a = createSession(h),
      b = createSession(h);
    const running = h.service.run({ sessionId: a.id, text: "等待" });
    await vi.waitFor(() => expect(h.store.getRun(a.id)).toBeDefined());
    await expect(h.service.run({ sessionId: a.id, text: "重复" })).rejects.toThrow("会话正在执行");
    await h.store.delete(a.id);
    await running;
    expect(h.store.get(b.id).messages).toHaveLength(0);
    expect(h.store.getSessions().some((session) => session.id === a.id)).toBe(false);
  });
  it("同空间不同对话不能使用或确认另一个对话的会话", async () => {
    const h = await createHarness({ streamFn: draftScript() });
    const session = createSession(h);
    await h.service.run({ sessionId: session.id, text: "新增" });
    const other = h.store.create({ chatKey: "chat-b", spaceId: h.spaceId });
    await expect(h.service.run({ sessionId: other.id, text: "查询" })).rejects.toThrow(
      "对话已切换",
    );
    h.currentSpace.value = undefined;
    await expect(h.service.confirm(session.id, h.store.get(session.id).previewId!)).rejects.toThrow(
      "对话已切换",
    );
  });
  it("确认准备期间 A→B→A 的上下文切换使提交失效", async () => {
    const h = await createHarness({ streamFn: draftScript() });
    const session = createSession(h);
    await h.service.run({ sessionId: session.id, text: "新增" });
    const original = h.services.tables.list.bind(h.services.tables);
    const switched = vi.spyOn(h.services.tables, "list").mockImplementationOnce(async (...args) => {
      h.currentSpace.generation += 2;
      return original(...args);
    });
    const result = await h.service.confirm(session.id, h.store.get(session.id).previewId!);
    expect(result).toMatchObject({
      status: "failed",
      error: expect.stringContaining("对话已切换"),
    });
    expect(h.store.get(session.id).proposal.operations).toHaveLength(1);
    switched.mockRestore();
  });
  it("统一入口保留普通查询和语义 SQL 的覆盖、取消信号及结果", async () => {
    const query = vi.fn<SemanticQueryExecutor>().mockResolvedValue({
      execution: { sqlPasses: 1, sqlMs: 1 },
      columns: ["name"],
      rows: [["云烬"]],
      sources: [],
      diagnostics: {
        sqlPasses: 1,
        sqlMs: 1,
        preparedSources: 1,
        queryTexts: 1,
        queryVectors: { requests: 1, executionHits: 0, sharedHits: 0 },
      },
      truncated: false,
    });
    const h = await createHarness({
      semanticQuery: query,
      streamFn: scriptedStreamFn((context) => {
        if (!lastToolResult(context))
          return assistantMessage(
            [
              toolCallMessage("q", "query_sql", {
                sql: "SELECT * FROM semantic_scores('characters',json_array('main'),'云烬')",
              }),
            ],
            "toolUse",
          );
        expect(lastToolResult(context)?.content).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ text: expect.stringContaining("云烬") }),
          ]),
        );
        return assistantMessage([textMessage("查询完成")], "stop");
      }),
    });
    const session = createSession(h);
    await h.service.run({ sessionId: session.id, text: "查询云烬" });
    expect(query).toHaveBeenCalledWith(
      h.spaceId,
      expect.objectContaining({ signal: expect.any(AbortSignal), maxRows: 100 }),
    );
    expect(h.store.get(session.id).proposal.operations).toHaveLength(0);
    expect(h.store.get(session.id).messages.at(-1)).toMatchObject({ status: "done" });
  });
});
