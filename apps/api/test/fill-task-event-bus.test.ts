/**
 * InMemoryFillTaskEventBus 单测（ticket 16）：
 * 缓冲/回放/续传/终态/清理/截断/扇出，不依赖 HTTP 与 Agent。
 */
import { describe, expect, it } from "vitest";
import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { AgentRunEvent } from "../src/application/agent-events.ts";
import {
  FILL_TASK_EVENT_BUFFER_LIMIT,
  InMemoryFillTaskEventBus,
  MAX_TOOL_PAYLOAD_CHARS,
} from "../src/application/fill-tasks/fill-task-event-bus.ts";
import type { AgentRunEventEntry } from "../src/application/ports/fill-task-events.ts";
import type { FillTask, FillTaskStatus } from "../src/application/ports/fill-task.ts";

const SPACE = "space-1" as MemorySpaceId;
const RUN = "run-1";
const now = "2026-07-30T01:02:03.000Z";

function task(status: FillTaskStatus = "running"): FillTask {
  return {
    runId: RUN,
    memorySpaceId: SPACE,
    from: 1,
    to: 4,
    blockSize: 4,
    status,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** 以可变任务列表构造总线（fake findTask 反映任务行最新状态）。 */
function busWith(tasks: FillTask[]) {
  return new InMemoryFillTaskEventBus(async (runId) => tasks.find((item) => item.runId === runId));
}

function blockStart(from = 1, to = 4): AgentRunEvent {
  return { type: "block_start", from, to };
}

async function collect(
  bus: InMemoryFillTaskEventBus,
  afterSeq?: number,
): Promise<{ entries: AgentRunEventEntry[]; unsubscribe: () => void }> {
  const entries: AgentRunEventEntry[] = [];
  const unsubscribe = (await bus.subscribe(SPACE, RUN, afterSeq, (entry) => entries.push(entry)))!;
  return { entries, unsubscribe };
}

describe("InMemoryFillTaskEventBus", () => {
  it("先回放缓冲再实时转发，seq 单调递增；退订后不再收到", async () => {
    const bus = busWith([task()]);
    bus.emit(RUN, blockStart());
    bus.emit(RUN, { type: "thinking_delta", text: "查表" });
    const { entries, unsubscribe } = await collect(bus);
    expect(entries.map((entry) => entry.event.type)).toEqual(["block_start", "thinking_delta"]);
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2]);

    bus.emit(RUN, {
      type: "block_done",
      from: 1,
      to: 4,
      emptyProposal: false,
      changedRecords: 1,
    });
    expect(entries.at(-1)!.seq).toBe(3);
    expect(entries.at(-1)!.event.type).toBe("block_done");

    unsubscribe();
    bus.emit(RUN, { type: "task_status", status: "succeeded", errorMessage: null });
    expect(entries.length).toBe(3);
  });

  it("afterSeq 只回放其后的事件；afterSeq 太旧时回放全部缓冲", async () => {
    const bus = busWith([task()]);
    bus.emit(RUN, blockStart());
    bus.emit(RUN, { type: "tool_start", callId: "c1", name: "query_records", args: {} });
    bus.emit(RUN, {
      type: "tool_result",
      callId: "c1",
      name: "query_records",
      result: [],
      isError: false,
    });

    const partial = await collect(bus, 1);
    expect(partial.entries.map((entry) => entry.seq)).toEqual([2, 3]);
    partial.unsubscribe();

    const all = await collect(bus, 0);
    expect(all.entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    all.unsubscribe();
  });

  it("缓冲有界：超过上限时最旧事件被挤出", async () => {
    const bus = busWith([task()]);
    for (let seq = 1; seq <= FILL_TASK_EVENT_BUFFER_LIMIT + 5; seq += 1) {
      bus.emit(RUN, { type: "thinking_delta", text: `t${seq}` });
    }
    const { entries } = await collect(bus);
    expect(entries.length).toBe(FILL_TASK_EVENT_BUFFER_LIMIT);
    expect(entries[0]!.seq).toBe(6);
    expect(entries.at(-1)!.seq).toBe(FILL_TASK_EVENT_BUFFER_LIMIT + 5);
  });

  it("多订阅者各自收到完整流；一个订阅者抛错不影响其他订阅者与后续 emit", async () => {
    const bus = busWith([task()]);
    const first: AgentRunEventEntry[] = [];
    const second: AgentRunEventEntry[] = [];
    const unsubscribe1 = (await bus.subscribe(SPACE, RUN, undefined, (entry) => {
      first.push(entry);
      if (entry.event.type === "tool_start") throw new Error("订阅者写失败");
    }))!;
    const unsubscribe2 = (await bus.subscribe(SPACE, RUN, undefined, (entry) =>
      second.push(entry),
    ))!;

    bus.emit(RUN, blockStart());
    bus.emit(RUN, { type: "tool_start", callId: "c1", name: "query_records", args: {} });
    bus.emit(RUN, {
      type: "tool_result",
      callId: "c1",
      name: "query_records",
      result: [],
      isError: false,
    });

    expect(first.length).toBe(3);
    expect(second.length).toBe(3);
    unsubscribe1();
    unsubscribe2();
  });

  it("run 不存在或不属于该空间返回 undefined", async () => {
    const bus = busWith([task()]);
    expect(
      await bus.subscribe("space-2" as MemorySpaceId, RUN, undefined, () => undefined),
    ).toBeUndefined();
    expect(await bus.subscribe(SPACE, "run-unknown", undefined, () => undefined)).toBeUndefined();
  });

  it("任务终态后订阅：缓冲仍在时回放含终态，不注册实时监听", async () => {
    const bus = busWith([task("succeeded")]);
    bus.emit(RUN, blockStart());
    bus.emit(RUN, { type: "task_status", status: "succeeded", errorMessage: null });
    const { entries, unsubscribe } = await collect(bus);
    expect(entries.map((entry) => entry.event.type)).toEqual(["block_start", "task_status"]);
    expect(entries.at(-1)!.event).toMatchObject({ status: "succeeded" });
    unsubscribe(); // 空退订：不应抛错
  });

  it("release 清理无订阅者状态；之后订阅只收到按任务行补发的终态", async () => {
    const bus = busWith([task("failed")]);
    bus.emit(RUN, blockStart());
    bus.release(RUN);
    const { entries } = await collect(bus);
    expect(entries).toEqual([
      { seq: 1, event: { type: "task_status", status: "failed", errorMessage: null } },
    ]);
  });

  it("运行中退订保留缓冲；任务终态且无订阅者时由 release 清理", async () => {
    const tasks = [task()];
    const bus = busWith(tasks);
    bus.emit(RUN, blockStart());
    const first = await collect(bus);
    first.unsubscribe(); // 任务仍运行：退订只删监听，缓冲保留（重连续传依赖）

    const replay = await collect(bus);
    expect(replay.entries.map((entry) => entry.event.type)).toEqual(["block_start"]);
    replay.unsubscribe();

    // 任务终态（缓冲里无终态事件 → 按任务行补发）；终态路径不注册实时监听
    tasks[0] = task("succeeded");
    const late = await collect(bus);
    expect(late.entries.map((entry) => entry.event.type)).toEqual(["block_start", "task_status"]);
    late.unsubscribe(); // 空退订（终态订阅不注册监听）
    // 模拟任务循环结束（release）：无订阅者时清理缓冲/序号/订阅者状态。
    bus.release(RUN);
    const afterCleanup = await collect(bus);
    expect(afterCleanup.entries).toEqual([
      { seq: 1, event: { type: "task_status", status: "succeeded", errorMessage: null } },
    ]);
    afterCleanup.unsubscribe();
  });

  it("tool 载荷超长截断（入缓冲前），小载荷与非工具事件透传", async () => {
    const bus = busWith([task()]);
    const huge = { rows: "x".repeat(MAX_TOOL_PAYLOAD_CHARS + 100) };
    bus.emit(RUN, { type: "tool_start", callId: "c1", name: "query_records", args: huge });
    bus.emit(RUN, {
      type: "tool_result",
      callId: "c1",
      name: "query_records",
      result: { rows: "x".repeat(100) },
      isError: false,
    });
    bus.emit(RUN, { type: "thinking_delta", text: "y".repeat(MAX_TOOL_PAYLOAD_CHARS + 100) });

    const { entries } = await collect(bus);
    const [toolStart, toolResult, thinking] = entries;
    expect(toolStart!.event).toMatchObject({ type: "tool_start", args: { truncated: true } });
    expect((toolStart!.event as { args: { prefix: string } }).args.prefix.length).toBe(
      MAX_TOOL_PAYLOAD_CHARS,
    );
    expect(toolResult!.event).toMatchObject({
      type: "tool_result",
      result: { rows: "x".repeat(100) },
    });
    expect((thinking!.event as { text: string }).text.length).toBe(MAX_TOOL_PAYLOAD_CHARS + 100);
  });
});
