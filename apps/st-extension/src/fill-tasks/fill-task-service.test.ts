import { describe, expect, it } from "vitest";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import {
  MUTATE_TOOL_NAME,
  PROPOSAL_PREVIEW_TOOL_NAME,
  SUBMIT_PROPOSAL_TOOL_NAME,
  type MemorySpaceReader,
  type ProposalSystemPromptComposer,
} from "@ste-memory/core/memory/agent";
import {
  computeMemoryRecordDisplayText,
  MemoryRecordQueryService,
  type MemoryEvidenceId,
  type MemoryRecordMutationContext,
  type MemoryRecordHistoryId,
  type MemoryRecordId,
  type MemoryRevisionId,
  type MemorySpaceId,
} from "@ste-memory/core/memory";
import { SystemMemoryTableInstaller } from "@ste-memory/memory-host-shared";
import type { StreamFn } from "@earendil-works/pi-agent-core";
// fake-indexeddb 必须先于 dexie 模块求值（test-support 第一行 import "fake-indexeddb/auto"）
import { createTestDatabase, createServices, type TestServices } from "../db/test-support.ts";
import { DexieFillTaskRepository, DexieFloorLedgerRepository } from "../db/fill-task-repository.ts";
import type { SteMemoryDatabase } from "../db/database.ts";
import {
  FillTaskConflictError,
  FillTaskRangeError,
  FillTaskStateError,
  type FillTaskSource,
} from "./fill-task.ts";
import { FillTaskService } from "./fill-task-service.ts";
import { composePresetSystemPrompt } from "../agent-presets/preset-composer.ts";
import {
  assistantMessage,
  fakeModel,
  gatedStreamFn,
  hangingStreamFn,
  lastToolResult,
  scriptedStreamFn,
  textMessage,
  toolCallMessage,
} from "./stream-fn-support.ts";
import type { FillSourceMessage } from "./fill-task.ts";
import type { LogEntry, LogRepository } from "../logging/log.ts";
import { DexieLogRepository } from "../db/log-repository.ts";
import type { FillRunRecord } from "./fill-run-log.ts";
import type { CleaningRule } from "../settings/cleaning-rule-lists.ts";

const NOW = "2026-07-30T01:02:03.000Z";

/** 6 条消息的假聊天：楼层 0..5（同步楼层 = ST 消息数组下标，0 基）。 */
const CHAT_LENGTH = 6;

function defaultMessagesInRange(from: number, to: number): readonly FillSourceMessage[] {
  const messages: FillSourceMessage[] = [];
  for (let floor = from; floor <= to && floor < CHAT_LENGTH; floor += 1) {
    messages.push({
      floor,
      content: floor === 1 ? "[reg] 原始内容 **带标记**" : `消息 ${floor + 1}`,
      name: floor % 2 === 0 ? "爱丽丝" : "鲍勃",
    });
  }
  return messages;
}

/** 填表 Agent 脚本：每块 mutate(create characters 云烬) → preview → submit → 自然结束。 */
function scriptedFillAgent() {
  return scriptedStreamFn((context) => {
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
    return assistantMessage([textMessage("已提交")], "stop");
  });
}

function emptyProposalAgent() {
  return scriptedStreamFn(() => assistantMessage([textMessage("无需变更")], "stop"));
}

function failingAgent() {
  return scriptedStreamFn(() => assistantMessage([textMessage("模型炸了")], "error", "模型炸了"));
}

/** 第一次调用失败、之后走成功脚本的 respond（重试场景：首轮失败 → 重试成功）。 */
function makeFailFirstRespond() {
  const calls = { n: 0 };
  return (context: Context): AssistantMessage => {
    calls.n += 1;
    if (calls.n === 1) {
      return assistantMessage([textMessage("模型炸了")], "error", "模型炸了");
    }
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
    return assistantMessage([textMessage("已提交")], "stop");
  };
}

/** 第一次 Agent 调用失败、之后成功的脚本化 streamFn。 */
function failOnceThenFill() {
  return scriptedStreamFn(makeFailFirstRespond());
}

interface Harness {
  readonly service: FillTaskService;
  readonly db: SteMemoryDatabase;
  readonly services: TestServices;
  readonly spaceId: MemorySpaceId;
  readonly tasks: DexieFillTaskRepository;
  readonly ledger: DexieFloorLedgerRepository;
  readonly logs: LogRepository;
}

let harnessSeq = 0;

