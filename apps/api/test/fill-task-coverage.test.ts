import { afterEach, describe, expect, it } from "vitest";
import {
  MUTATE_TOOL_NAME,
  PROPOSAL_PREVIEW_TOOL_NAME,
  SUBMIT_PROPOSAL_TOOL_NAME,
} from "@ste-memory/core/memory/agent";
import type { MemorySpaceId } from "@ste-memory/core/memory";
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

/** 4 条消息的 JSONL：source_id 1..4。 */
const FOUR_MESSAGES = [
  '{"name":"Alice","is_user":true,"send_date":"2026-07-28T00:00:00.000Z","mes":"你好，我是艾丽丝"}',
  '{"name":"Bob","is_user":false,"send_date":"2026-07-28T00:00:01.000Z","mes":"我是鲍勃，来港口进货"}',
  '{"name":"Alice","is_user":true,"send_date":"2026-07-28T00:00:02.000Z","mes":"港口最近很热闹"}',
  '{"name":"Bob","is_user":false,"send_date":"2026-07-28T00:00:03.000Z","mes":"下次还来"}',
].join("\n");

/** 6 条消息的 JSONL：source_id 1..6（四态混合场景需要）。 */
const SIX_MESSAGES = [
  '{"name":"Alice","is_user":true,"send_date":"2026-07-28T00:00:00.000Z","mes":"第一句"}',
  '{"name":"Bob","is_user":false,"send_date":"2026-07-28T00:00:01.000Z","mes":"第二句"}',
  '{"name":"Alice","is_user":true,"send_date":"2026-07-28T00:00:02.000Z","mes":"第三句"}',
  '{"name":"Bob","is_user":false,"send_date":"2026-07-28T00:00:03.000Z","mes":"第四句"}',
  '{"name":"Alice","is_user":true,"send_date":"2026-07-28T00:00:04.000Z","mes":"第五句"}',
  '{"name":"Bob","is_user":false,"send_date":"2026-07-28T00:00:05.000Z","mes":"第六句"}',
].join("\n");

const LLM_CONFIG = { model: "test-model", apiKey: "test-key", baseUrl: "" };

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

/** 失败 Agent 脚本：首次调用即返回 error（块失败 → 出错块标记 error 并停止任务）。 */
function failingAgent() {
  return scriptedStreamFn(() => assistantMessage([textMessage("模型炸了")], "error", "模型炸了"));
}

/** 建一个有 N 条 JSONL 消息、装了系统表的记忆空间。 */
async function setupSpace(app: TestApplication, jsonl: string): Promise<MemorySpaceView> {
  return app.memorySpaces.create({
    name: "会话",
    chat: parseSillyTavernJsonl(jsonl),
  });
}

