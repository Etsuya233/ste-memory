/**
 * 填表任务实时日志的纯状态变换（ticket 16）：事件流追加（按 seq 去重/排序/修剪）
 * 与时间线聚合（思考合并、工具配对、块/状态标记）。与 React 无关，便于单测。
 */
import type { FillTaskRunEvent, FillTaskRunEventEntry, FillTaskStatus } from "./api/fill-tasks.ts";

export interface FillTaskLogState {
  readonly entries: readonly FillTaskRunEventEntry[];
}

/** 页面内保留的事件上限（与服务端缓冲一致，超出丢弃最旧）。 */
export const FILL_TASK_LOG_LIMIT = 1000;

export function createFillTaskLog(): FillTaskLogState {
  return { entries: [] };
}

/**
 * 追加事件条目：按 seq 去重（断线重连可能收到已见事件）、排序（乱序兜底）、
 * 超出上限时修剪最旧。返回新状态（不可变）。
 */
export function appendFillTaskEvents(
  state: FillTaskLogState,
  incoming: readonly FillTaskRunEventEntry[],
): FillTaskLogState {
  if (incoming.length === 0) return state;
  const seen = new Set(state.entries.map((entry) => entry.seq));
  const merged = [...state.entries];
  for (const entry of incoming) {
    if (seen.has(entry.seq)) continue;
    seen.add(entry.seq);
    merged.push(entry);
  }
  if (merged.length === state.entries.length) return state;
  merged.sort((a, b) => a.seq - b.seq);
  if (merged.length > FILL_TASK_LOG_LIMIT) merged.splice(0, merged.length - FILL_TASK_LOG_LIMIT);
  return { entries: merged };
}

/** 最后一条 task_status 事件（无则 undefined；终态判断与横幅状态来源）。 */
export function latestTaskStatus(
  state: FillTaskLogState,
): { readonly status: FillTaskStatus; readonly errorMessage: string | null } | undefined {
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const event = state.entries[index]!.event;
    if (event.type === "task_status") {
      return { status: event.status, errorMessage: event.errorMessage };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 时间线聚合
// ---------------------------------------------------------------------------

export type FillTaskTimelineItem =
  | { readonly kind: "thinking"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly callId: string;
      readonly name: string;
      readonly args: unknown;
      readonly result?: unknown;
      readonly isError: boolean;
    }
  | { readonly kind: "block_start"; readonly from: number; readonly to: number }
  | {
      readonly kind: "block_done";
      readonly from: number;
      readonly to: number;
      readonly emptyProposal: boolean;
      readonly changedRecords: number;
    }
  | {
      readonly kind: "status";
      readonly status: FillTaskStatus;
      readonly errorMessage: string | null;
    };

/**
 * 把事件序列聚合为渲染时间线：
 * - 连续的 thinking_delta 合并为一条（块标记自然分隔各块的思考）；
 * - tool_start 开启工具卡片，同 callId 的 tool_result 回填结果（错误高亮）；
 *   结果先于 start 到达（回放截断边界）时按结果建卡，args 未知；
 * - block_start / block_done / task_status 原样转为标记。
 */
export function buildFillTaskTimeline(
  entries: readonly FillTaskRunEventEntry[],
): FillTaskTimelineItem[] {
  const items: FillTaskTimelineItem[] = [];
  for (const entry of entries) {
    appendTimelineItem(items, entry.event);
  }
  return items;
}

function appendTimelineItem(items: FillTaskTimelineItem[], event: FillTaskRunEvent): void {
  switch (event.type) {
    case "thinking_delta": {
      const last = items.at(-1);
      if (last?.kind === "thinking") {
        items[items.length - 1] = { ...last, text: last.text + event.text };
      } else {
        items.push({ kind: "thinking", text: event.text });
      }
      return;
    }
    case "tool_start":
      items.push({
        kind: "tool",
        callId: event.callId,
        name: event.name,
        args: event.args,
        isError: false,
      });
      return;
    case "tool_result": {
      const index = items.findLastIndex(
        (item) => item.kind === "tool" && item.callId === event.callId && item.result === undefined,
      );
      if (index >= 0) {
        const current = items[index]!;
        items[index] = {
          ...current,
          result: event.result,
          isError: event.isError,
        } as FillTaskTimelineItem;
      } else {
        // 回放从工具中途开始：只有结果没有参数，按结果建卡。
        items.push({
          kind: "tool",
          callId: event.callId,
          name: event.name,
          args: undefined,
          result: event.result,
          isError: event.isError,
        });
      }
      return;
    }
    case "block_start":
      items.push({ kind: "block_start", from: event.from, to: event.to });
      return;
    case "block_done":
      items.push({
        kind: "block_done",
        from: event.from,
        to: event.to,
        emptyProposal: event.emptyProposal,
        changedRecords: event.changedRecords,
      });
      return;
    case "task_status":
      items.push({ kind: "status", status: event.status, errorMessage: event.errorMessage });
      return;
    case "message_delta":
      return; // 填表循环以提案输出为主，回答增量不入日志
  }
}