async function createHarness(
  options: {
    readonly streamFn?: StreamFn;
    readonly createLlmThrows?: boolean;
    readonly source?: FillTaskSource;
    readonly createComposeSystemPrompt?: (
      storyText: string,
    ) => Promise<ProposalSystemPromptComposer | undefined>;
    readonly logs?: LogRepository;
    readonly resolveCleaningRules?: () => readonly CleaningRule[];
  } = {},
): Promise<Harness> {
  const db = createTestDatabase(`ste-fill-${++harnessSeq}-`);
  const services = createServices(db, () => NOW);
  const { spaces, tables, fields } = services;
  const space = await spaces.create("会话");
  await new SystemMemoryTableInstaller(tables, fields).install(space.id);
  const spaceId = space.id;

  const tasks = new DexieFillTaskRepository(db, () => NOW);
  const ledger = new DexieFloorLedgerRepository(db, () => NOW);
  const logs = options.logs ?? new DexieLogRepository(db, { now: () => NOW });
  const source: FillTaskSource =
    options.source ??
    ({
      chatMessageCount: () => CHAT_LENGTH,
      chatId: () => "story",
      messagesInRange: defaultMessagesInRange,
    } as const);

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
  let evidenceSeq = 0;
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
  let runSeq = 0;
  const service = new FillTaskService({
    tasks,
    ledger,
    source,
    reader,
    ports,
    evidence: services.recordRepository,
    commitContext,
    runInTransaction: (work) =>
      // 事务作用域函数必须声明为 async：非 async 包装（() => work()）不会触发
      // Dexie 的 expected-awaits 追踪，事务会在承诺链完成前提交（PrematureCommit）。
      // 表集合 = 批次提交读写全集（表格/字段读取 + 记录/历史/证据/台账写入）。
      db.transaction(
        "rw",
        [
          db.memoryTables,
          db.memoryFields,
          db.memoryRecords,
          db.memoryRecordHistory,
          db.memoryEvidence,
          db.floorFillLedger,
        ],
        async () => {
          await work();
        },
      ),
    createLlm: () => {
      if (options.createLlmThrows) throw new Error("Chat Completion 源未知：请在 ST 中配置可用源");
      return { streamFn: options.streamFn ?? scriptedFillAgent(), model: fakeModel() };
    },
    createRunId: () => `run-${++runSeq}`,
    createEvidenceId: () => `evidence-${++evidenceSeq}` as MemoryEvidenceId,
    now: () => NOW,
    logs,
    createComposeSystemPrompt: options.createComposeSystemPrompt,
    resolveCleaningRules: options.resolveCleaningRules,
  });
  return { service, db, services, spaceId, tasks, ledger, logs };
}

/** 轮询任务行直到终态（超时抛错）。 */
async function waitForTerminal(
  harness: Harness,
  runId: string,
  timeoutMs = 5_000,
): Promise<{ readonly status: string; readonly errorMessage: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await harness.tasks.find(runId);
    if (row && row.status !== "running") {
      return { status: row.status, errorMessage: row.errorMessage };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`任务 ${runId} 未在 ${timeoutMs}ms 内到达终态`);
}

async function floorStatuses(harness: Harness): Promise<readonly string[]> {
  const entries = await harness.ledger.statuses(harness.spaceId, 0, CHAT_LENGTH - 1);
  return entries.map((entry) => entry.status);
}

