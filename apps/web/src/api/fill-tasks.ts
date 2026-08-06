import { API_URL, responseJson } from "./http.ts";

/** 与服务端 FillTask 状态一一对应（ticket 14 完整生命周期）。 */
export type FillTaskStatus =
  | "queued"
  | "running"
  | "pause_requested"
  | "paused"
  | "cancel_requested"
  | "cancelled"
  | "succeeded"
  | "failed"
  | "interrupted";

/** 与服务端 FillTaskView 一一对应（ticket 14：带实时进度）。 */
export interface FillTask {
  readonly runId: string;
  readonly memorySpaceId: string;
  readonly from: number;
  readonly to: number;
  readonly blockSize: number;
  readonly status: FillTaskStatus;
  readonly processedCount: number;
  readonly totalCount: number;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SubmitFillTaskInput {
  readonly from: number;
  readonly to: number;
  readonly blockSize?: number;
  readonly config?: { readonly baseUrl: string; readonly model: string; readonly apiKey: string };
}

/** 提交后台填表任务；返回 202 任务视图（409 冲突/400 参数或配置错误由 responseJson 抛出）。 */
export async function submitFillTask(
  spaceId: string,
  input: SubmitFillTaskInput,
): Promise<FillTask> {
  return responseJson(
    await fetch(`${API_URL}/memory-spaces/${spaceId}/fill-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

/** 当前非终态任务视图（无则 null）。 */
export async function fetchActiveFillTask(spaceId: string): Promise<FillTask | null> {
  return (
    await responseJson<{ task: FillTask | null }>(
      await fetch(`${API_URL}/memory-spaces/${spaceId}/fill-tasks/active`),
    )
  ).task;
}

/** 暂停：服务端先记请求状态（pause_requested），任务循环在安全点应用为 paused。 */
export async function pauseFillTask(spaceId: string, runId: string): Promise<FillTask> {
  return fillTaskControl(spaceId, runId, "pause");
}

/** 恢复：paused → running（任务从下一块继续，不重跑已成功批次）。 */
export async function resumeFillTask(spaceId: string, runId: string): Promise<FillTask> {
  return fillTaskControl(spaceId, runId, "resume");
}

/** 中止：请求状态先落库（cancel_requested），任务循环在安全点丢弃未提交提案。 */
export async function cancelFillTask(spaceId: string, runId: string): Promise<FillTask> {
  return fillTaskControl(spaceId, runId, "cancel");
}

async function fillTaskControl(
  spaceId: string,
  runId: string,
  action: "pause" | "resume" | "cancel",
): Promise<FillTask> {
  return responseJson(
    await fetch(`${API_URL}/memory-spaces/${spaceId}/fill-tasks/${runId}/${action}`, {
      method: "POST",
    }),
  );
}
