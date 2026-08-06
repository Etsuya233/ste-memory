/**
 * 填表任务事件流端点测试（ticket 16）：
 * GET /memory-spaces/:spaceId/fill-tasks/:runId/events 的 SSE 行为——
 * 完整事件序列、终态后订阅、Last-Event-ID 续传、断开不中止、状态事件、404。
 */
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  MUTATE_TOOL_NAME,
  PROPOSAL_PREVIEW_TOOL_NAME,
  SUBMIT_PROPOSAL_TOOL_NAME,
} from "@ste-memory/core/memory/agent";
import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { buildServer } from "../src/adapters/inbound/http/server.ts";
import type { AgentRunEvent } from "../src/application/agent-events.ts";
import { parseSillyTavernJsonl } from "../src/adapters/inbound/sillytavern-jsonl/parser.ts";
import type { MemorySpaceView } from "../src/application/ports/memory-space.ts";
import { createTestApplication } from "./test-application.ts";
import {
  assistantMessage,
  fakeModel,
  lastToolResult,
  scriptedStreamFn,
  textMessage,
  toStream,
  toolCallMessage,
} from "./chat-stream-support.ts";
import { ScriptedEventStream } from "./chat-stream-support.ts";
import { MAX_TOOL_PAYLOAD_CHARS } from "../src/application/fill-tasks/fill-task-event-bus.ts";

const servers: Awaited<ReturnType<typeof buildServer>>[] = [];

type TestApplication = Awaited<ReturnType<typeof createTestApplication>>;

const now = "2026-07-30T01:02:03.000Z";

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** 4 条消息（1 块）与 6 条消息（3 块，blockSize=2）两种规模。 */
const FOUR_MESSAGES = Array.from({ length: 4 }, (_, index) =>
  JSON.stringify({
    name: index % 2 === 0 ? "Alice" : "Bob",
    is_user: index % 2 === 0,
    send_date: `2026-07-28T00:00:0${index}.000Z`,
    mes: `消息 ${index + 1}`,
  }),
).join("\n");
const SIX_MESSAGES = Array.from({ length: 6 }, (_, index) =>
  JSON.stringify({
    name: index % 2 === 0 ? "Alice" : "Bob",
    is_user: index % 2 === 0,
    send_date: `2026-07-28T00:00:0${index}.000Z`,
    mes: `消息 ${index + 1}`,
  }),
).join("\n");

/** 填表 Agent 脚本：每块 mutate(create characters 云烬) → preview → submit → 自然结束。 */
const fillAgentRespond = (context: Context): AssistantMessage => {
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
};

/** 慢 agent：每次流式调用延迟 delayMs 再响应（保证订阅落在任务运行中）。 */
function slowFillAgent(delayMs: number): StreamFn {
  return (_model, context) => {
    const stream = new ScriptedEventStream();
    setTimeout(() => {
      const message = fillAgentRespond(context);
      stream.push({ type: "start", partial: message });
      stream.push({
        type: "done",
        reason: message.stopReason as "stop" | "toolUse",
        message,
      });
      stream.end(message);
    }, delayMs);
    return toStream(stream);
  };
}

/** 慢 agent + 超大 mutate 参数：验证 tool 载荷入缓冲前被截断（ticket 16 截断决策）。 */
function slowHugeArgsFillAgent(delayMs: number): StreamFn {
  return (_model, context) => {
    const stream = new ScriptedEventStream();
    setTimeout(() => {
      const message = !lastToolResult(context)
        ? assistantMessage(
            [
              toolCallMessage("call-1", MUTATE_TOOL_NAME, {
                op: "create",
                table: "characters",
                patch: { name: "云烬", note: "x".repeat(20_000) },
              }),
            ],
            "toolUse",
          )
        : assistantMessage([textMessage("已提交")], "stop");
      stream.push({ type: "start", partial: message });
      stream.push({
        type: "done",
        reason: message.stopReason as "stop" | "toolUse",
        message,
      });
      stream.end(message);
    }, delayMs);
    return toStream(stream);
  };
}

