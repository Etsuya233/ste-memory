import { describe, expect, it, vi } from "vitest";
import {
  QueryChatStore,
  InMemoryAssistantSessions,
  completeInterruptedTools,
} from "./session-store.ts";
import { ProposalState } from "../agent/tools/proposal/proposal-state.ts";
import { createPendingAssistantMessage, createUserMessage } from "./query-chat-state.ts";
import type { MemorySpaceId } from "../memory/index.ts";
import { assistantMessage, toolCallMessage } from "../fill-tasks/stream-fn-support.ts";
import { createTestDatabase } from "../../infrastructure/indexeddb/test-support.ts";
import { IndexedDbAssistantSessions } from "../../infrastructure/indexeddb/assistant-session-repository.ts";

const context = { chatKey: "chat-a", spaceId: "space-a" as MemorySpaceId };
describe("会话持久化与恢复", () => {
  it("取消时残缺的工具调用不进入下一轮，避免 ST 过滤 assistant 后留下孤立工具结果", () => {
    const failed = assistantMessage([toolCallMessage("partial", "query_records", {})], "aborted");
    expect(completeInterruptedTools([failed])).toEqual([]);
  });
  it("真实 IndexedDB 保存多个会话的名称、输入、提案计数器及工具消息", async () => {
    const db = createTestDatabase("assistant-sessions-");
    const repo = new IndexedDbAssistantSessions(db);
    const store = new QueryChatStore(repo);
    await store.ready;
    const a = store.create(context),
      b = store.create(context);
    const state = new ProposalState();
    const tempId = state.allocateTempId();
    state.apply({ op: "create", tableKey: "characters", tempId, patch: { name: "云烬" } });
    store.rename(a.id, "人物整理");
    store.update(a.id, {
      draft: "继续整理",
      proposal: state.snapshot(),
      messages: [createUserMessage("u", "记一下")],
    });
    await store.flush();
    const restored = new QueryChatStore(repo);
    await restored.ready;
    expect(restored.get(a.id)).toMatchObject({
      title: "人物整理",
      draft: "继续整理",
      proposal: state.snapshot(),
    });
    expect(new ProposalState(restored.get(a.id).proposal).allocateTempId()).toBe("tmp:2");
    expect(restored.get(b.id).messages).toHaveLength(0);
    await restored.delete(a.id);
    const again = new QueryChatStore(repo);
    await again.ready;
    expect(again.getSessions().map((session) => session.id)).toEqual([b.id]);
    db.close();
  });
  it("刷新把运行项标为已中断，补齐未完成工具结果，保留草稿", async () => {
    const repo = new InMemoryAssistantSessions();
    const store = new QueryChatStore(repo);
    await store.ready;
    const a = store.create(context);
    const state = new ProposalState();
    state.apply({
      op: "create",
      tableKey: "characters",
      tempId: state.allocateTempId(),
      patch: { name: "云烬" },
    });
    store.update(a.id, {
      messages: [createPendingAssistantMessage("pending")],
      proposal: state.snapshot(),
      transcript: [assistantMessage([toolCallMessage("call", "mutate", {})], "toolUse")],
    });
    store.beginRun(a.id, "pending", new AbortController());
    await store.flush();
    const restored = new QueryChatStore(repo);
    await restored.ready;
    expect(restored.getRun(a.id)).toBeUndefined();
    expect(restored.get(a.id)).toMatchObject({ status: "interrupted", proposal: state.snapshot() });
    expect(restored.get(a.id).messages[0]).toMatchObject({ status: "interrupted" });
    expect(restored.get(a.id).transcript.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: "call",
      isError: true,
    });
    expect(completeInterruptedTools(restored.get(a.id).transcript)).toEqual(
      restored.get(a.id).transcript,
    );
  });
  it("提交中刷新使确认失效，提示核对结果", async () => {
    const repo = new InMemoryAssistantSessions();
    const store = new QueryChatStore(repo);
    await store.ready;
    const a = store.create(context);
    store.update(a.id, { status: "committing", previewId: "old" });
    await store.flush();
    const restored = new QueryChatStore(repo);
    await restored.ready;
    expect(restored.get(a.id)).toMatchObject({
      status: "interrupted",
      commitUncertain: true,
      previewId: undefined,
    });
  });
  it("保存失败展示错误并保留删除操作，重试后不会恢复已删除会话", async () => {
    const repo = new InMemoryAssistantSessions();
    const store = new QueryChatStore(repo);
    await store.ready;
    const a = store.create(context);
    await store.flush();
    const failure = vi.spyOn(repo, "delete").mockRejectedValueOnce(new Error("磁盘已满"));
    await expect(store.delete(a.id)).rejects.toThrow("磁盘已满");
    expect(store.storageError()).toBe("磁盘已满");
    await store.retrySave();
    failure.mockRestore();
    expect(await repo.list()).toHaveLength(0);
    expect(store.storageError()).toBeNull();
  });
  it("加载失败不会当作空会话覆盖数据，重试可恢复", async () => {
    const repo = new InMemoryAssistantSessions();
    const first = new QueryChatStore(repo);
    await first.ready;
    first.create(context);
    await first.flush();
    vi.spyOn(repo, "list").mockRejectedValueOnce(new Error("无法读取"));
    const store = new QueryChatStore(repo);
    await store.ready;
    expect(store.isLoaded()).toBe(false);
    expect(() => store.create(context)).toThrow("尚未加载");
    await store.retrySave();
    expect(store.getSessions()).toHaveLength(1);
  });
  it("清理空间覆盖所有对话与会话，保留其他空间", async () => {
    const repo = new InMemoryAssistantSessions();
    const store = new QueryChatStore(repo);
    await store.ready;
    store.create(context);
    store.create({ ...context, chatKey: "chat-b" });
    const other = store.create({ chatKey: "chat-b", spaceId: "space-b" as MemorySpaceId });
    await store.clearSpaceHistory(context.spaceId);
    expect(store.getSessions().map((session) => session.id)).toEqual([other.id]);
    expect((await repo.list()).map((session) => session.id)).toEqual([other.id]);
  });
});
