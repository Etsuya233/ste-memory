import type { FillTask, MessageFillState } from "../ports/fill-task.ts";
import type { SourceMessageStatus } from "../ports/source-chat.ts";

/**
 * 覆盖视图分类（ticket 17）：全部消息按四态分类（错误 > 已跑过 > 活动任务范围内待跑 > 没计划）。
 * 分类依赖活动任务范围（服务端事实），因此必须在应用层派生，不能只透传消息状态。
 */
export function classifyMessages(
  statuses: readonly SourceMessageStatus[],
  active: FillTask | undefined,
): readonly { readonly sourceId: number; readonly state: MessageFillState }[] {
  return statuses.map(({ sourceId, status }) => ({
    sourceId,
    state: classifyMessageState(status, active, sourceId),
  }));
}

/**
 * 逐消息四态分类：error > processed > 活动任务范围内 untracked（in_task）> unplanned。
 * 活动任务范围内上次失败留下的 error 消息在重跑前仍显示错误（重跑成功变 processed）。
 */
function classifyMessageState(
  status: SourceMessageStatus["status"],
  active: FillTask | undefined,
  sourceId: number,
): MessageFillState {
  if (status === "error") return "error";
  if (status === "processed") return "processed";
  if (active !== undefined && sourceId >= active.from && sourceId <= active.to) return "in_task";
  return "unplanned";
}
