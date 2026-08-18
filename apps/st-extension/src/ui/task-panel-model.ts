/**
 * 任务 Tab（ticket 13 触发 UI + ticket 14 任务面板）的纯逻辑 seam：楼层输入校验、
 * 未处理范围提示、任务状态文案、逐消息覆盖视图、任务历史列表、Tab 视图模型。
 * 组件只做「模型 → DOM」投影与事件接线，本模块独立测试。
 *
 * 数据来源语义：
 * - 楼层 = ST 消息数组下标（0 基，ADR 0003）；范围上限 = chatLength - 1；
 * - 未处理范围从楼层进度台账计算（untracked = 无台账行，与 api 同语义），
 *   覆盖视图（ticket 14）同样从台账计算；
 * - 空输入 = 全量范围（从 0 到 chatLength-1）。
 */
import type { FillTaskStatus, FillTaskView, FloorLedgerEntry } from "../fill-tasks/fill-task.ts";
import { isFillTaskTerminal } from "../fill-tasks/fill-task.ts";
import { formatSyncTime } from "./space-info.ts";
import type { CleaningRuleList } from "../settings/cleaning-rule-lists.ts";

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
  /** 是否允许触发初始化填表（仅要求无活动任务；不依赖对话消息数） */
  readonly canTriggerInit: boolean;
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
  /** 逐消息覆盖视图（ticket 14）：已处理/任务中/出错/未计划 */
  readonly coverage: CoverageViewModel;
  /** 任务历史（终态任务 createdAt 倒序）：状态/范围/时间/错误，失败与中断可重试 */
  readonly history: readonly TaskHistoryItemViewModel[];
  /** 当前对话清洗配置提示（ticket 22）：如「清洗：我的清洗」/「未启用清洗」 */
  readonly cleaningHint: string;
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

/** 任务状态 → 文案：running 带进度；failed 带可读失败原因；succeeded/interrupted 终态短语。
 *  初始化任务（kind=init）无楼层：running 显示初始化文案，不显示楼层进度。 */
export function taskStatusViewModel(task: FillTaskView): TaskStatusViewModel {
  switch (task.status) {
    case "running":
      return task.kind === "init"
        ? { label: "运行中", detail: "正在初始化…" }
        : { label: "运行中", detail: `已处理 ${task.processedCount}/${task.totalCount} 层` };
    case "succeeded":
      return { label: "已完成", detail: "" };
    case "failed":
      return { label: "失败", detail: task.errorMessage ?? "" };
    case "interrupted":
      return { label: "已中断", detail: "" };
  }
}

/** 任务类型短标签（历史条目与活动任务区展示：初始化 / 填表）。 */
export function taskKindLabel(kind: FillTaskView["kind"]): string {
  return kind === "init" ? "初始化" : "填表";
}

/** 任务范围展示：init 任务无楼层，显示「初始化填表」；楼层任务显示楼层闭区间。 */
export function taskRangeText(task: FillTaskView): string {
  return task.kind === "init" ? "初始化填表" : `楼层 ${task.from}–${task.to}`;
}

/** 历史条目进度文本：init 任务无楼层，显示「初始化」；楼层任务显示已处理进度。 */
export function taskProgressText(task: FillTaskView): string {
  return task.kind === "init" ? "初始化" : `已处理 ${task.processedCount}/${task.totalCount} 层`;
}

// ---- 覆盖视图（ticket 14）：逐消息类别 = 台账（processed/error）+ 活动任务范围（任务中）----

/** 逐消息覆盖类别：已处理 / 任务中 / 出错 / 未计划。 */
export type CoverageStatus = "processed" | "running" | "error" | "untracked";

/** 覆盖类别短标签（图例与计数展示）。 */
export const COVERAGE_STATUS_LABELS: Record<CoverageStatus, string> = {
  processed: "已处理",
  running: "任务中",
  error: "出错",
  untracked: "未计划",
};

/** 连续同类别楼层区间（闭区间；覆盖视图的渲染单元，避免逐楼 DOM 元素）。 */
export interface CoverageRun {
  readonly status: CoverageStatus;
  readonly from: number;
  readonly to: number;
}

export interface CoverageViewModel {
  /** 连续同类别区间（floor 升序、无空洞，覆盖 0..chatLength-1） */
  readonly runs: readonly CoverageRun[];
  readonly processedCount: number;
  readonly runningCount: number;
  readonly errorCount: number;
  readonly untrackedCount: number;
  /** 覆盖总楼层数（= chatLength，全部 live 楼层） */
  readonly totalCount: number;
}

/**
 * 覆盖视图：从楼层进度台账 + 活动任务范围计算逐消息类别——processed/error 以台账为准
 * （出错可重试、已提交保留，类别不受活动任务影响）；台账无行（untracked）且在活动任务
 * 范围内 = 任务中（该任务计划处理但尚未完成）；其余 = 未计划。台账的陈旧楼层（超出
 * 当前对话长度）不参与（覆盖视图按 live 楼层渲染，session-record §2 遗留容忍）。
 */