describe("FillTaskService（手动楼层触发与运行，ticket 13）", () => {
  it("端到端：分块跑 Agent，每块原子写入记录与证据，楼层标记 processed，任务 succeeded", async () => {
    const streamFn = scriptedFillAgent();
    const harness = await createHarness({ streamFn });
    const { service, spaceId } = harness;

    const view = await service.submit({ memorySpaceId: spaceId, from: 0, to: 5, blockSize: 2 });
    expect(view).toMatchObject({
      status: "running",
      from: 0,
      to: 5,
      blockSize: 2,
      errorMessage: null,
      processedCount: 0,
      totalCount: 6,
    });
    expect(typeof view.runId).toBe("string");

    const terminal = await waitForTerminal(harness, view.runId);
    expect(terminal).toEqual({ status: "succeeded", errorMessage: null });

    // 三块各提交一次 create：记录写入、修订来源 agent、来源 source（无具体时间/位置）
    const characters = (await harness.services.tableRepository.findByKey(
      spaceId,
      "characters" as never,
    ))!;
    const records = await harness.services.recordRepository.list(spaceId, characters.id);
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record.revisionSource).toBe("agent");
      expect(record.source).toEqual({ type: "source", sourceTime: null, sourceLocation: null });
    }
    // 证据 6 条（整批 reference，source_type sync_floor）
    const evidenceRows = await harness.db.memoryEvidence.toArray();
    expect(evidenceRows).toHaveLength(6);
    expect(evidenceRows.every((row) => row.storage_mode === "reference")).toBe(true);
    expect(evidenceRows.map((row) => row.source_id).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    // 台账：全部楼层 processed
    expect(await floorStatuses(harness)).toEqual([
      "processed",
      "processed",
      "processed",
      "processed",
      "processed",
      "processed",
    ]);
    expect(await harness.ledger.processedCount(spaceId, 0, 5)).toBe(6);
    // 每块一次 Agent 调用（工具轮 + 回答轮 = 2 次流式调用）
    expect(streamFn.calls.count).toBe(6);
  });

  it("空提案块按成功处理：无记录写入，楼层仍标记 processed", async () => {
    const harness = await createHarness({ streamFn: emptyProposalAgent() });
    const { service, spaceId } = harness;

    const view = await service.submit({ memorySpaceId: spaceId, from: 0, to: 1 });
    const terminal = await waitForTerminal(harness, view.runId);
    expect(terminal.status).toBe("succeeded");

    const characters = (await harness.services.tableRepository.findByKey(
      spaceId,
      "characters" as never,
    ))!;
    expect(await harness.services.recordRepository.list(spaceId, characters.id)).toHaveLength(0);
    expect(await harness.ledger.processedCount(spaceId, 0, 1)).toBe(2);
    expect(await floorStatuses(harness)).toEqual([
      "processed",
      "processed",
      "untracked",
      "untracked",
      "untracked",
      "untracked",
    ]);
  });

  it("任务输入 = 原始消息内容：提示词原样包含格式化标记，不套清洗规则", async () => {
    const streamFn = emptyProposalAgent();
    const harness = await createHarness({ streamFn });
    const { service, spaceId } = harness;

    const view = await service.submit({ memorySpaceId: spaceId, from: 0, to: 1 });
    await waitForTerminal(harness, view.runId);

    // 第一轮（块 0-1）的提示词包含楼层 1 的原文标记
    const firstTurn = streamFn.contexts[0]!;
    const content = firstTurn.messages[0]!.content as readonly { type: string; text?: string }[];
    const text = content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    expect(text).toContain("[1] 鲍勃：[reg] 原始内容 **带标记**");
  });

  it("块失败：出错块楼层标记 error、未处理楼层保持 untracked、任务 failed 并停止，失败原因可读", async () => {
    const streamFn = failingAgent();
    const harness = await createHarness({ streamFn });
    const { service, spaceId } = harness;

    const view = await service.submit({ memorySpaceId: spaceId, from: 0, to: 3, blockSize: 2 });
    const terminal = await waitForTerminal(harness, view.runId);
    expect(terminal.status).toBe("failed");
    expect(terminal.errorMessage).toContain("模型炸了");

    expect(await floorStatuses(harness)).toEqual([
      "error",
      "error",
      "untracked",
      "untracked",
      "untracked",
      "untracked",
    ]);
    // 失败块未产生任何数据/证据
    const characters = (await harness.services.tableRepository.findByKey(
      spaceId,
      "characters" as never,
    ))!;
    expect(await harness.services.recordRepository.list(spaceId, characters.id)).toHaveLength(0);
    expect(await harness.db.memoryEvidence.toArray()).toHaveLength(0);
    // 只跑了一块（首次 Agent 调用失败即停止）
    expect(streamFn.calls.count).toBe(1);
  });

  it("块失败保留已提交块：块 1 成功提交后块 2 失败，已提交数据/楼层保持 processed", async () => {
    // 前两次流式调用（块 1：工具轮 + 回答轮）走成功脚本；第 3 次起（块 2）失败
    const calls = { n: 0 };
    const streamFn = scriptedStreamFn((context) => {
      calls.n += 1;
      if (calls.n >= 3) {
        return assistantMessage([textMessage("模型炸了")], "error", "模型炸了");
      }
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
      return assistantMessage([textMessage("已提交")], "stop");
    });
    const harness = await createHarness({ streamFn });
    const { service, spaceId } = harness;

    const view = await service.submit({ memorySpaceId: spaceId, from: 0, to: 5, blockSize: 2 });
    const terminal = await waitForTerminal(harness, view.runId);
    expect(terminal.status).toBe("failed");
    expect(terminal.errorMessage).toContain("模型炸了");

    // 块 1 已提交：楼层 processed、记录与证据落库；块 2 出错楼层标记 error；块 3 未跑
    expect(await floorStatuses(harness)).toEqual([
      "processed",
      "processed",
      "error",
      "error",
      "untracked",
      "untracked",
    ]);
    const characters = (await harness.services.tableRepository.findByKey(
      spaceId,
      "characters" as never,
    ))!;
    expect(await harness.services.recordRepository.list(spaceId, characters.id)).toHaveLength(1);
    expect(await harness.db.memoryEvidence.toArray()).toHaveLength(2);
  });

  it("对话切换：块开始前检测到 chatId 变化，任务 failed（可读原因），楼层不标记", async () => {
    // 块 1 的回答轮（第 2 次调用）同步切换 chatId：块 1 提交完成后，
    // 块 2 开始前的安全点必然检测到对话已切换（确定性，无竞态）
    const chat = { id: "story" };
    const source: FillTaskSource = {
      chatMessageCount: () => CHAT_LENGTH,
      chatId: () => chat.id,
      messagesInRange: defaultMessagesInRange,
    };
    const streamFn = scriptedStreamFn((context) => {
      if (lastToolResult(context)) {
        chat.id = "other-chat";
        return assistantMessage([textMessage("已提交")], "stop");
      }
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
    });
    const harness = await createHarness({ streamFn, source });
    const { service, spaceId } = harness;

    const view = await service.submit({ memorySpaceId: spaceId, from: 0, to: 5, blockSize: 2 });
    const terminal = await waitForTerminal(harness, view.runId);
    expect(terminal.status).toBe("failed");
    expect(terminal.errorMessage).toContain("对话已切换");

    // 块 1 已提交（已提交块保留）；块 2 起未跑、楼层不标记
    expect(await floorStatuses(harness)).toEqual([
      "processed",
      "processed",
      "untracked",
      "untracked",
      "untracked",
      "untracked",
    ]);
    const characters = (await harness.services.tableRepository.findByKey(
      spaceId,
      "characters" as never,
    ))!;
    expect(await harness.services.recordRepository.list(spaceId, characters.id)).toHaveLength(1);
  });

  it("块内没有可处理的消息：任务 failed 且错误信息可读", async () => {
    const source: FillTaskSource = {
      chatMessageCount: () => 2,
      chatId: () => "story",
      messagesInRange: () => [],
    };
    const harness = await createHarness({ source, streamFn: emptyProposalAgent() });
    const view = await harness.service.submit({
      memorySpaceId: harness.spaceId,
      from: 0,
      to: 1,
    });
    const terminal = await waitForTerminal(harness, view.runId);
    expect(terminal.status).toBe("failed");
    expect(terminal.errorMessage).toContain("消息块 [0, 1] 内没有可处理的消息");
  });

  it("单空间单活动任务守卫：运行中再次提交抛冲突（原因可读），终态后可再提交", async () => {
    const harness = await createHarness({ streamFn: hangingStreamFn() });
    const { service, spaceId } = harness;

    const first = await service.submit({ memorySpaceId: spaceId, from: 0, to: 5 });
    const second = await service
      .submit({ memorySpaceId: spaceId, from: 0, to: 5 })
      .catch((error) => {
        expect(error).toBeInstanceOf(FillTaskConflictError);
        expect((error as FillTaskConflictError).task.runId).toBe(first.runId);
        expect((error as FillTaskConflictError).message).toContain("已有正在进行的填表任务");
        return null;
      });
    expect(second).toBeNull();
    // 其他空间不受守卫影响
    const otherSpace = await harness.services.spaces.create("其他会话");
    const other = await service.submit({ memorySpaceId: otherSpace.id, from: 0, to: 5 });
    expect(other.status).toBe("running");

    // 取消第一个任务后活动名额释放：可再提交
    await service.cancel(spaceId, first.runId);
    const resubmit = await service.submit({ memorySpaceId: spaceId, from: 0, to: 5 });
    expect(resubmit.status).toBe("running");
    expect(resubmit.runId).not.toBe(first.runId);
  });

  it("用户取消：任务立即置 interrupted，循环在安全点停止并丢弃未提交提案，楼层不标记", async () => {
    const streamFn = gatedStreamFn(scriptedFillAgent().respond, 3);
    const harness = await createHarness({ streamFn });
    const { service, spaceId } = harness;

    const view = await service.submit({ memorySpaceId: spaceId, from: 0, to: 5, blockSize: 2 });
    // 等块 2 开始（第 3 次流式调用触发门控）：块 1 已提交完成
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && streamFn.calls.count < 3) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(streamFn.calls.count).toBe(3);

    // 取消：立即落为 interrupted（与关 tab 同态，不自动重放）
    const cancelled = await service.cancel(spaceId, view.runId);
    expect(cancelled).toMatchObject({ runId: view.runId, status: "interrupted" });
    expect(cancelled.errorMessage).toBeNull();

    // 放行块 2：Agent 完成后在提交前检查到中断，提案被丢弃、楼层不标记
    streamFn.gate.open();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await harness.tasks.find(view.runId)).toMatchObject({ status: "interrupted" });
    expect(await floorStatuses(harness)).toEqual([
      "processed",
      "processed",
      "untracked",
      "untracked",
      "untracked",
      "untracked",
    ]);
    // 块 1 已提交 1 条记录；块 2 的提案未落库、证据只属于块 1 的楼层
    const characters = (await harness.services.tableRepository.findByKey(
      spaceId,
      "characters" as never,
    ))!;
    expect(await harness.services.recordRepository.list(spaceId, characters.id)).toHaveLength(1);
    expect(await harness.db.memoryEvidence.toArray()).toHaveLength(2);
  });

  it("取消已终态任务抛状态错误；任务不存在抛 NotFound", async () => {
    const harness = await createHarness({ streamFn: emptyProposalAgent() });
    const { service, spaceId } = harness;
    const view = await service.submit({ memorySpaceId: spaceId, from: 0, to: 1 });
    await waitForTerminal(harness, view.runId);

    await service.cancel(spaceId, view.runId).catch((error) => {
      expect(error).toBeInstanceOf(FillTaskStateError);
      expect((error as FillTaskStateError).task.status).toBe("succeeded");
    });
    await expect(service.cancel(spaceId, "run-missing")).rejects.toThrow(/填表任务不存在/);
  });

  it("启动标记 interrupted：非终态任务全部中断、不自动重放、不占用活动名额", async () => {
    const harness = await createHarness({ streamFn: hangingStreamFn() });
    const { service, spaceId } = harness;
    const view = await service.submit({ memorySpaceId: spaceId, from: 0, to: 5 });

    // 模拟页面/浏览器重开：任务循环没跑任何块
    expect((await harness.tasks.find(view.runId))!.status).toBe("running");
    await service.markInterruptedOnStartup();

    const row = await harness.tasks.find(view.runId);
    expect(row).toMatchObject({ status: "interrupted", errorMessage: null });
    expect(await harness.tasks.findActive(spaceId)).toBeUndefined();
    expect(await floorStatuses(harness)).toEqual([
      "untracked",
      "untracked",
      "untracked",
      "untracked",
      "untracked",
      "untracked",
    ]);
    // 中断后活动名额释放：可提交新任务
    const resubmit = await service.submit({ memorySpaceId: spaceId, from: 0, to: 5 });
    expect(resubmit.status).toBe("running");
  });

  it("范围校验：非法楼层区间/分块大小提交即拒绝（可读原因），不创建任务", async () => {
    const harness = await createHarness();
    const { service, spaceId } = harness;

    for (const input of [
      { from: 3, to: 2 },
      { from: -1, to: 4 },
      { from: 0, to: 6 }, // to 越界（chatLength = 6）
      { from: 0, to: 5, blockSize: 0 },
      { from: 1.5, to: 5 },
    ] as const) {
      await service.submit({ memorySpaceId: spaceId, ...input }).catch((error) => {
        expect(error).toBeInstanceOf(FillTaskRangeError);
        expect((error as FillTaskRangeError).message).toContain("楼层");
      });
    }
    // 拒绝后无任务行
    expect(await harness.tasks.findActive(spaceId)).toBeUndefined();

    // 空对话（0 条消息）不可提交
    const emptySource: FillTaskSource = {
      chatMessageCount: () => 0,
      chatId: () => "story",
      messagesInRange: () => [],
    };
    const harness2 = await createHarness({ source: emptySource });
    await expect(
      harness2.service.submit({ memorySpaceId: harness2.spaceId, from: 0, to: 0 }),
    ).rejects.toBeInstanceOf(FillTaskRangeError);
  });

  it("LLM 配置缺失（createLlm 抛错）：提交即失败且不创建任务", async () => {
    const harness = await createHarness({ createLlmThrows: true });
    await expect(
      harness.service.submit({ memorySpaceId: harness.spaceId, from: 0, to: 1 }),
    ).rejects.toThrow(/Chat Completion 源未知/);
    expect(await harness.tasks.findActive(harness.spaceId)).toBeUndefined();
  });

  it("重复处理已成功范围：证据复用既有行（同源唯一不冲突），任务仍成功", async () => {
    const harness = await createHarness({ streamFn: scriptedFillAgent() });
    const { service, spaceId } = harness;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const view = await service.submit({ memorySpaceId: spaceId, from: 0, to: 1 });
      const terminal = await waitForTerminal(harness, view.runId);
      expect(terminal.status).toBe("succeeded");
    }

    // 两轮任务都成功：记录各新增 1 条；证据行不重复（同源唯一，第二轮复用既有行）
    const characters = (await harness.services.tableRepository.findByKey(
      spaceId,
      "characters" as never,
    ))!;
    expect(await harness.services.recordRepository.list(spaceId, characters.id)).toHaveLength(2);
    expect(await harness.db.memoryEvidence.toArray()).toHaveLength(2);
  });

  it("最近任务列表：createdAt 倒序、视图带进度计数", async () => {
    const harness = await createHarness({ streamFn: emptyProposalAgent() });
    const { service, spaceId } = harness;

    const first = await service.submit({ memorySpaceId: spaceId, from: 0, to: 1 });
    await waitForTerminal(harness, first.runId);
    const second = await service.submit({ memorySpaceId: spaceId, from: 2, to: 3 });
    await waitForTerminal(harness, second.runId);

    const recent = await service.recentTasks(spaceId, 5);
    expect(recent.map((row) => row.runId)).toEqual([second.runId, first.runId]);
    expect(recent[0]).toMatchObject({ status: "succeeded", processedCount: 2, totalCount: 2 });
  });

  it("失败任务重试：按原范围与原块大小重跑为新任务，旧任务保持 failed，error 楼层重跑成功覆盖为 processed", async () => {
    const harness = await createHarness({ streamFn: failOnceThenFill() });
    const { service, spaceId } = harness;

    // 首轮：块 [1,2] 失败 → 任务 failed，出错楼层标记 error
    const first = await service.submit({ memorySpaceId: spaceId, from: 1, to: 4, blockSize: 2 });
    const failed = await waitForTerminal(harness, first.runId);
    expect(failed.status).toBe("failed");
    expect(await floorStatuses(harness)).toEqual([
      "untracked",
      "error",
      "error",
      "untracked",
      "untracked",
      "untracked",
    ]);

    // 重试：新任务同范围同块大小；旧任务保持 failed 在历史
    const retried = await service.retry(spaceId, first.runId);
    expect(retried).toMatchObject({ status: "running", from: 1, to: 4, blockSize: 2 });
    expect(retried.runId).not.toBe(first.runId);

    const terminal = await waitForTerminal(harness, retried.runId);
    expect(terminal.status).toBe("succeeded");
    expect(await floorStatuses(harness)).toEqual([
      "untracked",
      "processed",
      "processed",
      "processed",
      "processed",
      "untracked",
    ]);
    const history = await service.recentTasks(spaceId, 5);
    expect(history.map((row) => [row.runId, row.status])).toEqual([
      [retried.runId, "succeeded"],
      [first.runId, "failed"],
    ]);
  });

  it("中断任务可重试：取消后按原范围重跑，新任务正常完成（不自动重放，手动重试生效）", async () => {
    // 第一轮（run 1）第一次流式调用被门控挂起：取消后任务停在 agent.run，无任何块提交
    const streamFn = gatedStreamFn(scriptedFillAgent().respond, 1);
    const harness = await createHarness({ streamFn });
    const { service, spaceId } = harness;

    const first = await service.submit({ memorySpaceId: spaceId, from: 0, to: 3, blockSize: 2 });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && streamFn.calls.count < 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(streamFn.calls.count).toBe(1);

    await service.cancel(spaceId, first.runId);
    expect(await harness.tasks.find(first.runId)).toMatchObject({ status: "interrupted" });
    expect(await floorStatuses(harness)).toEqual([
      "untracked",
      "untracked",
      "untracked",
      "untracked",
      "untracked",
      "untracked",
    ]);

    // 重试：新任务同范围，正常完成；run 1 保持 interrupted 在历史
    const retried = await service.retry(spaceId, first.runId);
    expect(retried).toMatchObject({ status: "running", from: 0, to: 3, blockSize: 2 });
    const terminal = await waitForTerminal(harness, retried.runId);
    expect(terminal.status).toBe("succeeded");
    expect(await floorStatuses(harness)).toEqual([
      "processed",
      "processed",
      "processed",
      "processed",
      "untracked",
      "untracked",
    ]);
    expect(await harness.tasks.find(first.runId)).toMatchObject({ status: "interrupted" });
  });

  it("活动任务期间重试旧任务被守卫拒绝：快速双击重试不产生双任务（冲突原因可读）", async () => {
    // run 1 第一次调用失败（任务 failed）；重试的新任务第二次调用被门控挂起（保持运行中）
    const streamFn = gatedStreamFn(makeFailFirstRespond(), 2);
    const harness = await createHarness({ streamFn });
    const { service, spaceId } = harness;

    const first = await service.submit({ memorySpaceId: spaceId, from: 0, to: 3, blockSize: 2 });
    const failed = await waitForTerminal(harness, first.runId);
    expect(failed.status).toBe("failed");

    // 第一次重试：新任务运行中（第 2 次流式调用被门控挂起）
    const retried = await service.retry(spaceId, first.runId);
    expect(retried.status).toBe("running");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && streamFn.calls.count < 2) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(streamFn.calls.count).toBe(2);

    // 再次重试同一旧任务：活动名额被新任务占用 → 冲突且携带当前任务
    await service.retry(spaceId, first.runId).catch((error) => {
      expect(error).toBeInstanceOf(FillTaskConflictError);
      expect((error as FillTaskConflictError).task.runId).toBe(retried.runId);
      expect((error as FillTaskConflictError).message).toContain("已有正在进行的填表任务");
    });
  });

  it("重试不存在的任务抛 NotFound", async () => {
    const harness = await createHarness();
    await expect(harness.service.retry(harness.spaceId, "run-missing")).rejects.toThrow(
      /填表任务不存在/,
    );
  });

  it("createComposeSystemPrompt：提交时构造的组合器注入 ProposalAgent（system prompt 含占位符展开文本）", async () => {
    let seenSystemPrompt: string | undefined;
    const stream = scriptedStreamFn((context) => {
      seenSystemPrompt = context.systemPrompt;
      return assistantMessage([textMessage("确认无需变更")], "stop");
    });
    const harness = await createHarness({
      streamFn: stream,
      // 与插件真实装配同构：预设文本 + 提交时快照的对话名字 → 组合器
      createComposeSystemPrompt: async () =>
        composePresetSystemPrompt(
          "你是{{char}}的破限填写员，服务于{{user}}\n\n{{tablesDigest}}",
          { user: "小明", char: "爱丽丝" },
          "",
        ),
    });
    const view = await harness.service.submit({ memorySpaceId: harness.spaceId, from: 0, to: 1 });
    await waitForTerminal(harness, view.runId);
    expect(seenSystemPrompt).toBeDefined();
    expect(seenSystemPrompt!).toContain("你是爱丽丝的破限填写员，服务于小明");
    expect(seenSystemPrompt!).toContain("可用表与字段"); // {{tablesDigest}} 展开
    expect(seenSystemPrompt!).not.toContain("{{char}}");
  });

  it("createComposeSystemPrompt：收到任务范围的合并剧情文本，{{worldbook}} 展开为扫描快照", async () => {
    let seenStoryText: string | undefined;
    let seenSystemPrompt: string | undefined;
    const stream = scriptedStreamFn((context) => {
      seenSystemPrompt = context.systemPrompt;
      return assistantMessage([textMessage("确认无需变更")], "stop");
    });
    const harness = await createHarness({
      streamFn: stream,
      createComposeSystemPrompt: async (storyText) => {
        seenStoryText = storyText;
        return composePresetSystemPrompt(
          "世界观参考：\n{{worldbook}}",
          { user: "小明", char: "爱丽丝" },
          storyText,
        );
      },
    });
    const view = await harness.service.submit({ memorySpaceId: harness.spaceId, from: 0, to: 1 });
    await waitForTerminal(harness, view.runId);
    // 合并文本 = 范围消息「名字：内容」逐行拼接（楼层升序），与构建契约一致
    expect(seenStoryText).toBe("爱丽丝：消息 1\n鲍勃：[reg] 原始内容 **带标记**");
    expect(seenSystemPrompt!).toContain(
      "世界观参考：\n爱丽丝：消息 1\n鲍勃：[reg] 原始内容 **带标记**",
    );
  });

  it("createComposeSystemPrompt 缺省：使用核心默认组合器（system prompt 为默认指令）", async () => {
    let seenSystemPrompt: string | undefined;
    const stream = scriptedStreamFn((context) => {
      seenSystemPrompt = context.systemPrompt;
      return assistantMessage([textMessage("确认无需变更")], "stop");
    });
    const harness = await createHarness({ streamFn: stream });
    const view = await harness.service.submit({ memorySpaceId: harness.spaceId, from: 0, to: 0 });
    await waitForTerminal(harness, view.runId);
    expect(seenSystemPrompt).toContain("你是记忆表格填写助手");
    expect(seenSystemPrompt).toContain("可用表与字段");
  });
});

