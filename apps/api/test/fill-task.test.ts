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
  toolCallMessage,
} from "./chat-stream-support.ts";

const servers: Awaited<ReturnType<typeof buildServer>>[] = [];

type TestApplication = Awaited<ReturnType<typeof createTestApplication>>;

const now = "2026-07-30T01:02:03.000Z";

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** 4 条消息的 JSONL：source_id 1..4，足以拆成 2 个块（blockSize=2）。 */
const FOUR_MESSAGES = [
  '{"name":"Alice","is_user":true,"send_date":"2026-07-28T00:00:00.000Z","mes":"你好，我是艾丽丝"}',
  '{"name":"Bob","is_user":false,"send_date":"2026-07-28T00:00:01.000Z","mes":"我是鲍勃，来港口进货"}',
  '{"name":"Alice","is_user":true,"send_date":"2026-07-28T00:00:02.000Z","mes":"港口最近很热闹"}',
  '{"name":"Bob","is_user":false,"send_date":"2026-07-28T00:00:03.000Z","mes":"下次还来"}',
].join("\n");

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

function emptyProposalAgent() {
  return scriptedStreamFn(() => assistantMessage([textMessage("无需变更")], "stop"));
}

function failingAgent() {
  return scriptedStreamFn(() => assistantMessage([textMessage("模型炸了")], "error", "模型炸了"));
}