/**
 * 门控 agent：gateAtCall 次调用挂起直到 gate.open()（其余立即响应）。
 * 用于「任务运行中」的确定时序（暂停/取消/断开等）。
 */
function gatedFillAgent(gateAtCall = 1): StreamFn & {
  readonly gate: { readonly fired: boolean; open: () => void };
} {
  const calls = { count: 0 };
  const gate: { fired: boolean; open: () => void } = {
    fired: false,
    open: () => undefined,
  };
  const waiters: Array<() => void> = [];
  const streamFn: StreamFn = (_model, context) => {
    calls.count += 1;
    const stream = new ScriptedEventStream();
    const respondNow = () => {
      const message = fillAgentRespond(context);
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
  return Object.assign(streamFn, { gate });
}

/** 建一个有 N 条 JSONL 消息、装了系统表的记忆空间。 */
async function setupSpace(app: TestApplication, jsonl: string): Promise<MemorySpaceView> {
  return app.memorySpaces.create({ name: "会话", chat: parseSillyTavernJsonl(jsonl) });
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

// ---------------------------------------------------------------------------
// SSE 解析与真实 socket 辅助
// ---------------------------------------------------------------------------

export interface ParsedSseEntry {
  readonly seq: number;
  readonly event: AgentRunEvent;
}

/** 解析 SSE 正文：id: 行 + 单行 JSON data（服务端 data = { seq, event }）。 */
function parseSseEntries(body: string): ParsedSseEntry[] {
  const entries: ParsedSseEntry[] = [];
  let id: string | undefined;
  for (const line of body.split("\n")) {
    if (line.startsWith("id: ")) {
      id = line.slice("id: ".length).trim();
    } else if (line.startsWith("data: ")) {
      const data = JSON.parse(line.slice("data: ".length)) as {
        seq?: unknown;
        event?: AgentRunEvent;
      };
      entries.push({
        seq: id !== undefined ? Number(id) : (data.seq as number),
        event: data.event ?? (data as unknown as AgentRunEvent),
      });
      id = undefined;
    }
  }
  return entries;
}

/** 打开一个真实 TCP 连接请求 SSE 流（供断开/多连接测试）。 */
/** 打开一个真实 TCP 连接请求 SSE 流（供断开/多连接测试）。 */
function connectSse(port: number, path: string): Socket {
  const socket = connect(port, "127.0.0.1");
  socket.write(`GET ${path} HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nconnection: keep-alive\r\n\r\n`);
  return socket;
}

/**
 * 去掉 HTTP 响应头：只有正文确实以响应头开头时才剥离
 * （后续 readUntil 的正文不含头——头部已被前一次读取消费；
 * 若无头 body 直接 indexOf 会误把 chunked 结束块 `0\r\n\r\n` 当头部切掉）。
 */
function stripHttpHead(body: string): string {
  if (!body.startsWith("HTTP/")) return body;
  const index = body.indexOf("\r\n\r\n");
  return index >= 0 ? body.slice(index + 4) : body;
}

/**
 * 读取 socket 上的 SSE 直到 predicate 命中（返回累计正文）或超时/关闭。
 * 原始字节可能被 chunked 编码包裹（十六进制块大小行夹杂在 SSE 行之间），
 * parseSseEntries 只认 `id:` / `data:` 行，块大小行自然被忽略。
 */
function readUntil(
  socket: Socket,
  predicate: (entries: ParsedSseEntry[]) => boolean,
  timeoutMs = 5_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `readUntil 超时（已收到 ${parseSseEntries(stripHttpHead(body)).length} 条事件：${JSON.stringify(parseSseEntries(stripHttpHead(body)).map((entry) => entry.event.type))}）`,
          ),
        ),
      timeoutMs,
    );
    const done = (text: string) => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("close", onClose);
      resolve(text);
    };
    const onData = (chunk: Buffer) => {
      body += chunk.toString();
      if (predicate(parseSseEntries(stripHttpHead(body)))) done(stripHttpHead(body));
    };
    const onClose = () => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("close", onClose);
      reject(new Error("事件流在 predicate 命中前已关闭（服务端提前关流）"));
    };
    socket.on("data", onData);
    socket.on("close", onClose);
  });
}

