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

/** 终态：succeeded / failed / cancelled / interrupted。 */
export function isFillTaskTerminal(status: FillTaskStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

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

// ---------------------------------------------------------------------------
// 实时运行输出（ticket 16）：GET /memory-spaces/:spaceId/fill-tasks/:runId/events
// ---------------------------------------------------------------------------

/** 与服务端 AgentRunEvent 的填表子集一一对应（ticket 16）。 */
export type FillTaskRunEvent =
  | { readonly type: "thinking_delta"; readonly text: string }
  | { readonly type: "message_delta"; readonly text: string }
  | {
      readonly type: "tool_start";
      readonly callId: string;
      readonly name: string;
      readonly args: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly callId: string;
      readonly name: string;
      readonly result: unknown;
      readonly isError: boolean;
    }
  | { readonly type: "block_start"; readonly from: number; readonly to: number }
  | {
      readonly type: "block_done";
      readonly from: number;
      readonly to: number;
      readonly emptyProposal: boolean;
      readonly changedRecords: number;
    }
  | {
      readonly type: "task_status";
      readonly status: FillTaskStatus;
      readonly errorMessage: string | null;
    };

/** 事件流条目：seq 单调递增（服务端附加），断线重连与去重的依据。 */
export interface FillTaskRunEventEntry {
  readonly seq: number;
  readonly event: FillTaskRunEvent;
}

/**
 * 订阅填表任务事件流（SSE）：逐条回调 onEntry，断线时抛错由调用方决定重连。
 * - 非 2xx（任务不存在/不属于该空间）：抛 Error；
 * - 网络错误：包装为可读信息抛出；
 * - 取消：signal.abort() 后抛 AbortError（调用方按 signal.aborted 区分）。
 */
export async function subscribeFillTaskEvents(
  spaceId: string,
  runId: string,
  lastEventId: number | undefined,
  signal: AbortSignal,
  onEntry: (entry: FillTaskRunEventEntry) => void,
): Promise<void> {
  const headers: Record<string, string> = {};
  if (lastEventId !== undefined) headers["last-event-id"] = String(lastEventId);
  let response: Response;
  try {
    response = await fetch(`${API_URL}/memory-spaces/${spaceId}/fill-tasks/${runId}/events`, {
      headers,
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(
      `网络错误：无法连接 API 服务（${error instanceof Error ? error.message : String(error)}）`,
      { cause: error },
    );
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { message?: string } | undefined;
    throw new Error(body?.message ?? `HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("浏览器不支持流式读取响应");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).trimEnd();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice("data:".length).trim();
        if (data.length === 0) continue;
        try {
          onEntry(JSON.parse(data) as FillTaskRunEventEntry);
        } catch {
          throw new Error("服务端返回了无法解析的流数据");
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
