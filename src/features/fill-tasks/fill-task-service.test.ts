import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import {
  MUTATE_TOOL_NAME,
  PROPOSAL_PREVIEW_TOOL_NAME,
  QUERY_RECORDS_TOOL_NAME,
  SUBMIT_PROPOSAL_TOOL_NAME,
} from "../agent/index.ts";
import {
  MemoryRecordService,
  MemoryRecordQueryService,
  type MemoryEvidenceId,
  type MemoryRecordHistoryId,
  type MemoryRecordId,
  type MemoryRevisionId,
  type MemorySpaceId,
  type MemorySpaceReader,
} from "../memory/index.ts";
import type { StreamFn } from "@earendil-works/pi-agent-core";
// fake-indexeddb 必须先于 dexie 模块求值（test-support 第一行 import "fake-indexeddb/auto"）
import {
  createTestDatabase,
  createTestLogDatabase,
  createServices,
  installDefaultPreset,
  type TestServices,
} from "../../infrastructure/indexeddb/test-support.ts";
import {
  DexieFillTaskRepository,
  DexieFloorLedgerRepository,
} from "../../infrastructure/indexeddb/fill-tasks/fill-task-repository.ts";
import type { SteMemoryDatabase } from "../../infrastructure/indexeddb/database.ts";
import {
  FillTaskConflictError,
  FillTaskRangeError,
  FillTaskStateError,
  type FillTaskSource,
} from "./fill-task.ts";
import { FillTaskService, type FillTaskPromptContext } from "./fill-task-service.ts";
import type { composePresetMessages } from "../agent-presets/preset-composer.ts";
import type { AgentPromptPreset } from "../agent-presets/preset-model.ts";
import {
  assistantMessage,
  fakeModel,
  gatedStreamFn,
  hangingStreamFn,
  lastToolResult,
  scriptedStreamFn,
  textMessage,
  thinkingMessage,
  toolCallMessage,
} from "./stream-fn-support.ts";
import type { FillSourceMessage } from "./fill-task.ts";
import type { LogEntry, LogRepository } from "../logging/log.ts";
import { DexieLogRepository } from "../../infrastructure/indexeddb/logs/log-repository.ts";
import type { CleaningRule } from "../cleaning/cleaning-rule-lists.ts";

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

/** 测试预设：内容/角色列表 → AgentPromptPreset（id/name 与组合器无关） */
function testPreset(
  messages: readonly { role: "system" | "user" | "assistant"; content: string }[],
): AgentPromptPreset {
  return {
    id: "p1",
    name: "测试预设",
    messages: messages.map((m, i) => ({
      id: `m${i}`,
      name: "",
      role: m.role,
      content: m.content,
      enabled: true,
    })),
  };
}

/** 占位符展开快照（缺省空值；测试按需覆盖）。 */
function snapshot(overrides: Partial<Parameters<typeof composePresetMessages>[1]> = {}) {
  return {
    names: { user: "小明", char: "爱丽丝" },
    charCard: "",
    userCard: "",
    worldbookText: "",
    msgText: "",
    ...overrides,
  };
}