function waitForClose(socket: Socket, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `等待 socket 关闭超时（destroyed=${socket.destroyed}，readableEnded=${socket.readableEnded}，readable=${socket.readable}，bytesRead=${socket.bytesRead}）`,
          ),
        ),
      timeoutMs,
    );
    // paused 模式下未消费的缓冲数据会阻止 close 事件触发：先 resume 消费掉。
    socket.resume();
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const LLM_CONFIG = { model: "test-model", apiKey: "test-key", baseUrl: "" };

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("GET /memory-spaces/:spaceId/fill-tasks/:runId/events", () => {
  it("整循环：block_start → 工具调用 → block_done → task_status succeeded（运行中订阅）", async () => {
    const app = await createTestApplication("ste-events-full-", now, {
      buildLlmPort: () => ({ streamFn: slowFillAgent(300), model: fakeModel() }),
    });
    servers.push(app.server);
    const space = await setupSpace(app, FOUR_MESSAGES);

    const submitted = await submitFillTask(app, space.id, {
      from: 1,
      to: 4,
      blockSize: 4,
      config: LLM_CONFIG,
    });
    expect(submitted.statusCode).toBe(202);
    const runId = submitted.json().runId as string;

    // 慢 agent 保证订阅落在任务运行中（实时路径；快 agent 场景由终态订阅测试覆盖）。
    const response = await app.server.inject({
      method: "GET",
      url: `/memory-spaces/${space.id}/fill-tasks/${runId}/events`,
      headers: { origin: "http://localhost:5173" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    const entries = parseSseEntries(response.body);
    expect(entries.length).toBeGreaterThan(0);
    // seq 从 1 起严格递增
    expect(entries[0]!.seq).toBe(1);
    entries.forEach((entry, index) => {
      if (index > 0) expect(entry.seq).toBe(entries[index - 1]!.seq + 1);
    });

    const types = entries.map((entry) => entry.event.type);
    expect(types[0]).toBe("block_start");
    expect(entries[0]!.event).toMatchObject({ from: 1, to: 4 });
    expect(types).toContain("tool_start");
    expect(types).toContain("tool_result");
    expect(entries.find((entry) => entry.event.type === "block_done")!.event).toMatchObject({
      from: 1,
      to: 4,
      emptyProposal: false,
      changedRecords: 1,
    });
    expect(entries.at(-1)!.event).toMatchObject({ type: "task_status", status: "succeeded" });
    // 工具参数可见（调试价值）
    const toolStart = entries.find((entry) => entry.event.type === "tool_start")!.event;
    expect(toolStart).toMatchObject({ name: MUTATE_TOOL_NAME });
    expect(toolStart).toMatchObject({ args: { op: "create", table: "characters" } });

    const terminal = await waitForTerminal(app, runId);
    expect(terminal.status).toBe("succeeded");
  });

  it("终态后订阅：缓冲已被清理时只收到补发的终态事件，流正常关闭", async () => {
    const app = await createTestApplication("ste-events-terminal-", now, {
      buildLlmPort: () => ({ streamFn: scriptedStreamFn(fillAgentRespond), model: fakeModel() }),
    });
    servers.push(app.server);
    const space = await setupSpace(app, FOUR_MESSAGES);

    const submitted = await submitFillTask(app, space.id, {
      from: 1,
      to: 4,
      blockSize: 4,
      config: LLM_CONFIG,
    });
    const runId = submitted.json().runId as string;
    await waitForTerminal(app, runId);
    // 循环结束的 release() 已清理缓冲（无人订阅过）：等一个 tick 确保清理完成。
    await new Promise((resolve) => setTimeout(resolve, 100));

    const response = await app.server.inject({
      method: "GET",
      url: `/memory-spaces/${space.id}/fill-tasks/${runId}/events`,
    });
    expect(response.statusCode).toBe(200);
    expect(parseSseEntries(response.body)).toEqual([
      { seq: 1, event: { type: "task_status", status: "succeeded", errorMessage: null } },
    ]);
  });

  it("Last-Event-ID 续传：重连只收到断点之后的事件，不丢不重", async () => {
    const agent = gatedFillAgent(1);
    const app = await createTestApplication("ste-events-resume-", now, {
      buildLlmPort: () => ({ streamFn: agent, model: fakeModel() }),
    });
    servers.push(app.server);
    const space = await setupSpace(app, FOUR_MESSAGES);
    const submitted = await submitFillTask(app, space.id, {
      from: 1,
      to: 4,
      blockSize: 4,
      config: LLM_CONFIG,
    });
    const runId = submitted.json().runId as string;

    const address = await app.server.listen({ host: "127.0.0.1", port: 0 });
    const port = Number(new URL(address).port);

    // 连接 1（真实 TCP）：先订阅，保持连接使缓冲在任务终态后仍存活。
    const socket1 = connectSse(port, `/memory-spaces/${space.id}/fill-tasks/${runId}/events`);
    const body1 = await readUntil(socket1, (entries) =>
      entries.some((e) => e.event.type === "block_start"),
    );
    const seenBefore = parseSseEntries(body1);
    const afterSeq = seenBefore.at(-1)!.seq;

    // 连接 2（断线重连）：带 Last-Event-ID，只应收到其后的事件。
    const pending = app.server.inject({
      method: "GET",
      url: `/memory-spaces/${space.id}/fill-tasks/${runId}/events`,
      headers: { "last-event-id": String(afterSeq) },
    });
    // 连接 1 的剩余流在放行前就开始监听（它只看到断点之后的事件，与连接 2 应完全一致）。
    const socket1Remainder = readUntil(
      socket1,
      (entries) => entries.at(-1)?.event.type === "task_status",
    );
    agent.gate.open();
    const response = await pending;

    const resumed = parseSseEntries(response.body);
    expect(resumed.length).toBeGreaterThan(0);
    expect(resumed[0]!.seq).toBe(afterSeq + 1);
    resumed.forEach((entry) => expect(entry.seq).toBeGreaterThan(afterSeq));
    expect(resumed.at(-1)!.event).toMatchObject({ type: "task_status", status: "succeeded" });

    // 连接 1 收到的剩余事件与连接 2 的续传结果完全一致（不丢不重）。
    const remainder = parseSseEntries(await socket1Remainder);
    expect(remainder).toEqual(resumed);
    socket1.destroy();
    await waitForTerminal(app, runId);
  });

  it("客户端断开只退订：任务继续运行至 succeeded，不中止", async () => {
    const agent = gatedFillAgent(1);
    const app = await createTestApplication("ste-events-disconnect-", now, {
      buildLlmPort: () => ({ streamFn: agent, model: fakeModel() }),
    });
    servers.push(app.server);
    const space = await setupSpace(app, FOUR_MESSAGES);
    const submitted = await submitFillTask(app, space.id, {
      from: 1,
      to: 4,
      blockSize: 4,
      config: LLM_CONFIG,
    });
    const runId = submitted.json().runId as string;

    const address = await app.server.listen({ host: "127.0.0.1", port: 0 });
    const port = Number(new URL(address).port);
    const socket = connectSse(port, `/memory-spaces/${space.id}/fill-tasks/${runId}/events`);
    // 等流真正建立（收到 block_start）后断开；不 gate.open()——断开不应影响挂起的 Agent。
    await readUntil(socket, (entries) => entries.some((e) => e.event.type === "block_start"));
    socket.destroy();

    // 断开后任务不被中止：任务行仍保持 running（agent 被 gate 挂起，本就不会自行结束）。
    await new Promise((resolve) => setTimeout(resolve, 300));
    const row = await app.context.database
      .selectFrom("memory_fill_tasks")
      .select("status")
      .where("run_id", "=", runId)
      .executeTakeFirst();
    expect(row?.status).toBe("running");
    // 放行后任务照常继续完成（若断开会中止 run，这里将走向 failed/cancelled）。
    agent.gate.open();
    const terminal = await waitForTerminal(app, runId);
    expect(terminal.status).toBe("succeeded");
  });

  it("状态事件可见：暂停→恢复后从下一块继续，事件序列完整", async () => {
    const agent = gatedFillAgent(1);
    const app = await createTestApplication("ste-events-pause-", now, {
      buildLlmPort: () => ({ streamFn: agent, model: fakeModel() }),
    });
    servers.push(app.server);
    const space = await setupSpace(app, SIX_MESSAGES);
    const submitted = await submitFillTask(app, space.id, {
      from: 1,
      to: 6,
      blockSize: 2,
      config: LLM_CONFIG,
    });
    const runId = submitted.json().runId as string;

    const address = await app.server.listen({ host: "127.0.0.1", port: 0 });
    const port = Number(new URL(address).port);
    const socket = connectSse(port, `/memory-spaces/${space.id}/fill-tasks/${runId}/events`);
    const blockStartBody = await readUntil(socket, (entries) =>
      entries.some((e) => e.event.type === "block_start"),
    );

    // 块 1 挂起期间请求暂停；放行后块 1 完成，安全点应用为 paused。
    const pausedResponse = await controlFillTask(app, space.id, runId, "pause");
    expect(pausedResponse.statusCode).toBe(200);
    agent.gate.open();
    const pausedBody = await readUntil(socket, (entries) =>
      entries.some((e) => e.event.type === "task_status" && e.event.status === "paused"),
    );
    // 恢复：running 事件 + 后续块继续。
    const resumedResponse = await controlFillTask(app, space.id, runId, "resume");
    expect(resumedResponse.statusCode).toBe(200);
    const succeededBody = await readUntil(socket, (entries) => {
      const last = entries.at(-1)?.event;
      return last?.type === "task_status" && last.status === "succeeded";
    });
    socket.destroy();

    // 多段读取各是上一段的延续：拼接成完整事件序列再断言。
    const entries = [
      ...parseSseEntries(blockStartBody),
      ...parseSseEntries(pausedBody),
      ...parseSseEntries(succeededBody),
    ];
    const statuses = entries.map((entry) => entry.event.type);
    expect(statuses).toContain("block_start");
    expect(entries.filter((entry) => entry.event.type === "block_start")).toHaveLength(3);
    expect(entries.filter((entry) => entry.event.type === "block_done")).toHaveLength(3);
    expect(entries.at(-1)!.event).toMatchObject({ type: "task_status", status: "succeeded" });
    // 顺序：块 1 完成 → paused → running → 块 2 → 块 3
    const types = entries.map((entry) => entry.event.type);
    const pausedIndex = types.indexOf("task_status");
    expect(types.slice(pausedIndex, pausedIndex + 2)).toEqual(["task_status", "task_status"]);
    expect(entries[pausedIndex]!.event).toMatchObject({ status: "paused" });
    expect(entries[pausedIndex + 1]!.event).toMatchObject({ status: "running" });
    // 暂停发生在块 1 之后、块 2 之前
    const blockDoneIndexes = types
      .map((type, index) => (type === "block_done" ? index : -1))
      .filter((index) => index >= 0);
    expect(blockDoneIndexes[0]).toBeLessThan(pausedIndex);
    expect(blockDoneIndexes[1]!).toBeGreaterThan(pausedIndex + 1);

    const terminal = await waitForTerminal(app, runId);
    expect(terminal.status).toBe("succeeded");
  });

  it("暂停后取消：paused → cancelled 收口，流关闭不挂空流", async () => {
    const agent = gatedFillAgent(1);
    const app = await createTestApplication("ste-events-cancel-", now, {
      buildLlmPort: () => ({ streamFn: agent, model: fakeModel() }),
    });
    servers.push(app.server);
    // 3 块（blockSize=2）：暂停/取消在块间安全点应用；单块任务最后一块提交后即成功，无暂停点。
    const space = await setupSpace(app, SIX_MESSAGES);
    const submitted = await submitFillTask(app, space.id, {
      from: 1,
      to: 6,
      blockSize: 2,
      config: LLM_CONFIG,
    });
    const runId = submitted.json().runId as string;

    const address = await app.server.listen({ host: "127.0.0.1", port: 0 });
    const port = Number(new URL(address).port);
    const socket = connectSse(port, `/memory-spaces/${space.id}/fill-tasks/${runId}/events`);
    await readUntil(socket, (entries) => entries.some((e) => e.event.type === "block_start"));

    const pausedResponse = await controlFillTask(app, space.id, runId, "pause");
    expect(pausedResponse.statusCode).toBe(200);
    agent.gate.open();
    await readUntil(socket, (entries) =>
      entries.some((e) => e.event.type === "task_status" && e.event.status === "paused"),
    );
    const cancelledResponse = await controlFillTask(app, space.id, runId, "cancel");
    expect(cancelledResponse.statusCode).toBe(200);

    const body = await readUntil(socket, (entries) => {
      const last = entries.at(-1)?.event;
      return last?.type === "task_status" && last.status === "cancelled";
    });
    const entries = parseSseEntries(body);
    expect(entries.at(-1)!.event).toMatchObject({ type: "task_status", status: "cancelled" });
    // 终态后服务端关闭流（不挂空流）
    await waitForClose(socket, 3_000);
    socket.destroy();

    const terminal = await waitForTerminal(app, runId);
    expect(terminal.status).toBe("cancelled");
  });

  it("tool 载荷超长截断：事件流中的 args 带 truncated 标记（入缓冲前执行）", async () => {
    const app = await createTestApplication("ste-events-truncate-", now, {
      buildLlmPort: () => ({ streamFn: slowHugeArgsFillAgent(300), model: fakeModel() }),
    });
    servers.push(app.server);
    const space = await setupSpace(app, FOUR_MESSAGES);
    const submitted = await submitFillTask(app, space.id, {
      from: 1,
      to: 4,
      blockSize: 4,
      config: LLM_CONFIG,
    });
    const runId = submitted.json().runId as string;

    const response = await app.server.inject({
      method: "GET",
      url: `/memory-spaces/${space.id}/fill-tasks/${runId}/events`,
    });
    const entries = parseSseEntries(response.body);
    const toolStart = entries.find((entry) => entry.event.type === "tool_start")!.event;
    expect(toolStart).toMatchObject({ name: MUTATE_TOOL_NAME });
    expect(toolStart).toMatchObject({ args: { truncated: true } });
    const prefix = (toolStart as { args: { prefix: string } }).args.prefix;
    expect(prefix.length).toBe(MAX_TOOL_PAYLOAD_CHARS);
    expect(prefix).toContain('"op":"create"');
    await waitForTerminal(app, runId);
  });

  it("404：runId 不存在或不属于该记忆空间", async () => {
    const app = await createTestApplication("ste-events-404-", now, {
      buildLlmPort: () => ({ streamFn: scriptedStreamFn(fillAgentRespond), model: fakeModel() }),
    });
    servers.push(app.server);
    const spaceA = await setupSpace(app, FOUR_MESSAGES);
    const spaceB = await app.memorySpaces.create({
      name: "另一个会话",
      chat: parseSillyTavernJsonl(FOUR_MESSAGES),
    });
    const submitted = await submitFillTask(app, spaceA.id, {
      from: 1,
      to: 4,
      blockSize: 4,
      config: LLM_CONFIG,
    });
    const runId = submitted.json().runId as string;

    const unknown = await app.server.inject({
      method: "GET",
      url: `/memory-spaces/${spaceA.id}/fill-tasks/does-not-exist/events`,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ type: "fill_task_not_found" });

    const wrongSpace = await app.server.inject({
      method: "GET",
      url: `/memory-spaces/${spaceB.id}/fill-tasks/${runId}/events`,
    });
    expect(wrongSpace.statusCode).toBe(404);
    expect(wrongSpace.json()).toMatchObject({ type: "fill_task_not_found" });

    await waitForTerminal(app, runId);
  });
});
