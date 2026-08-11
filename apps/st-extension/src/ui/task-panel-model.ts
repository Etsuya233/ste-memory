/**
 * 任务 Tab（ticket 13 触发 UI）的纯逻辑 seam：楼层输入校验、未处理范围提示、
 * 任务状态文案、Tab 视图模型。组件只做「模型 → DOM」投影与事件接线，本模块独立测试。
 *
 * 数据来源语义：
 * - 楼层 = ST 消息数组下标（0 基，ADR 0003）；范围上限 = chatLength - 1；
 * - 未处理范围从楼层进度台账计算（untracked = 无台账行，与 api 同语义），
 *   覆盖视图（ticket 14）同样从台账计算；
 * - 空输入 = 全量范围（从 0 到 chatLength-1）。
 */
import type { FillTaskView, FloorLedgerEntry } from "../fill-tasks/fill-task.ts";

export interface FloorRange {
  readonly from: number;
  readonly to: number;
}

export type FloorRangeValidation =
  | { readonly kind: "ok"; readonly from: number; readonly to: number }
  | { readonly kind: "error"; readonly message: string };

export interface TaskStatusViewModel {
  /** 状态短标签（运行中 / 已完成 / 失败 / 已中断） */
  readonly label: string;
  /** 细节（进度 / 失败原因；无细节为空串） */
  readonly detail: string;
}

export interface TasksTabViewModel {
  /** 当前对话消息数（触发校验的楼层上限） */
  readonly chatLength: number;
  /** 是否允许触发（插件启用 + 对话非空 + 无活动任务） */
  readonly canTrigger: boolean;
  /** 对话为空（无消息可填表） */
  readonly noMessages: boolean;
  /** 是否有运行中的任务（有则占用触发区） */
  readonly hasActiveTask: boolean;
  /** 活动任务 runId（取消操作目标；无活动任务为 null） */
  readonly activeTaskRunId: string | null;
  readonly activeTaskLabel: string;
  readonly activeTaskDetail: string;
  /** 活动任务楼层范围展示（如「楼层 2–7」） */
  readonly activeRange: string;
  /** 未处理范围提示（如「未处理楼层 1–4 · 共 6 层」；全部已处理/空对话为 null） */
  readonly unprocessedHint: string | null;
  /** 触发表单默认值（预填首个未处理范围；无未处理则空） */
  readonly defaultFrom: string;
  readonly defaultTo: string;
  /** 最近一次任务结果（终态；无则为 null）——失败原因可读 */
  readonly lastResult: TaskStatusViewModel | null;
}

/**
 * 未处理连续范围：闭区间 [from, to]（楼层 0 基）。untracked = 无台账行；
 * processed 与 error 楼层都视为已跑过（error 可重试——重跑同一范围时
 * 成功会把 error 覆盖为 processed）。
 */
export function unprocessedRanges(
  ledger: readonly FloorLedgerEntry[],
  chatLength: number,
): readonly FloorRange[] {
  if (chatLength <= 0) return [];
  const covered = new Set(ledger.map((entry) => entry.floor));
  const ranges: FloorRange[] = [];
  let rangeStart: number | undefined;
  for (let floor = 0; floor < chatLength; floor += 1) {
    if (!covered.has(floor)) {
      if (rangeStart === undefined) rangeStart = floor;
      continue;
    }
    if (rangeStart !== undefined) {
      ranges.push({ from: rangeStart, to: floor - 1 });
      rangeStart = undefined;
    }
  }
  if (rangeStart !== undefined) ranges.push({ from: rangeStart, to: chatLength - 1 });
  return ranges;
}

/**
 * 楼层输入校验（同步楼层 0 基，闭区间）：空输入 = 全量范围；
 * 非整数/负值/from > to/越界 → 可读错误信息。
 */
export function validateFloorRange(
  fromText: string,
  toText: string,
  chatLength: number,
): FloorRangeValidation {
  if (chatLength <= 0) {
    return { kind: "error", message: "当前对话没有消息，无法触发填表" };
  }
  const last = chatLength - 1;
  // 空串 = 边界默认（起点 0 / 终点 last）；非空非整数 = 非法输入
  const parse = (text: string): number | null | undefined => {
    const trimmed = text.trim();
    if (trimmed === "") return null;
    const value = Number(trimmed);
    return Number.isInteger(value) ? value : undefined;
  };
  const fromRaw = parse(fromText);
  const toRaw = parse(toText);
  if (fromRaw === undefined || toRaw === undefined) {
    return { kind: "error", message: "楼层请输入整数（同步楼层从 0 开始）" };
  }
  const from = fromRaw ?? 0;
  const to = toRaw ?? last;
  if (from < 0 || to < 0) {
    return { kind: "error", message: "楼层不能为负数（同步楼层从 0 开始）" };
  }
  if (from > to) {
    return { kind: "error", message: "起始楼层不能大于结束楼层" };
  }
  if (to > last) {
    return {
      kind: "error",
      message: `结束楼层超出范围：当前对话共 ${chatLength} 条消息（楼层 0–${last}）`,
    };
  }
  return { kind: "ok", from, to };
}

/** 任务状态 → 文案：running 带进度；failed 带可读失败原因；succeeded/interrupted 终态短语。 */
export function taskStatusViewModel(task: FillTaskView): TaskStatusViewModel {
  switch (task.status) {
    case "running":
      return { label: "运行中", detail: `已处理 ${task.processedCount}/${task.totalCount} 层` };
    case "succeeded":
      return { label: "已完成", detail: "" };
    case "failed":
      return { label: "失败", detail: task.errorMessage ?? "" };
    case "interrupted":
      return { label: "已中断", detail: "" };
  }
}

/** 任务 Tab 视图模型：触发区 + 活动任务区 + 最近结果区。 */
export function buildTasksTabViewModel(input: {
  readonly chatLength: number;
  readonly ledger: readonly FloorLedgerEntry[];
  readonly activeTask: FillTaskView | undefined;
  readonly recentTask: FillTaskView | undefined;
}): TasksTabViewModel {
  const ranges = unprocessedRanges(input.ledger, input.chatLength);
  const first = ranges[0];
  const unprocessedCount = ranges.reduce((sum, range) => sum + (range.to - range.from + 1), 0);
  const active = input.activeTask;
  // 最近结果只展示终态任务：运行中的任务在活动任务区展示，不重复出现在结果区
  const recent =
    input.recentTask && input.recentTask.runId !== active?.runId ? input.recentTask : undefined;
  return {
    chatLength: input.chatLength,
    canTrigger: !active && input.chatLength > 0,
    noMessages: input.chatLength <= 0,
    hasActiveTask: active !== undefined,
    activeTaskRunId: active?.runId ?? null,
    activeTaskLabel: active ? taskStatusViewModel(active).label : "",
    activeTaskDetail: active ? taskStatusViewModel(active).detail : "",
    activeRange: active ? `楼层 ${active.from}–${active.to}` : "",
    unprocessedHint:
      ranges.length === 0
        ? null
        : `未处理楼层 ${first!.from}–${first!.to} · 共 ${unprocessedCount} 层`,
    defaultFrom: first ? String(first.from) : "",
    defaultTo: first ? String(first.to) : "",
    lastResult: recent ? taskStatusViewModel(recent) : null,
  };
}
