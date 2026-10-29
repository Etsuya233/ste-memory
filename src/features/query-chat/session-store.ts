import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  ProposalState,
  type ProposalStateSnapshot,
} from "../agent/tools/proposal/proposal-state.ts";
import type { MemorySpaceId } from "../memory/index.ts";
import type { ProposalPreviewToolResult } from "../agent/index.ts";
import {
  applyQueryChatEvent,
  errorMessage,
  type QueryChatMessage,
  type QueryChatEvent,
} from "./query-chat-state.ts";

export interface AssistantContext {
  readonly chatKey: string;
  readonly spaceId: MemorySpaceId;
}
export interface AssistantSession extends AssistantContext {
  readonly id: string;
  readonly storageRevision: number;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly draft: string;
  readonly messages: readonly QueryChatMessage[];
  readonly transcript: readonly AgentMessage[];
  readonly proposal: ProposalStateSnapshot;
  readonly preview?: ProposalPreviewToolResult;
  readonly previewId?: string;
  readonly commitUncertain?: boolean;
  readonly status: "idle" | "running" | "committing" | "interrupted";
}
export class AssistantSessionBusyError extends Error {
  constructor() {
    super("会话正在其他标签页执行，请等待完成后重试");
    this.name = "AssistantSessionBusyError";
  }
}
export class AssistantSessionConflictError extends Error {
  constructor() {
    super("会话已在其他标签页更新，请刷新后继续；当前未保存内容仍保留在本页");
    this.name = "AssistantSessionConflictError";
  }
}
export interface AssistantSessionRepository {
  list(): Promise<AssistantSession[]>;
  find(id: string): Promise<AssistantSession | undefined>;
  put(session: AssistantSession, expectedRevision: number): Promise<void>;
  delete(id: string, expectedRevision: number): Promise<void>;
  withLock<T>(id: string, work: () => Promise<T>, wait?: boolean, signal?: AbortSignal): Promise<T>;
  subscribe(
    onRows: (rows: AssistantSession[]) => void,
    onError: (error: unknown) => void,
  ): () => void;
}

/** 测试使用的共享存储，模拟原子版本校验、会话锁及跨实例通知。 */
export class InMemoryAssistantSessions implements AssistantSessionRepository {
  readonly rows = new Map<string, AssistantSession>();
  readonly #locks = new Map<string, Promise<void>>();
  readonly #listeners = new Set<(rows: AssistantSession[]) => void>();
  async list() {
    return structuredClone([...this.rows.values()]);
  }
  async find(id: string) {
    return structuredClone(this.rows.get(id));
  }
  async put(session: AssistantSession, expectedRevision: number) {
    if ((this.rows.get(session.id)?.storageRevision ?? -1) !== expectedRevision)
      throw new AssistantSessionConflictError();
    this.rows.set(session.id, structuredClone(session));
    this.#notify();
  }
  async delete(id: string, expectedRevision: number) {
    if ((this.rows.get(id)?.storageRevision ?? -1) !== expectedRevision)
      throw new AssistantSessionConflictError();
    this.rows.delete(id);
    this.#notify();
  }
  async withLock<T>(
    id: string,
    work: () => Promise<T>,
    wait = false,
    signal?: AbortSignal,
  ): Promise<T> {
    while (this.#locks.has(id)) {
      if (!wait) throw new AssistantSessionBusyError();
      const held = this.#locks.get(id)!;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          reject(signal!.reason);
        };
        signal?.throwIfAborted();
        signal?.addEventListener("abort", abort, { once: true });
        void held.then(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        });
      });
    }
    signal?.throwIfAborted();
    let release!: () => void;
    this.#locks.set(
      id,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    try {
      return await work();
    } finally {
      this.#locks.delete(id);
      release();
    }
  }
  subscribe(onRows: (rows: AssistantSession[]) => void) {
    this.#listeners.add(onRows);
    return () => {
      this.#listeners.delete(onRows);
    };
  }
  #notify() {
    for (const listener of this.#listeners) listener(structuredClone([...this.rows.values()]));
  }
}

