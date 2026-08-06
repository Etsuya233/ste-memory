import { afterEach, describe, expect, it } from "vitest";
import {
  MUTATE_TOOL_NAME,
  PROPOSAL_PREVIEW_TOOL_NAME,
  SUBMIT_PROPOSAL_TOOL_NAME,
} from "@ste-memory/core/memory/agent";
import type { MemorySpaceId, MemoryTableKey } from "@ste-memory/core/memory";
import type { buildServer } from "../src/adapters/inbound/http/server.ts";
import { parseSillyTavernJsonl } from "../src/adapters/inbound/sillytavern-jsonl/parser.ts";
import type { MemorySpaceView } from "../src/application/ports/memory-space.ts";
import { createTestApplication } from "./test-application.ts";
import {
  assistantMessage,
  fakeModel,
  hangingStreamFn,
  lastToolResult,
  scriptedStreamFn,
  textMessage,
  toStream,
  toolCallMessage,
} from "./chat-stream-support.ts";
import { ScriptedEventStream } from "./chat-stream-support.ts";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

const servers: Awaited<ReturnType<typeof buildServer>>[] = [];

type TestApplication = Awaited<ReturnType<typeof createTestApplication>>;

const now = "2026-07-30T01:02:03.000Z";

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** 6 条消息的 JSONL：source_id 1..6，可拆 3 个块（blockSize=2）。 */
const SIX_MESSAGES = Array.from({ length: 6 }, (_, index) =>
  JSON.stringify({
    name: index % 2 === 0 ? "Alice" : "Bob",
    is_user: index % 2 === 0,
    send_date: `2026-07-28T00:00:0${index}.000Z`,
    mes: `消息 ${index + 1}`,
  }),
).join("\n");

/** 填表 Agent 脚本：每块 mutate(create characters 云烬) → preview → submit → 自然结束。 */
function scriptedFillAgent() {
  return scriptedStreamFn((context) => {
    if (!lastToolResult(context)) {
      return assistantMessage(
        [
          toolCallMessage("call-1", MUTATE_TOOL_NAME, {
            op: "create",
            table: "characters",
            patch: { name: "云烬" },
          }),
          toolCallMessage("call-2", PROPOSAL_PREVIEW_TOOL_NAME, {}),
          toolCallMessage("call-3", SUBMIT_PROPOSAL_TOOL_NAME, {}),
        ],
        "toolUse",
      );
    }
    return assistantMessage([textMessage("已提交")], "stop");
  });
}

/**
 * 门控 streamFn：前 gateAtCall-1 次调用正常响应；第 gateAtCall 次调用挂起，
 * 直到 gate.open() 才响应；放行后后续调用正常。用于模拟"块运行时任务仍在跑"。
 */
function gatedStreamFn(
  respond: (context: Context) => AssistantMessage,
  gateAtCall: number,
): ReturnType<typeof scriptedStreamFn> & {
  readonly gate: { readonly fired: boolean; open: () => void };
} {
  const calls = { count: 0 };
  const contexts: Context[] = [];
  const gate: { fired: boolean; open: () => void } = {
    fired: false,
    open: () => undefined,
  };
  const waiters: Array<() => void> = [];
  const streamFn: StreamFn = (_model, context) => {
    calls.count += 1;
    contexts.push(context);
    const stream = new ScriptedEventStream();
    const respondNow = () => {
      const message = respond(context);
      stream.push({ type: "start", partial: message });
      stream.push({
        type: "done",
        reason: message.stopReason as "stop" | "toolUse",
        message,
      });
      stream.end(message);
    };
    if (calls.count === gateAtCall && !gate.fired) {
      waiters.push(respondNow);
    } else {
      queueMicrotask(respondNow);
    }
    return toStream(stream);
  };
  gate.open = () => {
    if (gate.fired) return;
    gate.fired = true;
    waiters.splice(0).forEach((respondNow) => respondNow());
  };
  return Object.assign(streamFn, { respond, calls, contexts, gate });
}

