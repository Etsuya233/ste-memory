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
export interface AssistantSessionRepository {
  list(): Promise<AssistantSession[]>;
  put(session: AssistantSession): Promise<void>;
  delete(id: string): Promise<void>;
}

/** 供独立预览和测试使用；生产注入 IndexedDB。 */
export class InMemoryAssistantSessions implements AssistantSessionRepository {
  readonly rows = new Map<string, AssistantSession>();
  async list() {
    return structuredClone([...this.rows.values()]);
  }
  async put(session: AssistantSession) {
    this.rows.set(session.id, structuredClone(session));
  }
  async delete(id: string) {
    this.rows.delete(id);
  }
}

export class QueryChatStore {
  readonly #repository: AssistantSessionRepository;
  readonly #listeners = new Set<() => void>();
  readonly #runs = new Map<string, { pendingId: string; controller: AbortController }>();
  #sessions: readonly AssistantSession[] = [];
  #writes: Promise<void> = Promise.resolve();
  #error: string | null = null;
  #loaded = false;
  #pending = 0;
  readonly #unsaved = new Map<string, AssistantSession | null>();
  readonly ready: Promise<void>;

  constructor(repository: AssistantSessionRepository) {
    this.#repository = repository;
    this.ready = this.#load();
  }
  async #load(): Promise<void> {
    try {
      const sessions = await this.#repository.list();
      const interruptedIds = new Set(
        sessions
          .filter((session) => session.status === "running" || session.status === "committing")
          .map((session) => session.id),
      );
      this.#sessions = sessions
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((session) => {
          if (session.status !== "running" && session.status !== "committing") return session;
          return {
            ...session,
            status: "interrupted" as const,
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
        });
      this.#loaded = true;
      this.#error = null;
      for (const session of this.#sessions)
        if (interruptedIds.has(session.id)) this.#persist(session);
    } catch (cause) {
      this.#error = errorMessage(cause);
    }
    this.#notify();
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
      title: "新会话",
      createdAt: now,
      updatedAt: now,
      draft: "",
      messages: [],
      transcript: [],
      proposal: new ProposalState().snapshot(),
      status: "idle",
    };
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
    const session = { ...this.get(id), ...patch, updatedAt: new Date().toISOString() };
    this.#sessions = this.#sessions.map((item) => (item.id === id ? session : item));
    if (persist) this.#persist(session);
    this.#notify();
  }
  rename(id: string, title: string) {
    if (!title.trim()) throw new Error("会话名称不能为空");
    this.update(id, { title: title.trim() });
  }
  async delete(id: string) {
    if (this.get(id).status === "committing") throw new Error("正在提交，完成后可删除会话");
    this.cancel(id);
    this.#runs.delete(id);
    this.#sessions = this.#sessions.filter((session) => session.id !== id);
    this.#unsaved.set(id, null);
    this.#enqueue(id, null);
    this.#notify();
    await this.flush();
  }
  beginRun(id: string, pendingId: string, controller: AbortController) {
    const session = this.get(id);
    if (session.status === "committing" || this.#runs.has(id))
      throw new Error("会话正在执行，请等待完成或停止");
    this.#runs.set(id, { pendingId, controller });
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
    const run = this.#runs.get(id);
    run?.controller.abort();
    return run !== undefined;
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
        if (snapshot === null) await this.#repository.delete(id);
        else await this.#repository.put(snapshot);
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
