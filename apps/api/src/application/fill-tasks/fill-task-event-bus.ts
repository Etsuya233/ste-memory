/**
 * InMemoryFillTaskEventBus：填表任务事件总线（ticket 16）的内存实现。
 *
 * 按 runId 维护有界环形缓冲（最近 FILL_TASK_EVENT_BUFFER_LIMIT 条）与订阅者集合：
 * - 任务先于订阅者存在：订阅先回放缓冲，再实时转发（同一事件不会既回放又实时送达）；
 * - 断线重连：subscribe(afterSeq) 只回放 seq 更大的事件；afterSeq 太旧（超出缓冲）时回放全部缓冲；
 * - 终态：订阅时任务已终态 → 回放缓冲（若其中已有终态 task_status 则无需补发，
 *   否则按任务行补发一条）后不注册实时监听；
 * - 清理：任务循环结束时 release() 在无订阅者时删除状态；退订时若任务已终态且无订阅者也清理；
 * - 背压：emit 同步扇出且不抛错（订阅者写失败由调用方 try/catch 消化），任务循环不被拖慢。
 */
import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { AgentRunEvent } from "../agent-events.ts";
import { isFillTaskTerminal, type FillTask } from "../ports/fill-task.ts";
import {
  isTerminalFillTaskStatus,
  type AgentRunEventEntry,
  type FillTaskEventBus,
} from "../ports/fill-task-events.ts";

/** 每 run 缓冲上限（最近 N 条；用户确认）。 */
export const FILL_TASK_EVENT_BUFFER_LIMIT = 1000;

/** tool_start.args / tool_result.result 序列化超长时截断（入缓冲前执行，保证内存有界）。 */
export const MAX_TOOL_PAYLOAD_CHARS = 16_000;

type Listener = (entry: AgentRunEventEntry) => void;

export class InMemoryFillTaskEventBus implements FillTaskEventBus {
  readonly #findTask: (runId: string) => Promise<FillTask | undefined>;
  readonly #buffers = new Map<string, AgentRunEventEntry[]>();
  readonly #nextSeq = new Map<string, number>();
  readonly #subscribers = new Map<string, Set<Listener>>();

  constructor(findTask: (runId: string) => Promise<FillTask | undefined>) {
    this.#findTask = findTask;
  }

  /** 追加事件：入缓冲（无缓冲时创建，保证晚订阅可回放）+ 实时扇出。 */
  emit(runId: string, event: AgentRunEvent): void {
    const seq = (this.#nextSeq.get(runId) ?? 0) + 1;
    this.#nextSeq.set(runId, seq);
    const entry: AgentRunEventEntry = { seq, event: truncateToolPayload(event) };
    let buffer = this.#buffers.get(runId);
    if (buffer === undefined) {
      buffer = [];
      this.#buffers.set(runId, buffer);
    }
    buffer.push(entry);
    if (buffer.length > FILL_TASK_EVENT_BUFFER_LIMIT) buffer.shift();
    for (const listener of this.#subscribers.get(runId) ?? []) {
      try {
        listener(entry);
      } catch {
        // 订阅者（socket 写）失败不影响任务循环；写失败日志在 HTTP 层（streamSse 的 send）。
      }
    }
  }

  /**
   * 任务循环结束时调用：无订阅者时删除该 run 的全部状态（缓冲/序号/订阅者）。
   * 仍有订阅者时保留（其断开后由退订清理兜底，见 #cleanupIfIdle）。
   */
  release(runId: string): void {
    if ((this.#subscribers.get(runId)?.size ?? 0) === 0) {
      this.#drop(runId);
    }
  }

  async subscribe(
    spaceId: MemorySpaceId,
    runId: string,
    afterSeq: number | undefined,
    onEvent: (entry: AgentRunEventEntry) => void,
  ): Promise<(() => void) | undefined> {
    const task = await this.#findTask(runId);
    if (task === undefined || task.memorySpaceId !== spaceId) return undefined;

    const buffer = this.#buffers.get(runId) ?? [];
    const replay = afterSeq === undefined ? buffer : buffer.filter((entry) => entry.seq > afterSeq);
    for (const entry of replay) onEvent(entry);

    if (isFillTaskTerminal(task.status)) {
      // 终态：缓冲里已有终态 task_status（且未被 afterSeq 过滤掉）则回放已含；
      // 否则（缓冲被清理 / afterSeq 跳过）按任务行补发一条，客户端总能收到终态。
      if (!replay.some((entry) => isTerminalFillTaskStatus(entry.event))) {
        onEvent({
          seq: (this.#nextSeq.get(runId) ?? 0) + 1,
          event: { type: "task_status", status: task.status, errorMessage: task.errorMessage },
        });
      }
      return () => undefined;
    }

    let listeners = this.#subscribers.get(runId);
    if (listeners === undefined) {
      listeners = new Set();
      this.#subscribers.set(runId, listeners);
    }
    listeners.add(onEvent);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      listeners!.delete(onEvent);
      void this.#cleanupIfIdle(runId);
    };
  }

  async #cleanupIfIdle(runId: string): Promise<void> {
    if ((this.#subscribers.get(runId)?.size ?? 0) > 0) return;
    const task = await this.#findTask(runId);
    if (task === undefined || isFillTaskTerminal(task.status)) {
      this.#drop(runId);
    }
  }

  #drop(runId: string): void {
    this.#buffers.delete(runId);
    this.#nextSeq.delete(runId);
    this.#subscribers.delete(runId);
  }
}

/** 工具载荷超长截断（截断发生在入缓冲前；小载荷原样透传）。 */
function truncateToolPayload(event: AgentRunEvent): AgentRunEvent {
  if (event.type === "tool_start") return { ...event, args: truncateJson(event.args) };
  if (event.type === "tool_result") return { ...event, result: truncateJson(event.result) };
  return event;
}

function truncateJson(value: unknown): unknown {
  const json = JSON.stringify(value);
  if (json === undefined) return value;
  if (json.length <= MAX_TOOL_PAYLOAD_CHARS) return value;
  return { truncated: true, prefix: json.slice(0, MAX_TOOL_PAYLOAD_CHARS) };
}