/** 建一个有 6 条 JSONL 消息、装了系统表的记忆空间。 */
async function setupSpace(app: TestApplication): Promise<MemorySpaceView> {
  return app.memorySpaces.create({
    name: "会话",
    chat: parseSillyTavernJsonl(SIX_MESSAGES),
  });
}

function submitFillTask(
  app: TestApplication,
  spaceId: MemorySpaceId,
  payload: Record<string, unknown>,
) {
  return app.server.inject({
    method: "POST",
    url: `/memory-spaces/${spaceId}/fill-tasks`,
    payload,
  });
}

function controlFillTask(
  app: TestApplication,
  spaceId: MemorySpaceId,
  runId: string,
  action: "pause" | "resume" | "cancel",
) {
  return app.server.inject({
    method: "POST",
    url: `/memory-spaces/${spaceId}/fill-tasks/${runId}/${action}`,
  });
}

/** 轮询任务行直到指定状态（超时抛错）。 */
async function waitForTaskStatus(
  app: TestApplication,
  runId: string,
  status: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await app.context.database
      .selectFrom("memory_fill_tasks")
      .select("status")
      .where("run_id", "=", runId)
      .executeTakeFirst();
    if (row?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`任务 ${runId} 未在 ${timeoutMs}ms 内到达状态 ${status}`);
}

async function taskRow(app: TestApplication, runId: string) {
  return app.context.database
    .selectFrom("memory_fill_tasks")
    .selectAll()
    .where("run_id", "=", runId)
    .executeTakeFirst();
}

async function messageStatuses(app: TestApplication, spaceId: MemorySpaceId) {
  const rows = await app.context.database
    .selectFrom("source_store_messages")
    .select(["source_id", "status"])
    .where("memory_space_id", "=", spaceId)
    .orderBy("source_id")
    .execute();
  return rows.map((row) => row.status);
}

const LLM_CONFIG = { model: "test-model", apiKey: "test-key", baseUrl: "" };

