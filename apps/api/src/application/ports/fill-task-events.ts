import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { AgentRunEvent } from "../agent-events.ts";
import { isFillTaskTerminal } from "./fill-task.ts";

/** 总线内的事件条目：seq 单调递增，是重放/续传与客户端去重的依据。 */
export interface AgentRunEventEntry {
  readonly seq: number;
  readonly event: AgentRunEvent;
}

/** 填表终态事件（task_status 且 status 为终态）：事件流关闭判据（总线与 SSE 路由共用）。 */
export function isTerminalFillTaskStatus(event: AgentRunEvent): boolean {
  return event.type === "task_status" && isFillTaskTerminal(event.status);
}

/**
 * 填表任务事件流端口（ticket 16）：订阅 per-run 事件流。
 *
 * 语义（与聊天 11.5 的关键差异）：
 * - 事件流是旁观者，不是 run 的所有者——客户端断开只退订，绝不中止任务；
 * - 任务先于订阅者存在：订阅先同步回放缓冲（afterSeq 之后的事件，缺省 = 全部缓冲），再实时转发；
 * - 任务已终态时回放后立即返回空退订函数（不注册实时监听，服务端会补终态事件并关闭流）；
 * - 返回 undefined 表示 runId 不存在或不属于该记忆空间（HTTP 层映射 404）。
 */
export interface FillTaskEventBus {
  subscribe(
    spaceId: MemorySpaceId,
    runId: string,
    afterSeq: number | undefined,
    onEvent: (entry: AgentRunEventEntry) => void,
  ): Promise<(() => void) | undefined>;
}