/** 建一个有 4 条 JSONL 消息、装了系统表的记忆空间。 */
async function setupSpace(app: TestApplication): Promise<MemorySpaceView> {
  return app.memorySpaces.create({
    name: "会话",
    chat: parseSillyTavernJsonl(FOUR_MESSAGES),
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

/** 轮询任务行直到终态（超时抛错）。 */
async function waitForTerminal(
  app: TestApplication,
  runId: string,
  timeoutMs = 5_000,
): Promise<{ readonly status: string; readonly error_message: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await app.context.database
      .selectFrom("memory_fill_tasks")
      .select(["status", "error_message"])
      .where("run_id", "=", runId)
      .executeTakeFirst();
    if (row && row.status !== "running") return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`任务 ${runId} 未在 ${timeoutMs}ms 内到达终态`);
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

describe("POST /memory-spaces/:spaceId/fill-tasks", () => {
  it("端到端：分块跑 Agent，每块原子写入记录与证据，消息标记 processed，任务 succeeded", async () => {
    const streamFn = scriptedFillAgent();
    const app = await createTestApplication("ste-fill-e2e-", now, {
      buildLlmPort: () => ({ streamFn, model: fakeModel() }),
    });
    servers.push(app.server);
    const space = await setupSpace(app);

    const response = await submitFillTask(app, space.id, {
      from: 1,
      to: 4,
      blockSize: 2,
      config: LLM_CONFIG,
    });

    expect(response.statusCode).toBe(202);
    const task = response.json();
    expect(task).toMatchObject({
      status: "running",
      from: 1,
      to: 4,
      blockSize: 2,
      errorMessage: null,
    });
    expect(typeof task.runId).toBe("string");

    const terminal = await waitForTerminal(app, task.runId);
    expect(terminal.status).toBe("succeeded");
    expect(terminal.error_message).toBeNull();

    // 两块各提交一次 create：记录写入、修订来源 agent、证据 4 条（整批 reference）
    const characters = (await app.tableRepository.findByKey(
      space.id,
      "characters" as MemoryTableKey,
    ))!;
    const records = await app.recordRepository.list(space.id, characters.id);
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.revisionSource).toBe("agent");
      expect(record.source).toEqual({ type: "source", sourceTime: null, sourceLocation: null });
      expect(record.fieldEvidence).toEqual({});
    }
    // create 无旧状态：不写历史
    const historyCount = await app.context.database
      .selectFrom("memory_record_history")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    expect(historyCount.count).toBe(0);
    const evidenceRows = await app.context.database
      .selectFrom("memory_evidence")
      .selectAll()
      .execute();
    expect(evidenceRows).toHaveLength(4);
    expect(evidenceRows.every((row) => row.storage_mode === "reference")).toBe(true);

    expect(await messageStatuses(app, space.id)).toEqual([
      "processed",
      "processed",
      "processed",
      "processed",
    ]);
    // 每块一次 Agent 调用（工具轮 + 回答轮 = 2 次流式调用）
    expect(streamFn.calls.count).toBe(4);
  });

  it("空提案块按成功处理：无记录写入，消息仍标记 processed", async () => {
    const streamFn = emptyProposalAgent();
    const app = await createTestApplication("ste-fill-empty-", now, {
      buildLlmPort: () => ({ streamFn, model: fakeModel() }),
    });
    servers.push(app.server);
    const space = await setupSpace(app);

    const response = await submitFillTask(app, space.id, {
      from: 1,
      to: 2,
      config: LLM_CONFIG,
    });
    expect(response.statusCode).toBe(202);
    const terminal = await waitForTerminal(app, response.json().runId);
    expect(terminal.status).toBe("succeeded");

    const characters = (await app.tableRepository.findByKey(
      space.id,
      "characters" as MemoryTableKey,
    ))!;
    expect(await app.recordRepository.list(space.id, characters.id)).toHaveLength(0);
    expect(await messageStatuses(app, space.id)).toEqual([
      "processed",
      "processed",
      "untracked",
      "untracked",
    ]);
  });

  it("块失败：出错块标记 error、未处理块保持 untracked、任务 failed 并停止", async () => {
    const streamFn = failingAgent();
    const app = await createTestApplication("ste-fill-fail-", now, {
      buildLlmPort: () => ({ streamFn, model: fakeModel() }),
    });
    servers.push(app.server);
    const space = await setupSpace(app);

    const response = await submitFillTask(app, space.id, {
      from: 1,
      to: 4,
      blockSize: 2,
      config: LLM_CONFIG,
    });
    expect(response.statusCode).toBe(202);
    const terminal = await waitForTerminal(app, response.json().runId);
    expect(terminal.status).toBe("failed");
    expect(terminal.error_message).toContain("模型炸了");

    expect(await messageStatuses(app, space.id)).toEqual([
      "error",
      "error",
      "untracked",
      "untracked",
    ]);
    // 失败块未产生任何数据/历史/证据
    const characters = (await app.tableRepository.findByKey(
      space.id,
      "characters" as MemoryTableKey,
    ))!;
    expect(await app.recordRepository.list(space.id, characters.id)).toHaveLength(0);
    const evidenceCount = await app.context.database
      .selectFrom("memory_evidence")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    expect(evidenceCount.count).toBe(0);
    // 只跑了一块（首次 Agent 调用失败即停止）
    expect(streamFn.calls.count).toBe(1);
  });

  it("运行中再次提交：409 携带当前任务，active 端点返回当前任务", async () => {
    const streamFn = hangingStreamFn();
    const app = await createTestApplication("ste-fill-conflict-", now, {
      buildLlmPort: () => ({ streamFn, model: fakeModel() }),
    });
    servers.push(app.server);
    const space = await setupSpace(app);

    const first = await submitFillTask(app, space.id, {
      from: 1,
      to: 4,
      config: LLM_CONFIG,
    });
    expect(first.statusCode).toBe(202);
    const firstTask = first.json();

    const second = await submitFillTask(app, space.id, {
      from: 1,
      to: 4,
      config: LLM_CONFIG,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      type: "fill_task_conflict",
      task: { runId: firstTask.runId, status: "running" },
    });

    const active = await app.server.inject({
      method: "GET",
      url: `/memory-spaces/${space.id}/fill-tasks/active`,
    });
    expect(active.statusCode).toBe(200);
    expect(active.json().task).toMatchObject({ runId: firstTask.runId, status: "running" });
  });

  it("任务期间目标空间只读：手动写 409，读取不受影响", async () => {
    const streamFn = hangingStreamFn();
    const app = await createTestApplication("ste-fill-readonly-", now, {
      buildLlmPort: () => ({ streamFn, model: fakeModel() }),
    });
    servers.push(app.server);
    const space = await setupSpace(app);
    await submitFillTask(app, space.id, { from: 1, to: 4, config: LLM_CONFIG });

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
      payload: { payload: { [nameField.id]: "新人" } },
    });
    expect(write.statusCode).toBe(409);
    expect(write.json()).toMatchObject({ type: "fill_task_space_read_only" });

    const rename = await app.server.inject({
      method: "PATCH",
      url: `/memory-spaces/${space.id}`,
      payload: { name: "改名" },
    });
    expect(rename.statusCode).toBe(409);

    const read = await app.server.inject({
      method: "GET",
      url: `/memory-spaces/${space.id}/tables`,
    });
    expect(read.statusCode).toBe(200);
  });

  it("重复处理已成功范围：证据复用既有行，不触发唯一约束冲突，任务仍成功", async () => {
    const streamFn = scriptedFillAgent();
    const app = await createTestApplication("ste-fill-rerun-", now, {
      buildLlmPort: () => ({ streamFn, model: fakeModel() }),
    });
    servers.push(app.server);
    const space = await setupSpace(app);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await submitFillTask(app, space.id, {
        from: 1,
        to: 2,
        config: LLM_CONFIG,
      });
      expect(response.statusCode).toBe(202);
      const terminal = await waitForTerminal(app, response.json().runId);
      expect(terminal.status).toBe("succeeded");
    }

    // 两轮任务都成功：记录各新增 1 条；证据行不重复（同源唯一，第二轮复用既有行）
    const characters = (await app.tableRepository.findByKey(
      space.id,
      "characters" as MemoryTableKey,
    ))!;
    expect(await app.recordRepository.list(space.id, characters.id)).toHaveLength(2);
    const evidenceRows = await app.context.database
      .selectFrom("memory_evidence")
      .selectAll()
      .execute();
    expect(evidenceRows).toHaveLength(2);
  });

  it("参数校验：范围越界/非法分块 400，LLM 配置缺失 400，空间不存在 404", async () => {
    const streamFn = emptyProposalAgent();
    const app = await createTestApplication("ste-fill-validate-", now, {
      buildLlmPort: () => ({ streamFn, model: fakeModel() }),
    });
    servers.push(app.server);
    const space = await setupSpace(app);

    for (const payload of [
      { from: 2, to: 1, config: LLM_CONFIG },
      { from: 0, to: 4, config: LLM_CONFIG },
      { from: 1, to: 5, config: LLM_CONFIG },
      { from: 1, to: 4, blockSize: 0, config: LLM_CONFIG },
    ]) {
      const response = await submitFillTask(app, space.id, payload);
      expect(response.statusCode).toBe(400);
      expect(response.json().type).toBe("fill_task_range_invalid");
    }

    // 环境变量与请求都没有 LLM 配置 → 提交即 400，不启动任务
    const noConfig = await submitFillTask(app, space.id, { from: 1, to: 2 });
    expect(noConfig.statusCode).toBe(400);
    expect(noConfig.json().type).toBe("llm_config_error");

    const missing = await submitFillTask(app, "space-missing" as MemorySpaceId, {
      from: 1,
      to: 2,
      config: LLM_CONFIG,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().type).toBe("fill_task_space_not_found");
  });
});