describe("FillTaskService 内容清洗（ticket 22 / ADR 0011）", () => {
  /** 捕获每块喂给 Agent 的块提示词全文。 */
  function capturePrompts(onPrompt: (text: string) => void) {
    return scriptedStreamFn((context) => {
      for (const message of context.messages) {
        if (message.role !== "user") continue;
        for (const part of message.content) {
          if (typeof part === "string") {
            onPrompt(part);
          } else if (part.type === "text") {
            onPrompt(part.text);
          }
        }
      }
      return assistantMessage([textMessage("确认无需变更")], "stop");
    });
  }

  it("注入 resolveCleaningRules：喂给 Agent 的消息已按规则清洗；空规则保持原文", async () => {
    const prompts: string[] = [];
    const harness = await createHarness({
      streamFn: capturePrompts((text) => prompts.push(text)),
      resolveCleaningRules: () => [
        { id: "c1", name: "去标记", mode: "discard", pattern: "\\*\\*", flags: "g", enabled: true },
      ],
    });
    const view = await harness.service.submit({ memorySpaceId: harness.spaceId, from: 0, to: 5 });
    await waitForTerminal(harness, view.runId);
    const prompt = prompts.join("\n");
    expect(prompt).toContain("原始内容 带标记");
    expect(prompt).not.toContain("**");

    // 空规则列表 = 不清洗（缺省无端口由既有测试断言原文进提示词）
    const rawPrompts: string[] = [];
    const harness2 = await createHarness({
      streamFn: capturePrompts((text) => rawPrompts.push(text)),
      resolveCleaningRules: () => [],
    });
    const view2 = await harness2.service.submit({ memorySpaceId: harness2.spaceId, from: 0, to: 5 });
    await waitForTerminal(harness2, view2.runId);
    expect(rawPrompts.join("\n")).toContain("**带标记**");
  });

  it("规则在块处理时实时读取：中途变更对后续块生效（Q12）", async () => {
    const prompts: string[] = [];
    let calls = 0;
    const markedSource: FillTaskSource = {
      chatMessageCount: () => CHAT_LENGTH,
      chatId: () => "story",
      messagesInRange: (from, to) =>
        defaultMessagesInRange(from, to).map((message) =>
          message.floor === 4 ? { ...message, content: "消息 **带标记** 5" } : message,
        ),
    };
    const harness = await createHarness({
      source: markedSource,
      streamFn: capturePrompts((text) => prompts.push(text)),
      resolveCleaningRules: () => {
        calls += 1;
        return calls === 1
          ? [{ id: "c1", name: "去标记", mode: "discard", pattern: "\\*\\*", flags: "g", enabled: true }]
          : [];
      },
    });
    const view = await harness.service.submit({
      memorySpaceId: harness.spaceId,
      from: 0,
      to: 5,
      blockSize: 3,
    });
    await waitForTerminal(harness, view.runId);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("原始内容 带标记");
    expect(prompts[0]).not.toContain("**");
    expect(prompts[1]).toContain("**带标记**");
  });
});

