import { API_URL, responseJson } from "./http.ts";

/** 与服务端 FillTask 视图一一对应（ticket 13 的最小集合；轮询扩展归 14）。 */
export interface FillTask {
  readonly runId: string;
  readonly memorySpaceId: string;
  readonly from: number;
  readonly to: number;
  readonly blockSize: number;
  readonly status: "running" | "succeeded" | "failed";
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

/** 当前非终态任务（无则 null）。 */
export async function fetchActiveFillTask(spaceId: string): Promise<FillTask | null> {
  return (
    await responseJson<{ task: FillTask | null }>(
      await fetch(`${API_URL}/memory-spaces/${spaceId}/fill-tasks/active`),
    )
  ).task;
}
