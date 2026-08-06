import type { FillTaskStatus } from "./api/fill-tasks.ts";

/** 填表任务控制动作（与服务端控制端点一一对应）。 */
export type FillTaskControlAction = "pause" | "resume" | "cancel";

/**
 * 给定任务状态与进行中的请求，计算当前可用的控制动作：
 * - 进行中的请求（pendingAction）未返回前不允许任何新请求（避免重复提交）；
 * - 请求中状态（pause_requested / cancel_requested）本身不可重复请求；
 * - 终态任务没有控制动作（轮询会在终态后收到 null，面板回到表单）。
 */
export function availableFillTaskControls(
  status: FillTaskStatus,
  pendingAction: FillTaskControlAction | null,
): FillTaskControlAction[] {
  if (pendingAction !== null) return [];
  switch (status) {
    case "running":
      return ["pause", "cancel"];
    case "paused":
      return ["resume", "cancel"];
    case "pause_requested":
    case "queued":
      return ["cancel"];
    case "cancel_requested":
    case "cancelled":
    case "succeeded":
    case "failed":
    case "interrupted":
      return [];
  }
}