describe("FillTaskService 填表日志（通用日志写入，ADR 0008）", () => {
  /** 把日志行还原为运行记录（data 载荷）。 */
  function record(entry: LogEntry): FillRunRecord {
    return entry.data as FillRunRecord;
  }

  it("成功任务：每块一条 info 级运行记录，快照逐轮请求/工具调用/输出/系统提示词", async () => {
    const streamFn = scriptedFillAgent();
    const harness = await createHarness({ streamFn });
    const { service, spaceId, logs } = harness;

    const view = await service.submit({ memorySpaceId: spaceId, from: 0, to: 5, blockSize: 2 });
    await waitForTerminal(harness, view.runId);

    const entries = await logs.byKey(view.runId, 10);
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        type: "fill",
        key: view.runId,
        spaceId,
        level: "info",
      });
    }
    // 时间倒序：块 {4,5} 最新
    const records = entries.map(record).reverse();
    expect(records.map((r) => r.block)).toEqual([
      { from: 0, to: 1 },
      { from: 2, to: 3 },
      { from: 4, to: 5 },
    ]);
    for (const run of records) {
      expect(run).toMatchObject({ taskRunId: view.runId, status: "succeeded", errorMessage: null });
      // 系统提示词快照 = 模型实际收到的 systemPrompt（三块一致）
      expect(run.systemPrompt).toBe(streamFn.contexts[0]!.systemPrompt);
      expect(run.startedAt).toBe(NOW);
      expect(run.endedAt).toBe(NOW);
      expect(typeof run.durationMs).toBe("number");
    }

    // 块 {2,3} = 第 3、4 次流式调用：逐轮请求与输出如实记录
    const middle = records[1]!;
    expect(middle.rounds).toHaveLength(2);
    expect(middle.rounds[0]!.request.messages).toEqual(streamFn.contexts[2]!.messages);
    expect(middle.rounds[0]!.output.stopReason).toBe("toolUse");
    expect(middle.rounds[0]!.output.errorMessage).toBeUndefined();
    // 工具调用：参数与结果配对（含 isError）
    expect(middle.rounds[0]!.toolResults.map((t) => t.toolName)).toEqual([
      MUTATE_TOOL_NAME,
      PROPOSAL_PREVIEW_TOOL_NAME,
      SUBMIT_PROPOSAL_TOOL_NAME,
    ]);
    expect(middle.rounds[0]!.toolResults[0]!.args).toEqual({
      op: "create",
      table: "characters",
      patch: { name: "云烬" },
    });
    expect(middle.rounds[0]!.toolResults.every((t) => t.isError === false)).toBe(true);
    // 第二轮：请求含工具结果历史，输出为最终回答
    expect(middle.rounds[1]!.request.messages).toEqual(streamFn.contexts[3]!.messages);
    // 第二轮请求 = 用户消息 + 工具轮输出 + 3 条工具结果（自包含历史）
    expect(middle.rounds[1]!.request.messages).toHaveLength(5);
    expect(middle.rounds[1]!.output.stopReason).toBe("stop");
    expect(middle.rounds[1]!.toolResults).toEqual([]);
  });

  it("空提案块：单轮直接回答也记录（无工具调用）", async () => {
    const harness = await createHarness({ streamFn: emptyProposalAgent() });
    const { service, spaceId, logs } = harness;

    const view = await service.submit({ memorySpaceId: spaceId, from: 0, to: 1 });
    await waitForTerminal(harness, view.runId);

    const entries = await logs.byKey(view.runId, 10);
    expect(entries).toHaveLength(1);
    const run = record(entries[0]!);
    expect(run).toMatchObject({ status: "succeeded", block: { from: 0, to: 1 } });
    expect(run.rounds).toHaveLength(1);
    expect(run.rounds[0]!.output.stopReason).toBe("stop");
    expect(run.rounds[0]!.toolResults).toEqual([]);
  });

  it("块失败：error 级记录，含已完成轮与失败原因", async () => {
    const streamFn = failingAgent();
    const harness = await createHarness({ streamFn });
    const { service, spaceId, logs } = harness;

    const view = await service.submit({ memorySpaceId: spaceId, from: 0, to: 3, blockSize: 2 });
    const terminal = await waitForTerminal(harness, view.runId);
    expect(terminal.status).toBe("failed");

    const entries = await logs.byKey(view.runId, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe("error");
    const run = record(entries[0]!);
    expect(run).toMatchObject({
      status: "failed",
      block: { from: 0, to: 1 },
      errorMessage: "Agent 运行失败：模型炸了",
    });
    expect(run.rounds).toHaveLength(1);
    expect(run.rounds[0]!.output.stopReason).toBe("error");
    expect(run.rounds[0]!.output.errorMessage).toBe("模型炸了");
  });

  it("任务取消：进行中块写 warn 级 interrupted 记录（提案被丢弃），已提交块保持 succeeded", async () => {
    const streamFn = gatedStreamFn(scriptedFillAgent().respond, 3);
    const harness = await createHarness({ streamFn });
    const { service, spaceId, logs } = harness;

    const view = await service.submit({ memorySpaceId: spaceId, from: 0, to: 5, blockSize: 2 });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && streamFn.calls.count < 3) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await service.cancel(spaceId, view.runId);
    streamFn.gate.open();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await harness.tasks.find(view.runId)).toMatchObject({ status: "interrupted" });

    const entries = await logs.byKey(view.runId, 10);
    expect(entries).toHaveLength(2);
    // 最新一条 = 中断块
    const interrupted = record(entries[0]!);
    expect(entries[0]!.level).toBe("warn");
    expect(interrupted).toMatchObject({
      status: "interrupted",
      block: { from: 2, to: 3 },
      errorMessage: null,
    });
    // 中断块已完成两轮（工具轮 + 回答轮），提案未落库
    expect(interrupted.rounds).toHaveLength(2);
    expect(interrupted.rounds[0]!.toolResults.map((t) => t.toolName)).toContain(MUTATE_TOOL_NAME);
    const committed = record(entries[1]!);
    expect(entries[1]!.level).toBe("info");
    expect(committed).toMatchObject({ status: "succeeded", block: { from: 0, to: 1 } });
  });

  it("日志追加失败不影响任务（审计写入 best-effort）", async () => {
    const harness = await createHarness({
      streamFn: emptyProposalAgent(),
      logs: {
        append: async () => {
          throw new Error("日志表写入失败");
        },
        byType: async () => [],
        byKey: async () => [],
        bySpace: async () => [],
        recent: async () => [],
        clearAll: async () => undefined,
      },
    });
    const { service, spaceId } = harness;

    const view = await service.submit({ memorySpaceId: spaceId, from: 0, to: 1 });
    const terminal = await waitForTerminal(harness, view.runId);
    expect(terminal.status).toBe("succeeded");
    expect(await floorStatuses(harness)).toEqual([
      "processed",
      "processed",
      "untracked",
      "untracked",
      "untracked",
      "untracked",
    ]);
  });
});
