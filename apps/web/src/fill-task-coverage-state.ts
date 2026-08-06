import type { MessageFillState } from "./api/fill-tasks.ts";

/** 覆盖计数（ticket 17）：四态各自数量，总和恒等于消息总数。 */
export interface CoverageCounts {
  readonly processed: number;
  readonly in_task: number;
  readonly error: number;
  readonly unplanned: number;
  readonly total: number;
}

export const COVERAGE_COLUMNS = 50;

/** 图例与计数展示顺序（矩阵 hover 提示也按此渲染状态名）。 */
export const COVERAGE_STATE_ORDER: readonly MessageFillState[] = [
  "processed",
  "in_task",
  "error",
  "unplanned",
];

/** 状态中文名（图例 / hover 提示共用）。 */
export const COVERAGE_STATE_LABELS: Record<MessageFillState, string> = {
  processed: "已跑过",
  in_task: "任务中待跑",
  error: "错误",
  unplanned: "没计划",
};

/** 从覆盖 states 推导四态计数（单一事实源，服务端不重复下发计数）。 */
export function summarizeCoverage(
  states: readonly { readonly sourceId: number; readonly state: MessageFillState }[],
): CoverageCounts {
  let processed = 0;
  let inTask = 0;
  let error = 0;
  let unplanned = 0;
  for (const { state } of states) {
    switch (state) {
      case "processed":
        processed += 1;
        break;
      case "in_task":
        inTask += 1;
        break;
      case "error":
        error += 1;
        break;
      case "unplanned":
        unplanned += 1;
        break;
    }
  }
  return { processed, in_task: inTask, error, unplanned, total: states.length };
}
