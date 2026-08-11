import { describe, expect, it } from "vitest";
import {
  MUTATE_TOOL_NAME,
  PROPOSAL_PREVIEW_TOOL_NAME,
  SUBMIT_PROPOSAL_TOOL_NAME,
  type MemorySpaceReader,
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

interface Harness {
  readonly service: FillTaskService;
  readonly db: SteMemoryDatabase;
  readonly services: TestServices;
  readonly spaceId: MemorySpaceId;
  readonly tasks: DexieFillTaskRepository;
  readonly ledger: DexieFloorLedgerRepository;
}

let harnessSeq = 0;

async function createHarness(
  options: {
    readonly streamFn?: StreamFn;
    readonly createLlmThrows?: boolean;
    readonly source?: FillTaskSource;
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
  });
  return { service, db, services, spaceId, tasks, ledger };
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
});
