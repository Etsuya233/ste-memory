/**
 * 填表任务事件流状态纯函数测试（ticket 16）：
 * 追加去重/排序/修剪、最新状态、时间线聚合（思考合并、工具配对、块/状态标记）。
 */
import { describe, expect, it } from "vitest";
import type { FillTaskRunEventEntry } from "./api/fill-tasks.ts";
import {
  appendFillTaskEvents,
  buildFillTaskTimeline,
  createFillTaskLog,
  FILL_TASK_LOG_LIMIT,
  latestTaskStatus,
  type FillTaskLogState,
} from "./fill-task-events-state.ts";

function entry(seq: number, event: FillTaskRunEventEntry["event"]): FillTaskRunEventEntry {
  return { seq, event };
}

function blockStart(from = 1, to = 4): FillTaskRunEventEntry["event"] {
  return { type: "block_start", from, to };
}

function blockDone(
  from = 1,
  to = 4,
  emptyProposal = false,
  changedRecords = 1,
): FillTaskRunEventEntry["event"] {
  return { type: "block_done", from, to, emptyProposal, changedRecords };
}

function toolStart(callId: string, name = "query_records"): FillTaskRunEventEntry["event"] {
  return { type: "tool_start", callId, name, args: { table: "characters" } };
}

function toolResult(
  callId: string,
  name = "query_records",
  isError = false,
): FillTaskRunEventEntry["event"] {
  return { type: "tool_result", callId, name, result: { total: 2 }, isError };
}

function status(status: "succeeded" | "failed"): FillTaskRunEventEntry["event"] {
  return { type: "task_status", status, errorMessage: null };
}

describe("appendFillTaskEvents", () => {
  it("按 seq 追加并保持有序", () => {
    const state = appendFillTaskEvents(createFillTaskLog(), [entry(1, blockStart())]);
    const next = appendFillTaskEvents(state, [entry(2, blockDone())]);
    expect(next.entries.map((item) => item.seq)).toEqual([1, 2]);
  });

  it("重复 seq 去重（断线重连回放与已见事件重叠时）", () => {
    const state = appendFillTaskEvents(createFillTaskLog(), [
      entry(1, blockStart()),
      entry(2, blockDone()),
    ]);
    const next = appendFillTaskEvents(state, [
      entry(2, blockDone()),
      entry(3, status("succeeded")),
    ]);
    expect(next.entries.map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it("乱序输入按 seq 排序（重连回放与实时竞争时）", () => {
    const state = appendFillTaskEvents(createFillTaskLog(), [entry(3, blockDone())]);
    const next = appendFillTaskEvents(state, [entry(1, blockStart()), entry(2, toolStart("c1"))]);
    expect(next.entries.map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it("超过上限时修剪最旧", () => {
    let state: FillTaskLogState = createFillTaskLog();
    const overflow = FILL_TASK_LOG_LIMIT + 5;
    for (let seq = 1; seq <= overflow; seq += 1) {
      state = appendFillTaskEvents(state, [entry(seq, { type: "thinking_delta", text: "t" })]);
    }
    expect(state.entries.length).toBe(FILL_TASK_LOG_LIMIT);
    expect(state.entries[0]!.seq).toBe(6);
    expect(state.entries.at(-1)!.seq).toBe(overflow);
  });

  it("空输入与全部重复时不产生新状态引用", () => {
    const state = appendFillTaskEvents(createFillTaskLog(), [entry(1, blockStart())]);
    expect(appendFillTaskEvents(state, [])).toBe(state);
    expect(appendFillTaskEvents(state, [entry(1, blockStart())])).toBe(state);
  });
});

describe("latestTaskStatus", () => {
  it("返回最后一条 task_status；无则 undefined", () => {
    expect(latestTaskStatus(createFillTaskLog())).toBeUndefined();
    const state = appendFillTaskEvents(createFillTaskLog(), [
      entry(1, status("succeeded")),
      entry(2, { type: "thinking_delta", text: "t" }),
    ]);
    expect(latestTaskStatus(state)).toEqual({ status: "succeeded", errorMessage: null });
  });
});

describe("buildFillTaskTimeline", () => {
  it("连续 thinking_delta 合并为一条，块标记分隔", () => {
    const timeline = buildFillTaskTimeline([
      entry(1, { type: "thinking_delta", text: "查" }),
      entry(2, { type: "thinking_delta", text: "表" }),
      entry(3, blockStart()),
      entry(4, { type: "thinking_delta", text: "再查" }),
    ]);
    expect(timeline).toEqual([
      { kind: "thinking", text: "查表" },
      { kind: "block_start", from: 1, to: 4 },
      { kind: "thinking", text: "再查" },
    ]);
  });

  it("tool_start 开卡，同 callId 的 tool_result 回填（含错误标记）", () => {
    const timeline = buildFillTaskTimeline([
      entry(1, toolStart("c1")),
      entry(2, toolStart("c2")),
      entry(3, toolResult("c1")),
      entry(4, toolResult("c2", "query_records", true)),
    ]);
    expect(timeline).toEqual([
      {
        kind: "tool",
        callId: "c1",
        name: "query_records",
        args: { table: "characters" },
        result: { total: 2 },
        isError: false,
      },
      {
        kind: "tool",
        callId: "c2",
        name: "query_records",
        args: { table: "characters" },
        result: { total: 2 },
        isError: true,
      },
    ]);
  });

  it("结果先于 start 到达（回放截断边界）时按结果建卡，args 未知", () => {
    const timeline = buildFillTaskTimeline([entry(1, toolResult("c9"))]);
    expect(timeline).toEqual([
      {
        kind: "tool",
        callId: "c9",
        name: "query_records",
        args: undefined,
        result: { total: 2 },
        isError: false,
      },
    ]);
  });

  it("块与状态标记原样保留，message_delta 不入日志", () => {
    const timeline = buildFillTaskTimeline([
      entry(1, blockStart(1, 2)),
      entry(2, blockDone(1, 2, false, 1)),
      entry(3, blockStart(3, 4)),
      entry(4, blockDone(3, 4, true, 0)),
      entry(5, status("succeeded")),
      entry(6, { type: "message_delta", text: "总结" }),
    ]);
    expect(timeline).toEqual([
      { kind: "block_start", from: 1, to: 2 },
      { kind: "block_done", from: 1, to: 2, emptyProposal: false, changedRecords: 1 },
      { kind: "block_start", from: 3, to: 4 },
      { kind: "block_done", from: 3, to: 4, emptyProposal: true, changedRecords: 0 },
      { kind: "status", status: "succeeded", errorMessage: null },
    ]);
  });
});