function fetchCoverage(app: TestApplication, spaceId: MemorySpaceId) {
  return app.server.inject({
    method: "GET",
    url: `/memory-spaces/${spaceId}/fill-tasks/coverage`,
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

describe("GET /memory-spaces/:spaceId/fill-tasks/coverage", () => {
  it("无任何任务：全部消息为没计划（unplanned），source_id 升序", async () => {
    const app = await createTestApplication("ste-cover-empty-", now, {
      buildLlmPort: () => ({ streamFn: hangingStreamFn(), model: fakeModel() }),
    });
    servers.push(app.server);
    const space = await setupSpace(app, FOUR_MESSAGES);

    const response = await fetchCoverage(app, space.id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      states: [
        { sourceId: 1, state: "unplanned" },
        { sourceId: 2, state: "unplanned" },
        { sourceId: 3, state: "unplanned" },
        { sourceId: 4, state: "unplanned" },
      ],
    });
  });

  it("活动任务挂起：范围内 untracked 为任务中待跑（in_task），范围外为没计划", async () => {
    const app = await createTestApplication("ste-cover-hang-", now, {
      buildLlmPort: () => ({ streamFn: hangingStreamFn(), model: fakeModel() }),
    });
    servers.push(app.server);
    const space = await setupSpace(app, FOUR_MESSAGES);

    const submitted = await submitFillTask(app, space.id, {
      from: 2,
      to: 3,
      blockSize: 2,
      config: LLM_CONFIG,
    });
    expect(submitted.statusCode).toBe(202);
    // 任务保持运行（首个块挂起，消息不会被标记）：范围 [2, 3] 内待跑、范围外没计划。
    const response = await fetchCoverage(app, space.id);
    expect(response.statusCode).toBe(200);
    expect(response.json().states).toEqual([
      { sourceId: 1, state: "unplanned" },
      { sourceId: 2, state: "in_task" },
      { sourceId: 3, state: "in_task" },
      { sourceId: 4, state: "unplanned" },
    ]);
  });

  it("失败任务终态：出错块为错误（error），未跑到的块回落到没计划", async () => {
    const app = await createTestApplication("ste-cover-fail-", now, {
      buildLlmPort: () => ({ streamFn: failingAgent(), model: fakeModel() }),
    });
    servers.push(app.server);
    const space = await setupSpace(app, FOUR_MESSAGES);

    const submitted = await submitFillTask(app, space.id, {
      from: 1,
      to: 4,
      blockSize: 2,
      config: LLM_CONFIG,
    });
    expect(submitted.statusCode).toBe(202);
    const terminal = await waitForTerminal(app, submitted.json().runId);
    expect(terminal.status).toBe("failed");

    const response = await fetchCoverage(app, space.id);
    expect(response.statusCode).toBe(200);
    expect(response.json().states).toEqual([
      { sourceId: 1, state: "error" },
      { sourceId: 2, state: "error" },
      { sourceId: 3, state: "unplanned" },
      { sourceId: 4, state: "unplanned" },
    ]);
  });

  it("成功任务终态：范围内全部消息为已跑过（processed）", async () => {
    const app = await createTestApplication("ste-cover-done-", now, {
      buildLlmPort: () => ({ streamFn: scriptedFillAgent(), model: fakeModel() }),
    });
    servers.push(app.server);
    const space = await setupSpace(app, FOUR_MESSAGES);

    const submitted = await submitFillTask(app, space.id, {
      from: 1,
      to: 4,
      blockSize: 2,
      config: LLM_CONFIG,
    });
    expect(submitted.statusCode).toBe(202);
    expect((await waitForTerminal(app, submitted.json().runId)).status).toBe("succeeded");

    const response = await fetchCoverage(app, space.id);
    expect(response.statusCode).toBe(200);
    expect(response.json().states).toEqual([
      { sourceId: 1, state: "processed" },
      { sourceId: 2, state: "processed" },
      { sourceId: 3, state: "processed" },
      { sourceId: 4, state: "processed" },
    ]);
  });

  it("四态混合：processed 保持、error 优先于任务覆盖、范围内 untracked 待跑", async () => {
    // 任务 A 用填表脚本成功跑完 [1, 4]；随后直接落库把 3-4 置为 error
    // （模拟一次失败重跑的错误标记，标记逻辑本身由 fill-task.test.ts 覆盖）；
    // 任务 B 用挂起脚本覆盖 [3, 6]，保持活动：1-2 processed、3-4 error、5-6 in_task。
    let currentLlm: {
      readonly streamFn: ReturnType<typeof scriptedFillAgent> | ReturnType<typeof hangingStreamFn>;
      readonly model: ReturnType<typeof fakeModel>;
    } = { streamFn: scriptedFillAgent(), model: fakeModel() };
    const app = await createTestApplication("ste-cover-mix-", now, {
      buildLlmPort: () => ({ streamFn: currentLlm.streamFn, model: currentLlm.model }),
    });
    servers.push(app.server);
    const space = await setupSpace(app, SIX_MESSAGES);

    const first = await submitFillTask(app, space.id, {
      from: 1,
      to: 4,
      blockSize: 2,
      config: LLM_CONFIG,
    });
    expect(first.statusCode).toBe(202);
    expect((await waitForTerminal(app, first.json().runId)).status).toBe("succeeded");

    await app.context.database
      .updateTable("source_store_messages")
      .set({ status: "error" })
      .where("memory_space_id", "=", space.id)
      .where("source_id", "in", [3, 4])
      .execute();

    currentLlm = { streamFn: hangingStreamFn(), model: fakeModel() };
    const second = await submitFillTask(app, space.id, {
      from: 3,
      to: 6,
      blockSize: 2,
      config: LLM_CONFIG,
    });
    expect(second.statusCode).toBe(202);

    const response = await fetchCoverage(app, space.id);
    expect(response.statusCode).toBe(200);
    expect(response.json().states).toEqual([
      { sourceId: 1, state: "processed" },
      { sourceId: 2, state: "processed" },
      { sourceId: 3, state: "error" },
      { sourceId: 4, state: "error" },
      { sourceId: 5, state: "in_task" },
      { sourceId: 6, state: "in_task" },
    ]);
  });

  it("记忆空间不存在：404", async () => {
    const app = await createTestApplication("ste-cover-404-", now, {
      buildLlmPort: () => ({ streamFn: hangingStreamFn(), model: fakeModel() }),
    });
    servers.push(app.server);

    const response = await fetchCoverage(app, "missing-space" as MemorySpaceId);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ type: "fill_task_space_not_found" });
  });
});
