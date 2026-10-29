import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import {
  ProposalState,
  type ProposalStateSnapshot,
} from "../agent/tools/proposal/proposal-state.ts";
import type { MemorySpaceId } from "../memory/index.ts";
import type { ProposalPreviewToolResult } from "../agent/index.ts";
import {
  applyQueryChatEvent,
  translateAgentEvent,
  createUserMessage,
  createPendingAssistantMessage,
  type QueryChatCommitResult,
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

/** 一轮的可变提案由 Store 持有，Agent 工具在同一个对象上累积变更。 */
export interface AssistantRun {
  readonly pendingId: string;
  readonly input: AgentMessage;
  readonly proposal: ProposalState;
}

/**
 * 会话的内存状态与持久化入口。
 * 页面只修改输入、管理会话；Service 在独占操作内驱动对话和提案状态转换。
 * 展示消息和模型历史用途不同，但每个完成的消息都和提案一起形成恢复检查点。
 */
export class QueryChatStore {
  readonly #repository: AssistantSessionRepository;
  readonly #createId: () => string;
  readonly #listeners = new Set<() => void>();
  readonly #runs = new Map<string, AssistantRun & { transcript: AgentMessage[] }>();
  #sessions: readonly AssistantSession[] = [];
  #writes: Promise<void> = Promise.resolve();
  #error: string | null = null;
  #loaded = false;
  #pending = 0;
  // 最新待保存意图；null 表示删除。写失败时保留，供显式重试。
  readonly #unsaved = new Map<string, AssistantSession | null>();
  // 只记录已成功落盘的版本，后续排队快照据此做原子版本校验。
  readonly #revisions = new Map<string, number>();
  // 排队和持锁都属于一次操作，取消也能终止尚在等待跨页锁的请求。
  readonly #operations = new Map<string, { controller: AbortController; ownsLock: boolean }>();
  readonly #lifetime = new AbortController();
  readonly #recovering = new Set<string>();
  #unsubscribe: (() => void) | undefined;
  readonly ready: Promise<void>;

  constructor(
    repository: AssistantSessionRepository,
    createId: () => string = () => crypto.randomUUID(),
  ) {
    this.#repository = repository;
    this.#createId = createId;
    this.ready = this.#load();
  }
  isExecuting(id: string) {
    return this.#operations.has(id);
  }
  /**
   * 先保存本页编辑，再等待跨标签页锁；拿锁后重读最新会话交给业务。
   * 回调退出前等待所有检查点落盘，再释放锁，其他页面才可继续同一会话。
   */
  async withExclusiveSession<T>(
    id: string,
    work: (session: AssistantSession, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.#operations.has(id)) throw new Error("会话正在执行，请等待完成或停止");
    const controller = new AbortController();
    const operation = { controller, ownsLock: false };
    this.#operations.set(id, operation);
    this.#notify();
    try {
      await this.flush();
      return await this.#repository.withLock(
        id,
        async () => {
          operation.ownsLock = true;
          try {
            const latest = await this.#repository.find(id);
            if (!latest) throw new Error("会话已不存在");
            this.#revisions.set(id, latest.storageRevision);
            this.#sessions = this.#sessions.map((session) =>
              session.id === id ? latest : session,
            );
            this.#notify();
            controller.signal.throwIfAborted();
            return await work(latest, controller.signal);
          } finally {
            try {
              await this.flush();
            } finally {
              operation.ownsLock = false;
            }
          }
        },
        true,
        controller.signal,
      );
    } finally {
      this.#operations.delete(id);
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
    for (const operation of this.#operations.values()) operation.controller.abort();
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
  getRun(id: string): AssistantRun | undefined {
    return this.#runs.get(id);
  }
  create(context: AssistantContext): AssistantSession {
    if (!this.#loaded) throw new Error("会话尚未加载完成");
    const now = new Date().toISOString();
    const session: AssistantSession = {
      ...context,
      id: this.#createId(),
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
  setDraft(id: string, text: string) {
    this.#update(id, { draft: text });
  }
  rename(id: string, title: string) {
    if (!title.trim()) throw new Error("会话名称不能为空");
    this.#update(id, { title: title.trim() });
  }
  async delete(id: string) {
    const session = this.get(id);
    if (session.status === "committing") throw new Error("正在提交，完成后可删除会话");
    if (session.status === "running" && !this.#operations.has(id))
      throw new AssistantSessionBusyError();
    this.cancel(id);
    this.#runs.delete(id);
    this.#sessions = this.#sessions.filter((session) => session.id !== id);
    this.#unsaved.set(id, null);
    this.#enqueue(id, null);
    this.#notify();
    await this.flush();
  }
  /** 将输入、占位回复与运行状态作为同一个检查点保存。 */
  startRun(id: string, text: string): AssistantRun {
    const session = this.get(id);
    if (session.status === "committing" || this.#runs.has(id))
      throw new Error("会话正在执行，请等待完成或停止");
    const input: AgentMessage = {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    };
    const run = {
      pendingId: this.#createId(),
      input,
      proposal: new ProposalState(session.proposal),
      transcript: [...session.transcript, input],
    };
    this.#runs.set(id, run);
    this.#update(id, {
      status: "running",
      draft: "",
      title:
        session.messages.length || session.title !== "新会话"
          ? session.title
          : text.trim().slice(0, 30),
      preview: undefined,
      previewId: undefined,
      messages: [
        ...session.messages,
        createUserMessage(this.#createId(), text),
        createPendingAssistantMessage(run.pendingId),
      ],
      transcript: [...run.transcript],
    });
    return run;
  }

  /** 增量只刷新界面；完整模型消息到达时连同提案保存，避免逐 token 写入。 */
  recordAgentEvent(id: string, pendingId: string, event: AgentEvent) {
    const run = this.#runs.get(id);
    if (!run || run.pendingId !== pendingId) return;
    let messages = this.get(id).messages;
    for (const translated of translateAgentEvent(event))
      messages = applyQueryChatEvent(messages, pendingId, translated);
    if (event.type === "message_end") {
      if (event.message.role !== "user") run.transcript.push(event.message);
      this.#update(id, {
        messages,
        transcript: [...run.transcript],
        proposal: run.proposal.snapshot(),
      });
    } else if (messages !== this.get(id).messages) {
      this.#update(id, { messages }, false);
    }
  }

  /** 成功、取消和错误统一收尾；已删除会话的迟到事件没有本轮归属。 */
  finishRun(
    id: string,
    pendingId: string,
    terminal: QueryChatEvent,
    preview?: ProposalPreviewToolResult,
  ) {
    const run = this.#runs.get(id);
    if (!run || run.pendingId !== pendingId) return;
    this.#runs.delete(id);
    this.#update(id, {
      status: "idle",
      messages: applyQueryChatEvent(this.get(id).messages, pendingId, terminal),
      transcript: completeInterruptedTools(run.transcript),
      proposal: run.proposal.snapshot(),
      preview,
      previewId: preview ? this.#createId() : undefined,
    });
  }

  /** 校验用户确认的预览身份，并先进入可恢复的提交中状态。 */
  beginCommit(id: string, previewId: string): ProposalPreviewToolResult {
    const session = this.get(id);
    if (session.status === "running" || session.status === "committing")
      throw new Error("会话正在执行");
    if (session.commitUncertain)
      throw new Error("上次提交结果待核对，请查询记录并放弃旧提案后重新准备修改");
    if (!session.preview?.valid || session.previewId !== previewId)
      throw new Error("提案已变化，请重新查看变更后确认");
    if (!session.proposal.operations.length) throw new Error("提案为空");
    this.#update(id, { status: "committing" });
    return session.preview;
  }

  /** 成功回执与清空草稿一次落盘；失败保留提案，但需要重新预览确认。 */
  finishCommit(id: string, commit: QueryChatCommitResult) {
    const session = this.get(id);
    const text =
      commit.status === "committed"
        ? "用户已确认，提案已提交。后续修改请重新查询最新记录。"
        : commit.status === "failed"
          ? `提交失败：${commit.error}`
          : commit.notice;
    this.#update(id, {
      status: "idle",
      proposal: commit.status === "committed" ? new ProposalState().snapshot() : session.proposal,
      preview: undefined,
      previewId: undefined,
      messages: [
        ...session.messages,
        {
          kind: "assistant",
          id: this.#createId(),
          status: "done",
          segments: [{ kind: "text", text }],
          commit,
        },
      ],
      transcript: [...session.transcript, { role: "user", content: text, timestamp: Date.now() }],
    });
  }

  discardProposal(id: string) {
    const session = this.get(id);
    if (session.status === "running" || session.status === "committing")
      throw new Error("会话正在执行");
    this.#update(id, {
      proposal: new ProposalState().snapshot(),
      preview: undefined,
      previewId: undefined,
      commitUncertain: false,
      transcript: [
        ...session.transcript,
        {
          role: "user",
          content: "已放弃当前全部未提交提案，之前的 mutationId 和临时 ID 已失效。",
          timestamp: Date.now(),
        },
      ],
    });
  }
  cancel(id: string) {
    this.#operations.get(id)?.controller.abort();
    return this.#runs.has(id) || this.#operations.has(id);
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
      this.#operations.has(session.id) ||
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
      if (this.#operations.has(session.id) || this.#unsaved.has(session.id)) {
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
  #update(
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
      !this.#operations.get(id)?.ownsLock &&
      (this.#operations.has(id) || current.status === "running" || current.status === "committing")
    )
      throw new AssistantSessionBusyError();
    const session = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.#sessions = this.#sessions.map((item) => (item.id === id ? session : item));
    if (persist) this.#persist(session);
    this.#notify();
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