/** 消息纯文本（LLM 消息 content 可能是字符串或文本块数组）。 */
function textOf(message: { readonly role: string; readonly content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  return (message.content as readonly { type: string; text?: string }[])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
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

/** 台账注入失败替身：验证批次提交与台账标记同事务（markProcessed 抛错 → 记录也回滚）。 */
class FailingLedgerRepository extends DexieFloorLedgerRepository {
  override async markProcessed(
    _memorySpaceId: MemorySpaceId,
    _floors: readonly number[],
  ): Promise<void> {
    throw new Error("台账写入失败（测试注入）");
  }
}

/**
 * 台账写入后把任务行置 interrupted 的替身：模拟取消落在批提交与批结束行之间
 * （记录已提交、任务随即中断），验证批结束行状态取自本批实际结果。
 */
class CancellingLedgerRepository extends DexieFloorLedgerRepository {
  readonly #cancel: () => Promise<void>;

  constructor(db: SteMemoryDatabase, now: () => string, cancel: () => Promise<void>) {
    super(db, now);
    this.#cancel = cancel;
  }

  override async markProcessed(
    memorySpaceId: MemorySpaceId,
    floors: readonly number[],
  ): Promise<void> {
    await super.markProcessed(memorySpaceId, floors);
    await this.#cancel();
  }
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
    readonly createPromptContext?: (
      storyText: string,
    ) => Promise<FillTaskPromptContext | undefined>;
    readonly logs?: LogRepository;
    readonly logError?: (message: string, error: unknown) => void;
    readonly resolveCleaningRules?: () => readonly CleaningRule[];
    /** 台账 markProcessed 注入失败（事务回滚验证；缺省 = 真实 Dexie 台账） */
    readonly failLedgerMarkProcessed?: boolean;
    /** 台账写入后并发取消（取消落在批提交与批结束行之间；缺省 = 不取消） */
    readonly cancelDuringCommit?: boolean;
  } = {},
): Promise<Harness> {
  const db = createTestDatabase(`ste-fill-${++harnessSeq}-`);
  const services = createServices(db, () => NOW);
  const { spaces, tables, fields } = services;
  const space = await spaces.create("会话");
  await installDefaultPreset(db, space.id);
  const spaceId = space.id;

  const tasks = new DexieFillTaskRepository(db, () => NOW);
  let ledger: DexieFloorLedgerRepository = options.failLedgerMarkProcessed
    ? new FailingLedgerRepository(db, () => NOW)
    : new DexieFloorLedgerRepository(db, () => NOW);
  if (options.cancelDuringCommit) {
    // 取消走任务行状态（与并发取消同一步骤）：台账写入完成后立即中断当前任务
    ledger = new CancellingLedgerRepository(
      db,
      () => NOW,
      async () => {
        const active = await tasks.findActive(spaceId);
        if (active) await tasks.markInterrupted(active.runId);
      },
    );
  }
  const logs = options.logs ?? new DexieLogRepository(createTestLogDatabase(), { now: () => NOW });
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
  const recordWriter = new MemoryRecordService(
    services.tableRepository,
    services.fieldRepository,
    services.recordRepository,
    () => `record-${++recordSeq}` as MemoryRecordId,
    () => `history-${++historySeq}` as MemoryRecordHistoryId,
    () => `revision-${++revisionSeq}` as MemoryRevisionId,
    () => NOW,
  );
  let runSeq = 0;
  const service = new FillTaskService({
    tasks,
    ledger,
    source,
    reader,
    ports,
    evidence: services.recordRepository,
    recordWriter,
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
          // 提交事务复检任务行（running 才写入）：任务表必须在事务作用域内
          db.memoryFillTasks,
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
    createPromptContext: options.createPromptContext,
    resolveCleaningRules: options.resolveCleaningRules,
    logError: options.logError,
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

/** 按 Key 查询并把结果翻转为插入序（= 时间序），供行流顺序断言。 */
async function logRowsByKey(harness: Harness, runId: string) {
  const entries = await harness.logs.byKey(runId, 100);
  return [...entries].reverse();
}

/** 生命周期行（过滤掉 fill-agent 请求行）：issue 02 断言任务/批起止顺序与级别。 */
function lifecycleRows(rows: readonly LogEntry[]): readonly LogEntry[] {
  return rows.filter((row) => row.type !== "fill-agent");
}

/**
 * 等任务结束行落库：任务行置终态与结束行写入之间有时序间隙
 * （markFailed/markSucceeded 先落库，结束日志随后 append）。
 */
async function waitForTaskEndRow(harness: Harness, runId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await harness.logs.byKey(runId, 100);
    if (rows.some((row) => row.type === "fill-task" && payloadOf(row).phase === "end")) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`任务 ${runId} 的结束日志行未在 5s 内落库`);
}

/** 日志行文本 → 解析后的载荷（Pretty JSON，查询侧零解析）。 */
function payloadOf(entry: { readonly text: string }): Record<string, unknown> {
  return JSON.parse(entry.text) as Record<string, unknown>;
}

describe("FillTaskService（手动楼层触发与运行，ticket 13）", () => {
  it("空间结构重建后旧任务无法写入：提交事务内复检任务行（spec 6.3 / AC-12）", async () => {
    const streamFn = gatedStreamFn(scriptedFillAgent().respond, 1);
    const harness = await createHarness({ streamFn });
    const { service, spaceId, db } = harness;

    const view = await service.submit({ memorySpaceId: spaceId, from: 0, to: 1, blockSize: 2 });
    // 等门控：Agent 已产出提案，尚未进入提交（安全点 2 已过、事务未开）
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && streamFn.calls.count < 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(streamFn.calls.count).toBe(1);

    // 模拟应用预设的原子重建：任务行被删除（真实路径同时替换空间结构）。
    // 提交事务在任务表上与重建互斥，且事务内复检任务行 —— 旧任务不再写入。
    await db.memoryFillTasks.where("memorySpaceId").equals(spaceId).delete();

    streamFn.gate.open();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 旧任务没有落下任何记录/历史/证据/台账，也没有复活任务行
    expect(await db.memoryRecords.count()).toBe(0);
    expect(await db.memoryRecordHistory.count()).toBe(0);
    expect(await db.memoryEvidence.count()).toBe(0);
    expect(await db.floorFillLedger.count()).toBe(0);
    expect(await db.memoryFillTasks.count()).toBe(0);
    expect(await service.activeTask(spaceId)).toBeUndefined();
    expect(view.runId).toBeTruthy();
  });

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

  it("台账标记失败：记录提交与台账更新同事务回滚（无半批数据、楼层保持 untracked）", async () => {
    // 台账写入抛错（同事务内第二步失败）：整批回滚，记录/历史/证据都不落库
    const harness = await createHarness({
      streamFn: scriptedFillAgent(),
      failLedgerMarkProcessed: true,
    });
    const { service, spaceId, services } = harness;

    const view = await service.submit({ memorySpaceId: spaceId, from: 0, to: 1, blockSize: 2 });
    const terminal = await waitForTerminal(harness, view.runId);
    expect(terminal.status).toBe("failed");
    expect(terminal.errorMessage).toContain("台账写入失败");

    // 记录/历史/证据与台账同事务：提交被回滚，数据一行不留
    const characters = (await services.tableRepository.findByKey(spaceId, "characters" as never))!;
    expect(await services.recordRepository.list(spaceId, characters.id)).toHaveLength(0);
    expect(await harness.db.memoryRecordHistory.count()).toBe(0);
    expect(await harness.db.memoryEvidence.count()).toBe(0);
    // 台账「processed」标记随事务回滚（同批不产生半批状态）；失败收口在事务之外
    // 单独把出错块标记 error，其余楼层保持 untracked（与块失败语义一致）
    expect(await floorStatuses(harness)).toEqual([
      "error",
      "error",
      "untracked",
      "untracked",
      "untracked",
      "untracked",
    ]);
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
    await vi.waitFor(async () => {
      const rows = lifecycleRows(await logRowsByKey(harness, view.runId));
      expect(
        rows.some(
          (row) =>
            row.type === "fill-run" &&
            payloadOf(row).batch === 2 &&
            payloadOf(row).status === "interrupted",
        ),
      ).toBe(true);
    });
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

  it("createPromptContext：system 消息展开进 system prompt（占位符单遍展开）", async () => {
    let seenSystemPrompt: string | undefined;
    const stream = scriptedStreamFn((context) => {
      seenSystemPrompt = context.systemPrompt;
      return assistantMessage([textMessage("确认无需变更")], "stop");
    });
    const harness = await createHarness({
      streamFn: stream,
      // 与插件真实装配同构：预设 + 提交时快照 → service 块循环展开编排消息
      createPromptContext: async () => ({
        preset: testPreset([
          {
            role: "system",
            content: "你是{{char}}的破限填写员，服务于{{user}}\n\n{{tablesDigest}}",
          },
        ]),
        snapshot: snapshot({ names: { user: "小明", char: "爱丽丝" } }),
      }),
    });
    const view = await harness.service.submit({ memorySpaceId: harness.spaceId, from: 0, to: 1 });
    await waitForTerminal(harness, view.runId);
    expect(seenSystemPrompt).toBeDefined();
    expect(seenSystemPrompt!).toContain("你是爱丽丝的破限填写员，服务于小明");
    expect(seenSystemPrompt!).toContain("可用表与字段"); // {{tablesDigest}} 展开
    expect(seenSystemPrompt!).not.toContain("{{char}}");
  });

  it("createPromptContext：收到任务范围的合并剧情文本，{{worldbook}} 展开为扫描快照", async () => {
    let seenStoryText: string | undefined;
    let seenSystemPrompt: string | undefined;
    const stream = scriptedStreamFn((context) => {
      seenSystemPrompt = context.systemPrompt;
      return assistantMessage([textMessage("确认无需变更")], "stop");
    });
    const harness = await createHarness({
      streamFn: stream,
      createPromptContext: async (storyText) => {
        seenStoryText = storyText;
        return {
          preset: testPreset([{ role: "system", content: "世界观参考：\n{{worldbook}}" }]),
          snapshot: snapshot({ worldbookText: storyText }),
        };
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

  it("createPromptContext：{{msg}} 引用时本轮消息为空，块内容只经占位符展开", async () => {
    let seenMessages: readonly { readonly role: string; readonly text: string }[] = [];
    const stream = scriptedStreamFn((context) => {
      seenMessages = context.messages.map((m) => ({ role: m.role, text: textOf(m) }));
      return assistantMessage([textMessage("确认无需变更")], "stop");
    });
    const harness = await createHarness({
      streamFn: stream,
      createPromptContext: async () => ({
        // 预设引用 {{msg}}：接管消息编排（本轮消息 = []，块内容只经占位符展开）
        preset: testPreset([
          { role: "system", content: "你是记忆助手。" },
          { role: "user", content: "请总结：\n{{msg}}" },
        ]),
        snapshot: snapshot(),
      }),
    });
    const view = await harness.service.submit({ memorySpaceId: harness.spaceId, from: 0, to: 1 });
    await waitForTerminal(harness, view.runId);
    // 对话 = system（进 systemPrompt，不在 messages）+ 编排 user（含块内容）；
    // 没有追加的块提示词（{{msg}} 接管）
    expect(seenMessages.map((m) => m.role)).toEqual(["user"]);
    expect(seenMessages[0]!.text).toContain("请总结：");
    expect(seenMessages[0]!.text).toContain("[0] 爱丽丝：消息 1");
    expect(seenMessages[0]!.text).toContain("[1] 鲍勃：[reg] 原始内容 **带标记**");
    expect(seenMessages[0]!.text).not.toContain("请依据这些消息更新记忆表格");
    // system 消息内容进入 system prompt（对话消息不含 system 角色）
    expect(seenMessages.some((m) => m.role === "system")).toBe(false);
  });

  it("createPromptContext：编排 user/assistant 消息作为对话前缀，块提示词追加在最后", async () => {
    let seenMessages: readonly { readonly role: string; readonly text: string }[] = [];
    const stream = scriptedStreamFn((context) => {
      seenMessages = context.messages.map((m) => ({ role: m.role, text: textOf(m) }));
      return assistantMessage([textMessage("确认无需变更")], "stop");
    });
    const harness = await createHarness({
      streamFn: stream,
      createPromptContext: async () => ({
        preset: testPreset([
          { role: "user", content: "开场设定问题" },
          { role: "assistant", content: "开场回答" },
        ]),
        snapshot: snapshot(),
      }),
    });
    const view = await harness.service.submit({ memorySpaceId: harness.spaceId, from: 0, to: 0 });
    await waitForTerminal(harness, view.runId);
    // 前缀（编排 user/assistant）+ 追加的块提示词（最后一条 user）
    expect(seenMessages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(seenMessages[0]!.text).toBe("开场设定问题");
    expect(seenMessages[1]!.text).toBe("开场回答");
    expect(seenMessages[2]!.text).toContain("以下是需要处理的对话消息（消息 0 到 0，共 1 条）：");
  });

  it("createPromptContext 缺省：使用核心默认提示词（system prompt 为默认指令）", async () => {
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

  it("assistant 结尾预设直接进入 run（守卫已删）：{{msg}} 接管 + 无 user 消息不报错", async () => {
    let seenMessages: readonly { readonly role: string; readonly text: string }[] = [];
    const stream = scriptedStreamFn((context) => {
      seenMessages = context.messages.map((m) => ({ role: m.role, text: textOf(m) }));
      return assistantMessage([textMessage("确认无需变更")], "stop");
    });
    const harness = await createHarness({
      streamFn: stream,
      createPromptContext: async () => ({
        preset: testPreset([
          { role: "system", content: "你是记忆助手。" },
          { role: "assistant", content: "开场回答\n{{msg}}" },
        ]),
        snapshot: snapshot(),
      }),
    });
    const view = await harness.service.submit({ memorySpaceId: harness.spaceId, from: 0, to: 1 });
    const terminal = await waitForTerminal(harness, view.runId);
    // 任务成功：assistant 结尾的编排消息直接进入 run（不再抛「最后一条必须 user」）
    expect(terminal.status).toBe("succeeded");
    expect(seenMessages.map((m) => m.role)).toEqual(["assistant"]);
    expect(seenMessages[0]!.text).toContain("[0] 爱丽丝：消息 1");
    expect(seenMessages[0]!.text).not.toContain("请依据这些消息更新记忆表格");
  });
});

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

describe("FillTaskService 内容清洗（ticket 22 / ADR 0011）", () => {
  it("注入 resolveCleaningRules：喂给 Agent 的消息已按规则清洗；空规则保持原文", async () => {
    const prompts: string[] = [];
    const harness = await createHarness({
      streamFn: capturePrompts((text) => prompts.push(text)),
      resolveCleaningRules: () => [
        {
          id: "c1",
          name: "去标记",
          mode: "discard",
          type: "regex",
          pattern: "\\*\\*",
          flags: "g",
          enabled: true,
        },
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
    const view2 = await harness2.service.submit({
      memorySpaceId: harness2.spaceId,
      from: 0,
      to: 5,
    });
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
          ? [
              {
                id: "c1",
                name: "去标记",
                mode: "discard",
                type: "regex",
                pattern: "\\*\\*",
                flags: "g",
                enabled: true,
              },
            ]
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

describe("FillTaskService 填表开始日志（ticket 01 / ADR 0015）", () => {
  it("楼层任务提交：写入 fill-task 开始行（kind/range/batchSize/startedAt，Pretty JSON，info）", async () => {
    const harness = await createHarness({ streamFn: emptyProposalAgent() });
    const view = await harness.service.submit({
      memorySpaceId: harness.spaceId,
      from: 0,
      to: 5,
      blockSize: 2,
    });

    // 开始行在提交时写入；查询时任务可能已跑完（结束行也随之落库），
    // 断言目标 = 开始行本身（按 phase 定位，不依赖任务完成时机）
    const entries = await harness.logs.byKey(view.runId, 10);
    const start = entries.find(
      (entry) => entry.type === "fill-task" && payloadOf(entry).phase === "start",
    );
    expect(start).toMatchObject({ type: "fill-task", key: view.runId, level: "info" });
    expect(start!.text).toBe(
      JSON.stringify(
        {
          phase: "start",
          kind: "floor",
          range: { from: 0, to: 5 },
          batchSize: 2,
          startedAt: NOW,
        },
        null,
        2,
      ),
    );
  });

  it("初始化填表提交：开始行 kind=init，省略 range", async () => {
    const harness = await createHarness({ streamFn: emptyProposalAgent() });
    const view = await harness.service.submitInit({
      memorySpaceId: harness.spaceId,
      text: "设定",
    });

    // 同楼层任务：从已落行中定位开始行（任务可能已跑完）
    const entries = await harness.logs.byKey(view.runId, 10);
    const start = entries.find(
      (entry) => entry.type === "fill-task" && payloadOf(entry).phase === "start",
    );
    const payload = payloadOf(start!) as Record<string, unknown>;
    expect(payload).toEqual({
      phase: "start",
      kind: "init",
      batchSize: 1,
      startedAt: NOW,
    });
    expect(payload).not.toHaveProperty("range");
  });

  it("开始行写入失败：只记警告，不阻断任务（best-effort）", async () => {
    const logError = vi.fn();
    const harness = await createHarness({
      streamFn: emptyProposalAgent(),
      logError,
      logs: {
        append: async () => {
          throw new Error("日志库写入失败");
        },
        recent: async () => [],
        byKey: async () => [],
        clearAll: async () => undefined,
      },
    });

    const view = await harness.service.submit({ memorySpaceId: harness.spaceId, from: 0, to: 1 });
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("开始日志写入失败"),
      expect.any(Error),
    );

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

describe("FillTaskService 填表生命周期行流（issue 02 / ADR 0016）", () => {
  it("成功任务：任务起止 + 每批起止行按时间序写入，内容与级别正确，文本为 Pretty JSON", async () => {
    const harness = await createHarness({ streamFn: scriptedFillAgent() });
    const view = await harness.service.submit({
      memorySpaceId: harness.spaceId,
      from: 0,
      to: 5,
      blockSize: 2,
    });
    await waitForTerminal(harness, view.runId);
    await waitForTaskEndRow(harness, view.runId);

    const rows = await logRowsByKey(harness, view.runId);
    const lifecycle = lifecycleRows(rows);
    // 生命周期行 = 任务开始 → 每批开始/结束 → 任务结束（全部 info：开始行 + 成功结束行）
    expect(lifecycle.map((row) => [row.type, row.level])).toEqual([
      ["fill-task", "info"],
      ["fill-run", "info"],
      ["fill-run", "info"],
      ["fill-run", "info"],
      ["fill-run", "info"],
      ["fill-run", "info"],
      ["fill-run", "info"],
      ["fill-task", "info"],
    ]);
    expect(payloadOf(lifecycle[0]!)).toEqual({
      phase: "start",
      kind: "floor",
      range: { from: 0, to: 5 },
      batchSize: 2,
      startedAt: NOW,
    });
    for (const [index, batch] of [
      [0, 1],
      [1, 2],
      [2, 3],
    ] as const) {
      const block = { from: batch * 2 - 2, to: batch * 2 - 1 };
      expect(payloadOf(lifecycle[index * 2 + 1]!)).toEqual({
        phase: "start",
        batch,
        block,
        startedAt: NOW,
      });
      expect(payloadOf(lifecycle[index * 2 + 2]!)).toEqual({
        phase: "end",
        batch,
        block,
        status: "succeeded",
        errorMessage: null,
        endedAt: NOW,
        durationMs: 0,
      });
    }
    expect(payloadOf(lifecycle[7]!)).toEqual({
      phase: "end",
      status: "succeeded",
      errorMessage: null,
      endedAt: NOW,
      durationMs: 0,
    });
    // 全部行均为 Pretty JSON（可直接阅读），无单行小 JSON
    expect(rows.every((row) => row.text.includes("\n"))).toBe(true);
  });

  it("失败任务：出错批结束行与任务结束行为 error 级并携带失败原因，已提交批正常收尾", async () => {
    // 前两次调用（块 1）成功；第 3 次起（块 2）失败
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
    const view = await harness.service.submit({
      memorySpaceId: harness.spaceId,
      from: 0,
      to: 3,
      blockSize: 2,
    });
    const terminal = await waitForTerminal(harness, view.runId);
    expect(terminal.status).toBe("failed");
    await waitForTaskEndRow(harness, view.runId);

    const rows = await logRowsByKey(harness, view.runId);
    const lifecycle = lifecycleRows(rows);
    expect(lifecycle.map((row) => [row.type, row.level])).toEqual([
      ["fill-task", "info"],
      ["fill-run", "info"],
      ["fill-run", "info"],
      ["fill-run", "info"],
      ["fill-run", "error"],
      ["fill-task", "error"],
    ]);
    // 块 1 成功、块 2 失败（失败原因进入批结束行与任务结束行）
    expect(payloadOf(lifecycle[2]!)).toMatchObject({ phase: "end", batch: 1, status: "succeeded" });
    expect(payloadOf(lifecycle[4]!)).toEqual({
      phase: "end",
      batch: 2,
      block: { from: 2, to: 3 },
      status: "failed",
      errorMessage: "Agent 运行失败：模型炸了",
      endedAt: NOW,
      durationMs: 0,
    });
    expect(payloadOf(lifecycle[5]!)).toEqual({
      phase: "end",
      status: "failed",
      errorMessage: "Agent 运行失败：模型炸了",
      endedAt: NOW,
      durationMs: 0,
    });
  });

  it("运行中即可查询已完成行；取消后进行中批以 interrupted 收尾，任务结束行为中断（warn）", async () => {
    const streamFn = gatedStreamFn(scriptedFillAgent().respond, 3);
    const harness = await createHarness({ streamFn });
    const view = await harness.service.submit({
      memorySpaceId: harness.spaceId,
      from: 0,
      to: 5,
      blockSize: 2,
    });
    // 等块 2 开始（第 3 次调用被门控挂起）：块 1 已提交完成
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && streamFn.calls.count < 3) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(streamFn.calls.count).toBe(3);

    // 边跑边写：任务开始 + 块 1 起止 + 块 2 开始已可见，无需等任务结束
    const running = lifecycleRows(await logRowsByKey(harness, view.runId));
    expect(running.map((row) => [row.type, row.level])).toEqual([
      ["fill-task", "info"],
      ["fill-run", "info"],
      ["fill-run", "info"],
      ["fill-run", "info"],
    ]);
    expect(payloadOf(running[2]!)).toMatchObject({ phase: "end", batch: 1, status: "succeeded" });
    expect(payloadOf(running[3]!)).toEqual({
      phase: "start",
      batch: 2,
      block: { from: 2, to: 3 },
      startedAt: NOW,
    });

    // 取消：任务结束行（interrupted，warn）立即写入
    const cancelled = await harness.service.cancel(harness.spaceId, view.runId);
    expect(cancelled).toMatchObject({
      runId: view.runId,
      status: "interrupted",
      errorMessage: null,
    });
    const afterCancel = lifecycleRows(await logRowsByKey(harness, view.runId));
    expect(afterCancel[4]).toMatchObject({ type: "fill-task", level: "warn" });
    expect(payloadOf(afterCancel[4]!)).toEqual({
      phase: "end",
      status: "interrupted",
      errorMessage: null,
      endedAt: NOW,
      durationMs: 0,
    });

    // 放行块 2：批 2 以 interrupted 收尾（warn），楼层不标记（重试语义）
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
    const final = lifecycleRows(await logRowsByKey(harness, view.runId));
    expect(final.map((row) => [row.type, row.level])).toEqual([
      ["fill-task", "info"],
      ["fill-run", "info"],
      ["fill-run", "info"],
      ["fill-run", "info"],
      ["fill-task", "warn"],
      ["fill-run", "warn"],
    ]);
    expect(payloadOf(final[5]!)).toEqual({
      phase: "end",
      batch: 2,
      block: { from: 2, to: 3 },
      status: "interrupted",
      errorMessage: null,
      endedAt: NOW,
      durationMs: 0,
    });
  });

  it("初始化填表：任务与批次数命周期行省略楼层区间（block/range）", async () => {
    const harness = await createHarness({ streamFn: scriptedFillAgent() });
    const view = await harness.service.submitInit({
      memorySpaceId: harness.spaceId,
      text: "爱丽丝是雨城咖啡店店员",
    });
    await waitForTerminal(harness, view.runId);
    await waitForTaskEndRow(harness, view.runId);

    const rows = lifecycleRows(await logRowsByKey(harness, view.runId));
    expect(rows.map((row) => [row.type, row.level])).toEqual([
      ["fill-task", "info"],
      ["fill-run", "info"],
      ["fill-run", "info"],
      ["fill-task", "info"],
    ]);
    expect(payloadOf(rows[0]!)).toEqual({
      phase: "start",
      kind: "init",
      batchSize: 1,
      startedAt: NOW,
    });
    expect(payloadOf(rows[1]!)).toEqual({ phase: "start", batch: 1, startedAt: NOW });
    expect(payloadOf(rows[2]!)).toEqual({
      phase: "end",
      batch: 1,
      status: "succeeded",
      errorMessage: null,
      endedAt: NOW,
      durationMs: 0,
    });
    expect(payloadOf(rows[3]!)).toEqual({
      phase: "end",
      status: "succeeded",
      errorMessage: null,
      endedAt: NOW,
      durationMs: 0,
    });
    expect(rows.every((row) => !("block" in payloadOf(row)))).toBe(true);
  });
  it("启动标记：被中断的任务写入 interrupted 结束行（warn），进行中批只留开始行", async () => {
    const harness = await createHarness({ streamFn: hangingStreamFn() });
    const view = await harness.service.submit({ memorySpaceId: harness.spaceId, from: 0, to: 5 });
    // 等块 1 上下文行落库（Agent 挂起：任务开始 + 批开始 + 上下文行已写，无轮次、无批结束行）
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (await harness.logs.byKey(view.runId, 10)).length < 3) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await harness.logs.byKey(view.runId, 10)).length).toBe(3);

    await harness.service.markInterruptedOnStartup();

    const rows = await logRowsByKey(harness, view.runId);
    expect(rows.map((row) => [row.type, row.level])).toEqual([
      ["fill-task", "info"],
      ["fill-run", "info"],
      ["fill-agent", "info"],
      ["fill-task", "warn"],
    ]);
    expect(payloadOf(rows[3]!)).toEqual({
      phase: "end",
      status: "interrupted",
      errorMessage: null,
      endedAt: NOW,
      durationMs: 0,
    });
  });

  it("批/结束行写入失败：只记警告，任务正常完成（best-effort）", async () => {
    const logError = vi.fn();
    let appends = 0;
    const harness = await createHarness({
      streamFn: emptyProposalAgent(),
      logError,
      logs: {
        append: async () => {
          appends += 1;
          if (appends > 1) throw new Error("日志库写入失败");
        },
        recent: async () => [],
        byKey: async () => [],
        clearAll: async () => undefined,
      },
    });
    const view = await harness.service.submit({
      memorySpaceId: harness.spaceId,
      from: 0,
      to: 5,
      blockSize: 2,
    });
    const terminal = await waitForTerminal(harness, view.runId);
    expect(terminal.status).toBe("succeeded");
    expect(await floorStatuses(harness)).toEqual([
      "processed",
      "processed",
      "processed",
      "processed",
      "processed",
      "processed",
    ]);
    // 首行（任务开始）成功；批起止与任务结束行失败只记警告（断言带 runId 前缀，
    // 与批次消息区分：任务行失败消息 = 「填表任务 <runId> 结束日志写入失败」）
    const warned = logError.mock.calls.map(([message]) => String(message));
    expect(
      warned.some((message) => message.includes(`填表任务 ${view.runId} 批次 1 开始日志写入失败`)),
    ).toBe(true);
    expect(
      warned.some((message) => message.includes(`填表任务 ${view.runId} 批次 3 结束日志写入失败`)),
    ).toBe(true);
    expect(
      warned.some((message) => message.includes(`填表任务 ${view.runId} 结束日志写入失败`)),
    ).toBe(true);
    expect(
      warned.some((message) => message.includes(`填表任务 ${view.runId} 开始日志写入失败`)),
    ).toBe(false);
  });

  it("取消落在批提交之后：批结束行记 succeeded（本批已写入），不被随后的中断改写", async () => {
    const harness = await createHarness({ cancelDuringCommit: true });
    const view = await harness.service.submit({
      memorySpaceId: harness.spaceId,
      from: 0,
      to: 1,
      blockSize: 2,
    });
    const terminal = await waitForTerminal(harness, view.runId);

    // 取消在提交事务内落地：记录已写入，任务行被置 interrupted
    expect(terminal.status).toBe("interrupted");
    expect(await harness.db.memoryRecords.count()).toBe(1);

    // 批结束行状态取自本批是否真正写入：已提交的批保持 succeeded，
    // 任务级中断由任务行/取消路径的结束行表达
    const runs = lifecycleRows(await logRowsByKey(harness, view.runId)).filter(
      (row) => row.type === "fill-run",
    );
    expect(payloadOf(runs.at(-1)!)).toMatchObject({ phase: "end", status: "succeeded" });
    expect(runs.at(-1)!.level).toBe("info");
  });
});

describe("FillTaskService 填表 Agent 决策行（ADR 0016「上下文 + 轮次」）", () => {
  /** 预设：system 进系统提示词，user/assistant 进请求前缀（上下文行可见）。 */
  const PRESET = testPreset([
    { role: "system", content: "你是{{char}}的填表助手" },
    { role: "user", content: "请按提示填写" },
    { role: "assistant", content: "明白" },
  ]);

  /** Agent 行（按时间序过滤 fill-agent；含每批上下文行与逐轮 turn 行）。 */
  async function agentRows(harness: Harness, runId: string) {
    return (await logRowsByKey(harness, runId)).filter((row) => row.type === "fill-agent");
  }

  /** 上下文行（每批首条，kind: context）。 */
  function contextRows(rows: readonly LogEntry[]) {
    return rows.filter((row) => payloadOf(row).kind === "context");
  }

  /** turn 行（kind: turn；上下文行与之互斥）。 */
  function turnRows(rows: readonly LogEntry[]) {
    return rows.filter((row) => payloadOf(row).kind === "turn");
  }

  it("成功任务：每批一条上下文行（系统提示词/预设/本批消息分列），逐轮 turn 行含思考/输出/用量与工具调用结果", async () => {
    const streamFn = scriptedStreamFn((context) => {
      if (!lastToolResult(context)) {
        const message = assistantMessage(
          [
            thinkingMessage("先查一遍角色表"),
            textMessage("先确认现有角色"),
            toolCallMessage("call-1", QUERY_RECORDS_TOOL_NAME, { table: "characters" }),
          ],
          "toolUse",
        );
        return {
          ...message,
          usage: { ...message.usage, input: 1234, output: 567, totalTokens: 1801 },
        };
      }
      return assistantMessage([textMessage("无需变更")], "stop");
    });
    const harness = await createHarness({
      streamFn,
      createPromptContext: async () => ({ preset: PRESET, snapshot: snapshot() }),
    });
    const view = await harness.service.submit({
      memorySpaceId: harness.spaceId,
      from: 0,
      to: 3,
      blockSize: 2,
    });
    await waitForTerminal(harness, view.runId);
    await waitForTaskEndRow(harness, view.runId);

    // 两块各（上下文 + 2 轮）：上下文行在批开始行之后、turn 行在前（边跑边写的时间序）
    const allRows = await logRowsByKey(harness, view.runId);
    expect(allRows.map((row) => row.type)).toEqual([
      "fill-task",
      "fill-run",
      "fill-agent",
      "fill-agent",
      "fill-agent",
      "fill-run",
      "fill-run",
      "fill-agent",
      "fill-agent",
      "fill-agent",
      "fill-run",
      "fill-task",
    ]);

    const rows = await agentRows(harness, view.runId);
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.level === "info")).toBe(true);
    const contexts = contextRows(rows).map(payloadOf);
    const turns = turnRows(rows).map(payloadOf);

    // 上下文行：systemPrompt 快照 + 预设消息与批消息分列（预设 user/assistant，批消息单独）
    for (const [payload, batch, block, inputText] of [
      [contexts[0]!, 1, { from: 0, to: 1 }, "消息 1"],
      [contexts[1]!, 2, { from: 2, to: 3 }, "消息 3"],
    ] as const) {
      expect(payload).toMatchObject({ batch, block, kind: "context" });
      expect(payload.systemPrompt).toBe("你是爱丽丝的填表助手");
      expect(
        (payload.preset as readonly { role: string; text: string }[]).map((m) => [m.role, m.text]),
      ).toEqual([
        ["user", "请按提示填写"],
        ["assistant", "明白"],
      ]);
      expect(
        (payload.input as readonly { role: string; text: string }[]).map((m) => m.text).join(),
      ).toContain(inputText);
    }

    // turn 行：输出侧与工具结果同轮
    expect(turns[0]).toMatchObject({ batch: 1, round: 1 });
    expect(turns[0]!.thinking).toBe("先查一遍角色表");
    expect(turns[0]!.output).toBe("先确认现有角色");
    expect(turns[0]).toMatchObject({
      stopReason: "toolUse",
      usage: { input: 1234, output: 567, totalTokens: 1801 },
    });
    const tools = turns[0]!.tools as readonly {
      readonly id: string;
      readonly name: string;
      readonly args: Record<string, unknown>;
      readonly result?: unknown;
      readonly isError?: boolean;
    }[];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      id: "call-1",
      name: QUERY_RECORDS_TOOL_NAME,
      args: { table: "characters" },
      isError: false,
    });
    expect(typeof tools[0]!.result).toBe("string");
    expect(turns[1]).toMatchObject({ batch: 1, round: 2, stopReason: "stop", tools: [] });
    expect(turns[1]!.output).toBe("无需变更");
  });

  it("失败任务：失败轮 turn 行为 error 级，已发生的轮次行均落库", async () => {
    // 块 1 两轮成功（info）；块 2 首轮即失败（error 级 turn 行）
    const calls = { n: 0 };
    const streamFn = scriptedStreamFn((context) => {
      calls.n += 1;
      if (calls.n >= 3) return assistantMessage([textMessage("模型炸了")], "error", "模型炸了");
      if (!lastToolResult(context)) {
        return assistantMessage(
          [toolCallMessage("call-1", QUERY_RECORDS_TOOL_NAME, { table: "characters" })],
          "toolUse",
        );
      }
      return assistantMessage([textMessage("无需变更")], "stop");
    });
    const harness = await createHarness({ streamFn });
    const view = await harness.service.submit({
      memorySpaceId: harness.spaceId,
      from: 0,
      to: 3,
      blockSize: 2,
    });
    expect((await waitForTerminal(harness, view.runId)).status).toBe("failed");
    await waitForTaskEndRow(harness, view.runId);

    const rows = await agentRows(harness, view.runId);
    const turnEntries = turnRows(rows);
    const turns = turnEntries.map(payloadOf);
    expect(
      turnEntries.map((row, index) => [row.level, turns[index]!.round, turns[index]!.batch]),
    ).toEqual([
      ["info", 1, 1],
      ["info", 2, 1],
      ["error", 1, 2],
    ]);
    expect(turns[2]).toMatchObject({ stopReason: "error", errorMessage: "模型炸了", tools: [] });
    // 已发生（成功块）的轮次行不受后续失败影响，仍在库里
    expect(turns[1]!.stopReason).toBe("stop");
  });

  it("中断任务：已发生的上下文行与轮次行落库，进行中批以 interrupted 收尾", async () => {
    const streamFn = gatedStreamFn(scriptedFillAgent().respond, 3);
    const harness = await createHarness({ streamFn });
    const view = await harness.service.submit({
      memorySpaceId: harness.spaceId,
      from: 0,
      to: 3,
      blockSize: 2,
    });
    // 等块 2 首轮被门控挂起：块 1 上下文 + 2 轮已落库，块 2 上下文已写、轮次未产生
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && streamFn.calls.count < 3) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await agentRows(harness, view.runId)).toHaveLength(4);

    await harness.service.cancel(harness.spaceId, view.runId);
    // 取消后放行块 2：进行中轮次照常落库（任务已中断，行仍完整），随后循环收尾
    streamFn.gate.open();
    const released = Date.now() + 5_000;
    while (Date.now() < released && (await agentRows(harness, view.runId)).length < 6) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const rows = await agentRows(harness, view.runId);
    expect(contextRows(rows)).toHaveLength(2);
    const turns = turnRows(rows);
    expect(turns.map((row) => row.level)).toEqual(["info", "info", "info", "info"]);
    expect(turns.map((row) => payloadOf(row).round)).toEqual([1, 2, 1, 2]);
    expect(turns.map((row) => payloadOf(row).batch)).toEqual([1, 1, 2, 2]);
  });

  it("初始化填表：上下文行省略楼层区间（block）且无预设，turn 行 round 从 1 递增", async () => {
    const harness = await createHarness({ streamFn: scriptedFillAgent() });
    const view = await harness.service.submitInit({
      memorySpaceId: harness.spaceId,
      text: "爱丽丝是雨城咖啡店店员",
    });
    await waitForTerminal(harness, view.runId);
    await waitForTaskEndRow(harness, view.runId);

    const rows = await agentRows(harness, view.runId);
    const contexts = contextRows(rows).map(payloadOf);
    const turns = turnRows(rows).map(payloadOf);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ batch: 1, kind: "context" });
    expect(contexts[0]).not.toHaveProperty("block");
    expect(typeof contexts[0]!.systemPrompt).toBe("string");
    expect(contexts[0]!.systemPrompt).not.toBe("");
    expect(contexts[0]!.preset).toEqual([]);
    expect((contexts[0]!.input as readonly { role: string; text: string }[])[0]!.text).toContain(
      "爱丽丝是雨城咖啡店店员",
    );

    expect(turns.map((payload) => payload.round)).toEqual([1, 2]);
    expect(turns.every((payload) => payload.batch === 1)).toBe(true);
    expect(turns.every((payload) => !("block" in payload))).toBe(true);
  });
});
describe("FillTaskService（初始化填表，spec init-fill）", () => {
  const INIT_TEXT = "爱丽丝是雨城咖啡店店员，今天第一次见到客人小明";

  it("端到端：submitInit 创建 init 任务，单块 Agent 跑完，记录与 snapshot 证据落库，无台账行，任务 succeeded", async () => {
    const streamFn = scriptedFillAgent();
    const harness = await createHarness({ streamFn });
    const { service, spaceId } = harness;

    const view = await service.submitInit({ memorySpaceId: spaceId, text: INIT_TEXT });
    expect(view).toMatchObject({
      status: "running",
      kind: "init",
      initText: INIT_TEXT,
      from: 0,
      to: 0,
      blockSize: 1,
      processedCount: 0,
      totalCount: 1,
    });

    const terminal = await waitForTerminal(harness, view.runId);
    expect(terminal).toEqual({ status: "succeeded", errorMessage: null });

    // 记录落库（修订来源 agent）；证据 = 单条 snapshot（source_type init、source_id runId、内容原文）
    const characters = (await harness.services.tableRepository.findByKey(
      spaceId,
      "characters" as never,
    ))!;
    const records = await harness.services.recordRepository.list(spaceId, characters.id);
    expect(records).toHaveLength(1);
    expect(records[0]!.revisionSource).toBe("agent");
    const evidenceRows = await harness.db.memoryEvidence.toArray();
    expect(evidenceRows).toHaveLength(1);
    expect(evidenceRows[0]).toMatchObject({
      storage_mode: "snapshot",
      source_type: "init",
      source_id: view.runId,
      content: INIT_TEXT,
    });
    // 无台账行（init 任务不读写楼层台账）
    expect(await floorStatuses(harness)).toEqual([
      "untracked",
      "untracked",
      "untracked",
      "untracked",
      "untracked",
      "untracked",
    ]);
    // 单块 = 一次 Agent run（工具轮 + 回答轮）
    expect(streamFn.calls.count).toBe(2);
  });

  it("重复 submitInit：每次生成独立 snapshot 证据（source_id = runId 不同）", async () => {
    const harness = await createHarness({ streamFn: scriptedFillAgent() });
    const { service, spaceId } = harness;

    const first = await service.submitInit({ memorySpaceId: spaceId, text: "第一版设定" });
    await waitForTerminal(harness, first.runId);
    const second = await service.submitInit({ memorySpaceId: spaceId, text: "第二版设定" });
    await waitForTerminal(harness, second.runId);

    const evidenceRows = await harness.db.memoryEvidence.toArray();
    expect(evidenceRows).toHaveLength(2);
    expect(
      evidenceRows.map((row) => [
        row.source_type,
        row.source_id,
        row.storage_mode,
        row.storage_mode === "snapshot" ? row.content : undefined,
      ]),
    ).toEqual([
      ["init", first.runId, "snapshot", "第一版设定"],
      ["init", second.runId, "snapshot", "第二版设定"],
    ]);
  });

  it("清洗规则应用于初始化文本：喂给 Agent 的文本已清洗，证据存原文", async () => {
    const prompts: string[] = [];
    // 捕获提示词的同时提交提案（空提案不落证据，无法验证证据原文）
    const streamFn = scriptedStreamFn((context) => {
      for (const message of context.messages) {
        if (message.role !== "user") continue;
        for (const part of message.content) {
          if (typeof part === "string") {
            prompts.push(part);
          } else if (part.type === "text") {
            prompts.push(part.text);
          }
        }
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
    const harness = await createHarness({
      streamFn,
      resolveCleaningRules: () => [
        {
          id: "c1",
          name: "去标记",
          mode: "discard",
          type: "regex",
          pattern: "\\*\\*",
          flags: "g",
          enabled: true,
        },
      ],
    });
    const view = await harness.service.submitInit({
      memorySpaceId: harness.spaceId,
      text: "设定 **带标记** 原文",
    });
    const terminal = await waitForTerminal(harness, view.runId);
    expect(terminal.status).toBe("succeeded");

    const prompt = prompts.join("\n");
    expect(prompt).toContain("设定 带标记 原文");
    expect(prompt).not.toContain("**");
    // 证据存原文（清洗只作用于 Agent 输入，不破坏证据）
    const evidenceRows = await harness.db.memoryEvidence.toArray();
    expect(evidenceRows[0]).toMatchObject({ content: "设定 **带标记** 原文" });
  });

  it("{{msg}} 引用：初始化文本经占位符展开（合成消息格式），本轮无自动追加", async () => {
    let seenMessages: readonly { readonly role: string; readonly text: string }[] = [];
    const stream = scriptedStreamFn((context) => {
      seenMessages = context.messages.map((m) => ({ role: m.role, text: textOf(m) }));
      return assistantMessage([textMessage("确认无需变更")], "stop");
    });
    const harness = await createHarness({
      streamFn: stream,
      createPromptContext: async () => ({
        preset: testPreset([
          { role: "system", content: "你是记忆助手。" },
          { role: "user", content: "请根据以下设定初始化表格：\n{{msg}}" },
        ]),
        snapshot: snapshot(),
      }),
    });
    const view = await harness.service.submitInit({
      memorySpaceId: harness.spaceId,
      text: INIT_TEXT,
    });
    await waitForTerminal(harness, view.runId);

    expect(seenMessages).toHaveLength(1);
    expect(seenMessages[0]!.role).toBe("user");
    expect(seenMessages[0]!.text).toContain("请根据以下设定初始化表格：");
    expect(seenMessages[0]!.text).toContain(INIT_TEXT);
    // 合成消息格式 = composeBlockMessagesText(0, 0, [楼层 0 合成消息])
    expect(seenMessages[0]!.text).toContain("[0]");
  });

  it("{{msg}} 未引用：块提示词自动追加（含初始化文本），与楼层任务旧行为一致", async () => {
    let seenMessages: readonly { readonly role: string; readonly text: string }[] = [];
    const stream = scriptedStreamFn((context) => {
      seenMessages = context.messages.map((m) => ({ role: m.role, text: textOf(m) }));
      return assistantMessage([textMessage("确认无需变更")], "stop");
    });
    const harness = await createHarness({
      streamFn: stream,
      createPromptContext: async () => ({
        preset: testPreset([{ role: "system", content: "你是记忆助手。" }]),
        snapshot: snapshot(),
      }),
    });
    const view = await harness.service.submitInit({
      memorySpaceId: harness.spaceId,
      text: INIT_TEXT,
    });
    await waitForTerminal(harness, view.runId);

    expect(seenMessages).toHaveLength(1);
    expect(seenMessages[0]!.text).toContain("以下是需要处理的对话消息（消息 0 到 0，共 1 条）");
    expect(seenMessages[0]!.text).toContain(INIT_TEXT);
    expect(seenMessages[0]!.text).toContain("请依据这些消息更新记忆表格");
  });

  it("{{worldbook}} 扫描输入 = 初始化文本", async () => {
    let seenStoryText: string | undefined;
    const harness = await createHarness({
      streamFn: emptyProposalAgent(),
      createPromptContext: async (storyText) => {
        seenStoryText = storyText;
        return {
          preset: testPreset([{ role: "system", content: "参考：\n{{worldbook}}" }]),
          snapshot: snapshot({ worldbookText: storyText }),
        };
      },
    });
    const view = await harness.service.submitInit({
      memorySpaceId: harness.spaceId,
      text: INIT_TEXT,
    });
    await waitForTerminal(harness, view.runId);
    expect(seenStoryText).toBe(INIT_TEXT);
  });

  it("空文本允许：空白初始化文本也提交并成功（Agent 空提案）", async () => {
    const harness = await createHarness({ streamFn: emptyProposalAgent() });
    const view = await harness.service.submitInit({ memorySpaceId: harness.spaceId, text: "   " });
    const terminal = await waitForTerminal(harness, view.runId);
    expect(terminal.status).toBe("succeeded");
    // 空提案不落数据（与楼层空提案语义一致：证据随批次提交保存）
    expect(await harness.db.memoryEvidence.toArray()).toHaveLength(0);
  });

  it("与楼层任务互斥（双向）：init 运行中提交楼层任务抛冲突，反之亦然", async () => {
    const harness = await createHarness({ streamFn: hangingStreamFn() });
    const { service, spaceId } = harness;

    const init = await service.submitInit({ memorySpaceId: spaceId, text: INIT_TEXT });
    const floorWhileInit = await service
      .submit({ memorySpaceId: spaceId, from: 0, to: 1 })
      .catch((error) => {
        expect(error).toBeInstanceOf(FillTaskConflictError);
        expect((error as FillTaskConflictError).task.runId).toBe(init.runId);
        return null;
      });
    expect(floorWhileInit).toBeNull();

    await service.cancel(spaceId, init.runId);
    const floor = await service.submit({ memorySpaceId: spaceId, from: 0, to: 1 });
    expect(floor.status).toBe("running");
    const initWhileFloor = await service
      .submitInit({ memorySpaceId: spaceId, text: INIT_TEXT })
      .catch((error) => {
        expect(error).toBeInstanceOf(FillTaskConflictError);
        expect((error as FillTaskConflictError).task.runId).toBe(floor.runId);
        return null;
      });
    expect(initWhileFloor).toBeNull();
  });

  it("失败任务重试：init 任务复用原文本重跑为新任务（kind=init），旧任务保持 failed", async () => {
    const harness = await createHarness({ streamFn: failOnceThenFill() });
    const { service, spaceId } = harness;

    const first = await service.submitInit({ memorySpaceId: spaceId, text: INIT_TEXT });
    const failed = await waitForTerminal(harness, first.runId);
    expect(failed.status).toBe("failed");

    const retried = await service.retry(spaceId, first.runId);
    expect(retried).toMatchObject({
      status: "running",
      kind: "init",
      initText: INIT_TEXT,
      totalCount: 1,
    });
    const terminal = await waitForTerminal(harness, retried.runId);
    expect(terminal.status).toBe("succeeded");
  });

  it("用户取消：init 任务立即 interrupted，未提交提案丢弃、无数据落库", async () => {
    const streamFn = gatedStreamFn(scriptedFillAgent().respond, 1);
    const harness = await createHarness({ streamFn });
    const { service, spaceId } = harness;

    const view = await service.submitInit({ memorySpaceId: spaceId, text: INIT_TEXT });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && streamFn.calls.count < 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(streamFn.calls.count).toBe(1);

    await service.cancel(spaceId, view.runId);
    expect(await harness.tasks.find(view.runId)).toMatchObject({ status: "interrupted" });

    // 放行 Agent：提交前安全点检测到中断，提案丢弃、证据不落库
    streamFn.gate.open();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await harness.tasks.find(view.runId)).toMatchObject({ status: "interrupted" });
    expect(await harness.db.memoryEvidence.toArray()).toHaveLength(0);
    const characters = (await harness.services.tableRepository.findByKey(
      spaceId,
      "characters" as never,
    ))!;
    expect(await harness.services.recordRepository.list(spaceId, characters.id)).toHaveLength(0);
  });

  it("LLM 配置缺失：submitInit 提交即失败且不创建任务", async () => {
    const harness = await createHarness({ createLlmThrows: true });
    await expect(
      harness.service.submitInit({ memorySpaceId: harness.spaceId, text: INIT_TEXT }),
    ).rejects.toThrow(/Chat Completion 源未知/);
    expect(await harness.tasks.findActive(harness.spaceId)).toBeUndefined();
  });
});

describe("FillTaskService 标记楼层进度（ticket 25）", () => {
  it("标记 processed：范围内楼层写入 processed 状态", async () => {
    const harness = await createHarness();
    await harness.service.markFloorStatuses(harness.spaceId, 0, 2, "processed");
    expect(await floorStatuses(harness)).toEqual([
      "processed",
      "processed",
      "processed",
      "untracked",
      "untracked",
      "untracked",
    ]);
  });

  it("标记 error：范围内楼层写入 error 状态", async () => {
    const harness = await createHarness();
    await harness.service.markFloorStatuses(harness.spaceId, 1, 3, "error");
    expect(await floorStatuses(harness)).toEqual([
      "untracked",
      "error",
      "error",
      "error",
      "untracked",
      "untracked",
    ]);
  });

  it("标记 untracked：删除范围内台账行（目标 untracked 语义）", async () => {
    const harness = await createHarness();
    await harness.service.markFloorStatuses(harness.spaceId, 0, 2, "processed");
    await harness.service.markFloorStatuses(harness.spaceId, 1, 2, "untracked");
    expect(await floorStatuses(harness)).toEqual([
      "processed",
      "untracked",
      "untracked",
      "untracked",
      "untracked",
      "untracked",
    ]);
  });

  it("运行中任务守卫：有活动任务时拒绝操作（FillTaskConflictError）", async () => {
    const harness = await createHarness({ streamFn: hangingStreamFn() });
    await harness.service.submit({ memorySpaceId: harness.spaceId, from: 0, to: 5 });
    await expect(
      harness.service.markFloorStatuses(harness.spaceId, 0, 2, "processed"),
    ).rejects.toThrow(FillTaskConflictError);
  });

  it("范围校验：非法楼层区间拒绝操作（FillTaskRangeError）", async () => {
    const harness = await createHarness();
    await expect(
      harness.service.markFloorStatuses(harness.spaceId, 5, 2, "processed"),
    ).rejects.toThrow(FillTaskRangeError);
    await expect(
      harness.service.markFloorStatuses(harness.spaceId, -1, 2, "processed"),
    ).rejects.toThrow(FillTaskRangeError);
    await expect(
      harness.service.markFloorStatuses(harness.spaceId, 0, 10, "processed"),
    ).rejects.toThrow(FillTaskRangeError);
  });

  it("覆盖语义：error 楼层可被 processed 覆盖，反之亦然", async () => {
    const harness = await createHarness();
    await harness.service.markFloorStatuses(harness.spaceId, 0, 2, "error");
    await harness.service.markFloorStatuses(harness.spaceId, 1, 2, "processed");
    expect(await floorStatuses(harness)).toEqual([
      "error",
      "processed",
      "processed",
      "untracked",
      "untracked",
      "untracked",
    ]);
  });

  it("单楼层操作（from === to）", async () => {
    const harness = await createHarness();
    await harness.service.markFloorStatuses(harness.spaceId, 3, 3, "processed");
    expect(await floorStatuses(harness)).toEqual([
      "untracked",
      "untracked",
      "untracked",
      "processed",
      "untracked",
      "untracked",
    ]);
  });
});

describe("自动填表批内重试", () => {
  it("耗尽配置次数后失败，并在任务终态前通知持久化暂停", async () => {
    const streamFn = failingAgent();
    const harness = await createHarness({ streamFn });
    const onFailure = vi.fn();
    const task = await harness.service.submit({
      memorySpaceId: harness.spaceId,
      from: 0,
      to: 1,
      automatic: { retries: 1, delaySeconds: 1, canContinue: () => true, onFailure },
    });
    expect((await waitForTerminal(harness, task.runId)).status).toBe("failed");
    expect(streamFn.calls.count).toBe(2);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(expect.stringContaining("模型炸了"));
    expect(harness.service.retryStates.size).toBe(0);
  });

  it("每批独立重试且不重放成功批次", async () => {
    let calls = 0;
    const streamFn = scriptedStreamFn(() => {
      calls += 1;
      return calls === 2 || calls === 4
        ? assistantMessage([textMessage("失败")], "error", "失败")
        : assistantMessage([textMessage("无需变更")], "stop");
    });
    const harness = await createHarness({ streamFn });
    const task = await harness.service.submit({
      memorySpaceId: harness.spaceId,
      from: 0,
      to: 5,
      blockSize: 2,
      automatic: { retries: 1, delaySeconds: 1, canContinue: () => true },
    });
    expect((await waitForTerminal(harness, task.runId, 10000)).status).toBe("succeeded");
    expect(calls).toBe(5);
    expect(await harness.ledger.processedCount(harness.spaceId, 0, 5)).toBe(6);
    expect(harness.service.retryStates.size).toBe(0);
  });

  it("取消等待立即停止倒计时，不继续尝试", async () => {
    const streamFn = failingAgent();
    const harness = await createHarness({ streamFn });
    const task = await harness.service.submit({
      memorySpaceId: harness.spaceId,
      from: 0,
      to: 1,
      automatic: { retries: 2, delaySeconds: 10, canContinue: () => true },
    });
    await vi.waitFor(() => expect(harness.service.retryStates.has(task.runId)).toBe(true));
    await harness.service.cancel(harness.spaceId, task.runId);
    await vi.waitFor(() => expect(harness.service.retryStates.has(task.runId)).toBe(false));
    expect((await harness.tasks.find(task.runId))?.status).toBe("interrupted");
    expect(streamFn.calls.count).toBe(1);
  });
});