export function buildCoverageViewModel(input: {
  readonly ledger: readonly FloorLedgerEntry[];
  /** 活动任务楼层范围（无活动任务为 undefined → 无「任务中」类别） */
  readonly activeRange: { readonly from: number; readonly to: number } | undefined;
  readonly chatLength: number;
}): CoverageViewModel {
  const byFloor = new Map(input.ledger.map((entry) => [entry.floor, entry.status]));
  const counts: Record<CoverageStatus, number> = {
    processed: 0,
    running: 0,
    error: 0,
    untracked: 0,
  };
  const runs: CoverageRun[] = [];
  for (let floor = 0; floor < input.chatLength; floor += 1) {
    const ledgerStatus = byFloor.get(floor);
    const status: CoverageStatus =
      ledgerStatus === "processed" || ledgerStatus === "error"
        ? ledgerStatus
        : input.activeRange !== undefined &&
            floor >= input.activeRange.from &&
            floor <= input.activeRange.to
          ? "running"
          : "untracked";
    counts[status] += 1;
    const last = runs[runs.length - 1];
    if (last !== undefined && last.status === status) {
      runs[runs.length - 1] = { ...last, to: floor };
    } else {
      runs.push({ status, from: floor, to: floor });
    }
  }
  return {
    runs,
    processedCount: counts.processed,
    runningCount: counts.running,
    errorCount: counts.error,
    untrackedCount: counts.untracked,
    totalCount: input.chatLength,
  };
}

// ---- 任务历史（ticket 14）：终态任务列表条目 ----

/** 历史任务条目：状态/类型/楼层范围/时间/进度/错误信息；失败与中断可重试。 */
export interface TaskHistoryItemViewModel {
  readonly runId: string;
  /** 终态（历史列表只列终态任务；运行中任务在活动任务区展示） */
  readonly status: FillTaskStatus;
  readonly statusLabel: string;
  /** 任务类型标签（初始化 / 填表） */
  readonly kindLabel: string;
  readonly rangeText: string;
  /** 任务创建时间（ISO → "YYYY-MM-DD HH:mm"，与设置面板同步时间同格式） */
  readonly timeText: string;
  readonly progressText: string;
  /** 失败原因（可读中文；非 failed 为 null） */
  readonly errorMessage: string | null;
  /** 失败/中断可重试（按原楼层范围重新提交为新任务） */
  readonly retryable: boolean;
}

function toHistoryItem(task: FillTaskView): TaskHistoryItemViewModel {
  const status = taskStatusViewModel(task);
  return {
    runId: task.runId,
    status: task.status,
    statusLabel: status.label,
    kindLabel: taskKindLabel(task.kind),
    rangeText: taskRangeText(task),
    // 时间展示复用 formatSyncTime（ISO → "YYYY-MM-DD HH:mm"，与设置面板同步时间同格式）
    timeText: formatSyncTime(task.createdAt),
    progressText: taskProgressText(task),
    errorMessage: task.errorMessage,
    retryable: task.status === "failed" || task.status === "interrupted",
  };
}

/** 任务 Tab 视图模型：触发区 + 活动任务区 + 覆盖视图 + 任务历史。 */
export function buildTasksTabViewModel(input: {
  readonly chatLength: number;
  readonly ledger: readonly FloorLedgerEntry[];
  readonly activeTask: FillTaskView | undefined;
  /** 最近任务列表（createdAt 倒序；运行中任务被过滤，活动任务区展示） */
  readonly historyTasks: readonly FillTaskView[];
  /** 当前对话清洗配置（ticket 22 / ADR 0011）：所选列表 id + 全部列表 */
  readonly cleaning: {
    readonly selectedListId: string | undefined;
    readonly lists: readonly CleaningRuleList[];
  };
}): TasksTabViewModel {
  const ranges = unprocessedRanges(input.ledger, input.chatLength);
  const first = ranges[0];
  const unprocessedCount = ranges.reduce((sum, range) => sum + (range.to - range.from + 1), 0);
  const active = input.activeTask;
  const coverage = buildCoverageViewModel({
    ledger: input.ledger,
    activeRange: active ? { from: active.from, to: active.to } : undefined,
    chatLength: input.chatLength,
  });
  const history = input.historyTasks
    .filter((task) => isFillTaskTerminal(task.status))
    .map(toHistoryItem);
  return {
    chatLength: input.chatLength,
    canTrigger: !active && input.chatLength > 0,
    // 初始化填表不依赖对话消息数（新对话 0 消息也可初始化）；活动任务占用时禁用
    canTriggerInit: !active,
    noMessages: input.chatLength <= 0,
    hasActiveTask: active !== undefined,
    activeTaskRunId: active?.runId ?? null,
    activeTaskLabel: active ? taskStatusViewModel(active).label : "",
    activeTaskDetail: active ? taskStatusViewModel(active).detail : "",
    activeRange: active ? taskRangeText(active) : "",
    unprocessedHint:
      ranges.length === 0
        ? null
        : `未处理楼层 ${first!.from}–${first!.to} · 共 ${unprocessedCount} 层`,
    defaultFrom: first ? String(first.from) : "",
    defaultTo: first ? String(first.to) : "",
    coverage,
    history,
    cleaningHint: resolveCleaningHint(input.cleaning.lists, input.cleaning.selectedListId),
  };
}

/** 当前对话清洗配置提示：未选择 / 列表已删除（悬空）/ 生效中。 */
function resolveCleaningHint(
  lists: readonly CleaningRuleList[],
  selectedListId: string | undefined,
): string {
  if (selectedListId === undefined) return "未启用清洗";
  const list = lists.find((candidate) => candidate.id === selectedListId);
  if (!list) return "所选清洗规则列表不存在，未清洗";
  return `清洗：${list.name}`;
}