export class QueryChatStore {
  readonly #repository: AssistantSessionRepository;
  readonly #listeners = new Set<() => void>();
  readonly #runs = new Map<string, { pendingId: string }>();
  #sessions: readonly AssistantSession[] = [];
  #writes: Promise<void> = Promise.resolve();
  #error: string | null = null;
  #loaded = false;
  #pending = 0;
  readonly #unsaved = new Map<string, AssistantSession | null>();
  readonly #revisions = new Map<string, number>();
  readonly #owned = new Set<string>();
  readonly #executing = new Map<string, AbortController>();
  readonly #lifetime = new AbortController();
  readonly #recovering = new Set<string>();
  #unsubscribe: (() => void) | undefined;
  readonly ready: Promise<void>;

  constructor(repository: AssistantSessionRepository) {
    this.#repository = repository;
    this.ready = this.#load();
  }
  async #load(): Promise<void> {
    try {
      const sessions = await this.#repository.list();
      const restored: AssistantSession[] = [];
      for (const session of sessions) {
        if (session.status !== "running" && session.status !== "committing") {
          restored.push(session);
          continue;
        }
        try {
          const recovered = await this.#recover(session.id);
          if (recovered) restored.push(recovered);
        } catch (cause) {
          if (!(cause instanceof AssistantSessionBusyError)) throw cause;
          restored.push(session);
        }
      }
      this.#sessions = restored.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      for (const session of this.#sessions)
        this.#revisions.set(session.id, session.storageRevision);
      this.#loaded = true;
      this.#error = null;
      this.#unsubscribe = this.#repository.subscribe(
        (rows) => this.#receive(rows),
        (cause) => {
          this.#error = errorMessage(cause);
          this.#notify();
        },
      );
      for (const session of this.#sessions) this.#watchRun(session);
    } catch (cause) {
      this.#error = errorMessage(cause);
    }
    this.#notify();
  }
  async #recover(id: string, wait = false): Promise<AssistantSession | undefined> {
    return this.#repository.withLock(
      id,
      async () => {
        const session = await this.#repository.find(id);
        if (!session) return undefined;
        if (session.status !== "running" && session.status !== "committing") return session;
        const restored: AssistantSession = {
          ...session,
          storageRevision: session.storageRevision + 1,
          status: "interrupted",
          preview: undefined,
          previewId: undefined,
          commitUncertain: session.status === "committing" || session.commitUncertain,
          transcript: completeInterruptedTools(session.transcript),
          messages: session.messages.map((message): QueryChatMessage =>
            message.kind === "assistant" && message.status === "streaming"
              ? {
                  ...message,
                  status: "interrupted",
                  error:
                    session.status === "committing"
                      ? "提交过程被中断，请先查询记录核对结果，再决定后续修改。"
                      : "上次请求已中断，已保留草稿，可以继续发送消息。",
                  segments: message.segments.map((segment) =>
                    segment.kind === "tool" && segment.running
                      ? { ...segment, running: false, isError: true, result: "请求已中断" }
                      : segment,
                  ),
                }
              : message,
          ),
        };
        await this.#repository.put(restored, session.storageRevision);
        return restored;
      },
      wait,
      this.#lifetime.signal,
    );
  }
  #watchRun(session: AssistantSession) {
    if (
      (session.status !== "running" && session.status !== "committing") ||
      this.#executing.has(session.id) ||
      this.#recovering.has(session.id)
    )
      return;
    this.#recovering.add(session.id);
    // 等待原页面释放锁：正常结束已落盘为 idle，页面退出则恢复遗留检查点。
    void this.#recover(session.id, true)
      .catch((cause: unknown) => {
        if (!this.#lifetime.signal.aborted) {
          this.#error = errorMessage(cause);
          this.#notify();
        }
      })
      .finally(() => {
        this.#recovering.delete(session.id);
      });
  }
  #receive(rows: AssistantSession[]) {
    const incoming = new Map(rows.map((row) => [row.id, row]));
    const local = new Set(this.#sessions.map((row) => row.id));
    const next: AssistantSession[] = [];
    for (const session of this.#sessions) {
      if (this.#executing.has(session.id) || this.#unsaved.has(session.id)) {
        next.push(session);
        continue;
      }
      const fresh = incoming.get(session.id);
      if (fresh) {
        this.#revisions.set(fresh.id, Math.max(fresh.storageRevision, session.storageRevision));
        next.push(fresh.storageRevision <= session.storageRevision ? session : fresh);
        this.#watchRun(fresh);
      } else this.#revisions.delete(session.id);
    }
    for (const row of rows)
      if (!local.has(row.id) && !this.#unsaved.has(row.id)) {
        next.push(row);
        this.#revisions.set(row.id, row.storageRevision);
        this.#watchRun(row);
      }
    this.#sessions = next;
    this.#notify();
  }
  isExecuting(id: string) {
    return this.#executing.has(id);
  }
  async execute<T>(id: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#executing.has(id)) throw new Error("会话正在执行，请等待完成或停止");
    const controller = new AbortController();
    this.#executing.set(id, controller);
    this.#notify();
    try {
      await this.flush();
      return await this.#repository.withLock(
        id,
        async () => {
          this.#owned.add(id);
          try {
            const latest = await this.#repository.find(id);
            if (!latest) throw new Error("会话已不存在");
            this.#revisions.set(id, latest.storageRevision);
            this.#sessions = this.#sessions.map((session) =>
              session.id === id ? latest : session,
            );
            this.#notify();
            controller.signal.throwIfAborted();
            return await work(controller.signal);
          } finally {
            try {
              await this.flush();
            } finally {
              this.#owned.delete(id);
            }
          }
        },
        true,
        controller.signal,
      );
    } finally {
      this.#executing.delete(id);
      try {
        this.#receive(await this.#repository.list());
      } catch (cause) {
        this.#error = errorMessage(cause);
      }
      this.#notify();
    }
  }
  dispose() {
    this.#lifetime.abort();
    this.#unsubscribe?.();
    for (const controller of this.#executing.values()) controller.abort();
  }
  getSessions() {
    return this.#sessions;
  }
  isLoaded() {
    return this.#loaded;
  }
  storageError() {
    return this.#error;
  }
  hasPendingWrites() {
    return this.#pending > 0;
  }
  get(id: string): AssistantSession {
    const session = this.#sessions.find((session) => session.id === id);
    if (!session) throw new Error("会话已不存在");
    return session;
  }
  getRun(id: string) {
    return this.#runs.get(id);
  }
  create(context: AssistantContext): AssistantSession {
    if (!this.#loaded) throw new Error("会话尚未加载完成");
    const now = new Date().toISOString();
    const session: AssistantSession = {
      ...context,
      id: crypto.randomUUID(),
      storageRevision: -1,
      title: "新会话",
      createdAt: now,
      updatedAt: now,
      draft: "",
      messages: [],
      transcript: [],
      proposal: new ProposalState().snapshot(),
      status: "idle",
    };
    this.#revisions.set(session.id, -1);
    this.#sessions = [session, ...this.#sessions];
    this.#persist(session);
    this.#notify();
    return session;
  }
  update(
    id: string,
    patch: Partial<
      Pick<
        AssistantSession,
        | "title"
        | "draft"
        | "messages"
        | "transcript"
        | "proposal"
        | "preview"
        | "previewId"
        | "commitUncertain"
        | "status"
      >
    >,
    persist = true,
  ) {
    const current = this.get(id);
    if (
      persist &&
      (patch.title !== undefined || patch.draft !== undefined) &&
      !this.#owned.has(id) &&
      (this.#executing.has(id) || current.status === "running" || current.status === "committing")
    )
      throw new AssistantSessionBusyError();
    const session = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.#sessions = this.#sessions.map((item) => (item.id === id ? session : item));
    if (persist) this.#persist(session);
    this.#notify();
  }
  rename(id: string, title: string) {
    if (!title.trim()) throw new Error("会话名称不能为空");
    this.update(id, { title: title.trim() });
  }
  async delete(id: string) {
    const session = this.get(id);
    if (session.status === "committing") throw new Error("正在提交，完成后可删除会话");
    if (session.status === "running" && !this.#executing.has(id))
      throw new AssistantSessionBusyError();
    this.cancel(id);
    this.#runs.delete(id);
    this.#sessions = this.#sessions.filter((session) => session.id !== id);
    this.#unsaved.set(id, null);
    this.#enqueue(id, null);
    this.#notify();
    await this.flush();
  }
  beginRun(id: string, pendingId: string) {
    const session = this.get(id);
    if (session.status === "committing" || this.#runs.has(id))
      throw new Error("会话正在执行，请等待完成或停止");
    this.#runs.set(id, { pendingId });
    this.update(id, { status: "running", preview: undefined });
  }
  applyEvent(id: string, event: QueryChatEvent) {
    const run = this.#runs.get(id);
    if (!run) return;
    this.update(
      id,
      { messages: applyQueryChatEvent(this.get(id).messages, run.pendingId, event) },
      false,
    );
  }
  finishRun(id: string) {
    this.#runs.delete(id);
    this.update(id, { status: "idle" });
  }
  cancel(id: string) {
    this.#executing.get(id)?.abort();
    return this.#runs.has(id) || this.#executing.has(id);
  }
  cancelSpace(spaceId: MemorySpaceId) {
    for (const session of this.#sessions) if (session.spaceId === spaceId) this.cancel(session.id);
  }
  async clearSpaceHistory(spaceId: MemorySpaceId) {
    if (
      this.#sessions.some(
        (session) => session.spaceId === spaceId && session.status === "committing",
      )
    )
      throw new Error("该空间的助手正在提交，请完成后重试");
    const ids = this.#sessions
      .filter((session) => session.spaceId === spaceId)
      .map((session) => session.id);
    await Promise.all(ids.map((id) => this.delete(id)));
  }
  async flush() {
    await this.#writes;
    if (this.#error) throw new Error(`会话保存失败：${this.#error}`);
  }
  async retrySave() {
    if (!this.#loaded) {
      await this.#load();
      return;
    }
    this.#error = null;
    for (const [id, snapshot] of this.#unsaved) this.#enqueue(id, snapshot);
    await this.flush();
    for (const session of this.#sessions) this.#watchRun(session);
  }
  onStoreChange(listener: () => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #persist(session: AssistantSession) {
    const snapshot = structuredClone(session);
    this.#unsaved.set(session.id, snapshot);
    this.#enqueue(session.id, snapshot);
  }
  #enqueue(id: string, snapshot: AssistantSession | null) {
    this.#pending++;
    this.#writes = this.#writes
      .then(async () => {
        const expected = this.#revisions.get(id);
        if (expected === undefined) throw new Error("会话持久化版本尚未加载");
        if (snapshot === null) {
          await this.#repository.delete(id, expected);
          this.#revisions.delete(id);
        } else {
          const revision = expected + 1;
          await this.#repository.put({ ...snapshot, storageRevision: revision }, expected);
          this.#revisions.set(id, revision);
          this.#sessions = this.#sessions.map((session) =>
            session.id === id ? { ...session, storageRevision: revision } : session,
          );
        }
        if (this.#unsaved.get(id) === snapshot) this.#unsaved.delete(id);
      })
      .catch((cause: unknown) => {
        this.#error = errorMessage(cause);
      })
      .finally(() => {
        this.#pending--;
        this.#notify();
      });
  }
  #notify() {
    for (const listener of this.#listeners) listener();
  }
}

/** 未得到结果的工具调用以中断结果补齐，恢复时不重放任何写操作。 */
export function completeInterruptedTools(messages: readonly AgentMessage[]): AgentMessage[] {
  // ST 请求转换会跳过失败的 assistant，其残缺工具调用和结果也不能进入下一轮。
  let failedAssistant = false;
  const completed = messages.filter((message) => {
    if (message.role === "assistant") {
      failedAssistant = message.stopReason === "error" || message.stopReason === "aborted";
      return !failedAssistant;
    }
    if (message.role === "toolResult") return !failedAssistant;
    failedAssistant = false;
    return true;
  });
  const result: AgentMessage[] = [];
  for (let index = 0; index < completed.length; index++) {
    const message = completed[index]!;
    result.push(message);
    if (message.role !== "assistant") continue;
    for (const call of message.content.filter((part) => part.type === "toolCall")) {
      let found = false;
      for (
        let next = index + 1;
        next < completed.length && completed[next]!.role === "toolResult";
        next++
      ) {
        const tool = completed[next]!;
        if (tool.role === "toolResult" && tool.toolCallId === call.id) found = true;
      }
      if (!found)
        result.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [
            {
              type: "text",
              text: "请求已中断。工具可能已改变草稿，请先用 proposal_preview 检查当前草稿；不要直接重放操作。",
            },
          ],
          isError: true,
          timestamp: Date.now(),
        });
    }
  }
  return result;
}