describe("ticket 14：填表任务生命周期控制", () => {
  it("暂停在安全点生效并保持只读，恢复后从下一块继续且不重跑已成功批次", async () => {
    const streamFn = gatedStreamFn(scriptedFillAgent().respond, 3);
    const app = await createTestApplication("ste-lifecycle-pause-", now, {
      buildLlmPort: () => ({ streamFn, model: fakeModel() }),
    });
    servers.push(app.server);
    const space = await setupSpace(app);

    const response = await submitFillTask(app, space.id, {
      from: 1,
      to: 6,
      blockSize: 2,
      config: LLM_CONFIG,
    });
    expect(response.statusCode).toBe(202);
    const task = response.json();
    // 轮询视图：总来源数 = 范围大小，初始已处理 0。
    expect(task).toMatchObject({ status: "running", processedCount: 0, totalCount: 6 });

    // 等块 2 开始（第 3 次流式调用触发门控）：块 1 已原子提交完成。
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && streamFn.calls.count < 3) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(streamFn.calls.count).toBe(3);

    // 暂停请求：立即进入 pause_requested（不打断正在运行的块）。
    const pause = await controlFillTask(app, space.id, task.runId, "pause");
    expect(pause.statusCode).toBe(200);
    expect(pause.json()).toMatchObject({
      runId: task.runId,
      status: "pause_requested",
      processedCount: 2,
      totalCount: 6,
    });

    // 放行块 2：块提交完成后，循环在下一块的安全点应用暂停。
    streamFn.gate.open();
    await waitForTaskStatus(app, task.runId, "paused");

    // 暂停期间：块 1、2 已提交（不重跑），目标空间仍只读，其他空间可写。
    expect(await messageStatuses(app, space.id)).toEqual([
      "processed",
      "processed",
      "processed",
      "processed",
      "untracked",
      "untracked",
    ]);
    const characters = (await app.tableRepository.findByKey(
      space.id,
      "characters" as MemoryTableKey,
    ))!;
    const nameField = (await app.fieldRepository.list(space.id, characters.id)).find(
      (field) => field.key === "name",
    )!;
    const write = await app.server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/tables/${characters.id}/records`,
      payload: { payload: { [nameField.id]: "手动写入" } },
    });
    expect(write.statusCode).toBe(409);
    expect(write.json()).toMatchObject({ type: "fill_task_space_read_only" });

    const otherSpace = await app.memorySpaces.create({
      name: "其他空间",
      chat: parseSillyTavernJsonl(SIX_MESSAGES),
    });
    const otherTable = await app.server.inject({
      method: "POST",
      url: `/memory-spaces/${otherSpace.id}/tables`,
      payload: { key: "notes", name: "笔记" },
    });
    expect(otherTable.statusCode).toBe(201);

    // 恢复：回到 running，块 3 继续执行到成功。
    const resume = await controlFillTask(app, space.id, task.runId, "resume");
    expect(resume.statusCode).toBe(200);
    expect(resume.json()).toMatchObject({ runId: task.runId, status: "running" });

    await waitForTaskStatus(app, task.runId, "succeeded");
    expect(await messageStatuses(app, space.id)).toEqual([
      "processed",
      "processed",
      "processed",
      "processed",
      "processed",
      "processed",
    ]);
    // 3 块各一次 Agent 调用（工具轮 + 回答轮），恢复后未重跑任何已成功块。
    expect(streamFn.calls.count).toBe(6);
    const records = await app.recordRepository.list(space.id, characters.id);
    expect(records).toHaveLength(3);

    // 轮询端点（active 返回 null，任务已完成）。
    const active = await app.server.inject({
      method: "GET",
      url: `/memory-spaces/${space.id}/fill-tasks/active`,
    });
    expect(active.json().task).toBeNull();
  });

  it("中止在提交前丢弃未提交提案：出错块消息保持 untracked，任务 cancelled", async () => {
    const streamFn = gatedStreamFn(scriptedFillAgent().respond, 3);
    const app = await createTestApplication("ste-lifecycle-cancel-", now, {
      buildLlmPort: () => ({ streamFn, model: fakeModel() }),
    });
    servers.push(app.server);
    const space = await setupSpace(app);

    const response = await submitFillTask(app, space.id, {
      from: 1,
      to: 6,
      blockSize: 2,
      config: LLM_CONFIG,
    });
    const task = response.json();

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && streamFn.calls.count < 3) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const cancel = await controlFillTask(app, space.id, task.runId, "cancel");
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toMatchObject({ runId: task.runId, status: "cancel_requested" });

    // 放行块 2：Agent 完成后在提交前检查到中止请求，提案被丢弃、消息不标记。
    streamFn.gate.open();
    await waitForTaskStatus(app, task.runId, "cancelled");

    const row = await taskRow(app, task.runId);
    expect(row?.error_message).toBeNull();
    expect(await messageStatuses(app, space.id)).toEqual([
      "processed",
      "processed",
      "untracked",
      "untracked",
      "untracked",
      "untracked",
    ]);
    // 块 1 已提交 1 条记录；块 2 的提案未落库。
    const characters = (await app.tableRepository.findByKey(
      space.id,
      "characters" as MemoryTableKey,
    ))!;
    expect(await app.recordRepository.list(space.id, characters.id)).toHaveLength(1);

    // 终态任务可再次提交（取消后不冲突）。
    const resubmit = await submitFillTask(app, space.id, { from: 1, to: 2, config: LLM_CONFIG });
    expect(resubmit.statusCode).toBe(202);
  });

  it("状态转换校验：非法暂停/恢复/中止 409 携带当前任务，任务不存在 404", async () => {
    const streamFn = scriptedFillAgent();
    const app = await createTestApplication("ste-lifecycle-state-", now, {
      buildLlmPort: () => ({ streamFn, model: fakeModel() }),
    });
    servers.push(app.server);
    const space = await setupSpace(app);

    const response = await submitFillTask(app, space.id, {
      from: 1,
      to: 6,
      blockSize: 2,
      config: LLM_CONFIG,
    });
    const task = response.json();
    await waitForTaskStatus(app, task.runId, "succeeded");

    // 已终态任务不可暂停/恢复/中止。
    for (const action of ["pause", "resume", "cancel"] as const) {
      const attempt = await controlFillTask(app, space.id, task.runId, action);
      expect(attempt.statusCode).toBe(409);
      expect(attempt.json()).toMatchObject({
        type: "fill_task_state_invalid",
        task: { runId: task.runId, status: "succeeded" },
      });
    }

    // 运行中的任务不可恢复（只有 paused 可恢复）。
    const streamFn2 = hangingStreamFn();
    const app2 = await createTestApplication("ste-lifecycle-state2-", now, {
      buildLlmPort: () => ({ streamFn: streamFn2, model: fakeModel() }),
    });
    servers.push(app2.server);
    const space2 = await setupSpace(app2);
    const second = await submitFillTask(app2, space2.id, {
      from: 1,
      to: 6,
      config: LLM_CONFIG,
    });
    const runningTask = second.json();
    const resume = await controlFillTask(app2, space2.id, runningTask.runId, "resume");
    expect(resume.statusCode).toBe(409);
    expect(resume.json()).toMatchObject({ type: "fill_task_state_invalid" });

    // 不存在的任务 / 属于其他空间的任务 → 404。
    const missing = await controlFillTask(app, space.id, "run-missing", "pause");
    expect(missing.statusCode).toBe(404);
    expect(missing.json().type).toBe("fill_task_not_found");
    const crossSpace = await controlFillTask(app2, space2.id, task.runId, "cancel");
    expect(crossSpace.statusCode).toBe(404);
  });

  it("API 重启后所有非终态任务标记 interrupted，不自动重放", async () => {
    const directory = `${await import("node:os").then((os) => os.tmpdir())}/ste-lifecycle-restart-${Date.now()}`;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(directory, { recursive: true });
    const databaseUrl = `sqlite:${directory}/application.sqlite`;

    // 第一代：提交一个挂起的任务。
    const app1 = await createTestApplication("ste-lifecycle-restart-", now, {
      buildLlmPort: () => ({ streamFn: hangingStreamFn(), model: fakeModel() }),
      databaseUrl,
    });
    servers.push(app1.server);
    const space = await setupSpace(app1);
    const first = await submitFillTask(app1, space.id, { from: 1, to: 6, config: LLM_CONFIG });
    expect(first.statusCode).toBe(202);
    await waitForTaskStatus(app1, first.json().runId, "running");

    // 模拟进程退出：关闭第一代（销毁数据库连接）。
    await app1.server.close();
    servers.splice(servers.indexOf(app1.server), 1);

    // 第二代：同一数据库文件启动，非终态任务被标记 interrupted，消息不被重放。
    const app2 = await createTestApplication("ste-lifecycle-restart-", now, {
      buildLlmPort: () => ({ streamFn: hangingStreamFn(), model: fakeModel() }),
      databaseUrl,
    });
    servers.push(app2.server);
    const row = await taskRow(app2, first.json().runId);
    expect(row?.status).toBe("interrupted");
    expect(await messageStatuses(app2, space.id)).toEqual([
      "untracked",
      "untracked",
      "untracked",
      "untracked",
      "untracked",
      "untracked",
    ]);
    // 已中断后不再占用活动名额：可提交新任务。
    const resubmit = await submitFillTask(app2, space.id, { from: 1, to: 6, config: LLM_CONFIG });
    expect(resubmit.statusCode).toBe(202);
  });
});
