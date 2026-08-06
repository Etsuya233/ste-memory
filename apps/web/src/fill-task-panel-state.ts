import type { FillTaskStatus } from "./api/fill-tasks.ts";
import type { BadgeTone } from "./ui.tsx";

/** 填表任务控制动作（与服务端控制端点一一对应）。 */
export type FillTaskControlAction = "pause" | "resume" | "cancel";

/** 状态展示元数据：文案 / 徽标色调 / 是否转圈（任务仍在推进）。 */
export const STATUS_META: Record<
  FillTaskStatus,
  { readonly label: string; readonly tone: BadgeTone; readonly busy: boolean }
> = {
  queued: { label: "排队中", tone: "accent", busy: true },
  running: { label: "运行中", tone: "accent", busy: true },
  pause_requested: { label: "暂停请求中", tone: "accent", busy: true },
  paused: { label: "已暂停", tone: "neutral", busy: false },
  cancel_requested: { label: "正在中止", tone: "accent", busy: true },
  cancelled: { label: "已中止", tone: "warn", busy: false },
  succeeded: { label: "已完成", tone: "accent", busy: false },
  failed: { label: "失败", tone: "danger", busy: false },
  interrupted: { label: "已中断", tone: "warn", busy: false },
};

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
