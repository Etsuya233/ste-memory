/**
 * 填表任务端点（ticket 13/14/16）：
 *
 * - POST /memory-spaces/:spaceId/fill-tasks：提交后台填表任务（202 + 任务视图）；
 *   冲突（该空间已有非终态任务）409 携带当前任务；空间不存在 404；范围/配置无效 400。
 * - GET /memory-spaces/:spaceId/fill-tasks/active：当前非终态任务（无则 null）。
 * - GET /memory-spaces/:spaceId/fill-tasks/:runId/events（ticket 16）：SSE 实时运行输出，
 *   先回放缓冲再实时转发；Last-Event-ID 断线续传；终态 task_status 后关闭流。
 *
 * 任务轮询、暂停/恢复/中止等完整状态接口归 ticket 14。
 */
import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { FastifyInstance, FastifyReply } from "fastify";
import { LlmConfigError } from "../../../../application/chat/llm-config.ts";
import {
  FillTaskConflictError,
  FillTaskNotFoundError,
  FillTaskRangeError,
  FillTaskSpaceNotFoundError,
  FillTaskStateError,
} from "../../../../application/fill-tasks/fill-task-service.ts";
import type { FillTaskManager } from "../../../../application/ports/fill-task-manager.ts";
import type { LlmWebConfig } from "../../../../application/chat/llm-config.ts";
import {
  isTerminalFillTaskStatus,
  type AgentRunEventEntry,
  type FillTaskEventBus,
} from "../../../../application/ports/fill-task-events.ts";
import { streamSse } from "../sse.ts";

interface SpaceIdParams {
  readonly spaceId: string;
}

interface SpaceIdRunIdParams {
  readonly spaceId: string;
  readonly runId: string;
}

interface SubmitBody {
  readonly from?: unknown;
  readonly to?: unknown;
  readonly blockSize?: unknown;
  readonly config?: unknown;
}

export function registerFillTaskRoutes(
  server: FastifyInstance,
  fillTasks: FillTaskManager,
  events: FillTaskEventBus,
): void {
  server.get<{ Params: SpaceIdParams }>(
    "/memory-spaces/:spaceId/fill-tasks/active",
    async (request) => {
      const task = await fillTasks.activeTask(request.params.spaceId as MemorySpaceId);
      return { task: task ?? null };
    },
  );

  server.post<{ Params: SpaceIdParams; Body: SubmitBody }>(
    "/memory-spaces/:spaceId/fill-tasks",
    async (request, reply) => {
      try {
        const task = await fillTasks.submit({
          memorySpaceId: request.params.spaceId as MemorySpaceId,
          from: asFiniteNumber(request.body?.from),
          to: asFiniteNumber(request.body?.to),
          blockSize: asOptionalFiniteNumber(request.body?.blockSize),
          config: asWebConfig(request.body?.config),
        });
        return reply.code(202).send(task);
      } catch (error) {
        return submitErrorResponse(error, reply);
      }
    },
  );

  // 任务控制（ticket 14）：请求状态先落库，任务循环在安全点应用；
  // 非法状态转换 409 携带当前任务，任务不存在/不属于该空间 404。
  for (const action of ["pause", "resume", "cancel"] as const) {
    server.post<{ Params: SpaceIdRunIdParams }>(
      `/memory-spaces/:spaceId/fill-tasks/:runId/${action}`,
      async (request, reply) => {
        try {
          const task = await fillTasks[action](
            request.params.spaceId as MemorySpaceId,
            request.params.runId,
          );
          return reply.code(200).send(task);
        } catch (error) {
          return controlErrorResponse(error, reply);
        }
      },
    );
  }

  // 实时运行输出（ticket 16）：订阅事件流，先回放缓冲再实时转发。
  // 任务不存在/不属于该空间在 SSE 头之前返回 404；终态 task_status 后正常关闭。
  server.get<{ Params: SpaceIdRunIdParams }>(
    "/memory-spaces/:spaceId/fill-tasks/:runId/events",
    async (request, reply) => {
      const spaceId = request.params.spaceId as MemorySpaceId;
      const runId = request.params.runId;
      const afterSeq = parseLastEventId(request.headers["last-event-id"]);
      // 先订阅（含缓冲回放）：流接管前到达的事件先入 pending，流启动后按序冲刷。
      const pending: AgentRunEventEntry[] = [];
      let streaming = false;
      let sendEntry: ((entry: AgentRunEventEntry) => void) | undefined;
      const unsubscribe = await events.subscribe(spaceId, runId, afterSeq, (entry) => {
        if (streaming) sendEntry?.(entry);
        else pending.push(entry);
      });
      if (unsubscribe === undefined) {
        return reply.code(404).send({ type: "fill_task_not_found", message: "填表任务不存在" });
      }

      await streamSse(
        request,
        reply,
        (send, signal) =>
          new Promise<void>((resolve) => {
            let finished = false;
            const finish = () => {
              if (finished) return;
              finished = true;
              unsubscribe();
              resolve();
            };
            // 客户端断开只退订，绝不中止任务（与 chat 的断开即中止相反）；
            // 中止仍经 POST .../cancel 控制端点在安全点生效。
            signal.addEventListener("abort", finish, { once: true });
            sendEntry = (entry) => {
              send(entry, { id: String(entry.seq) });
              if (isTerminalFillTaskStatus(entry.event)) finish();
            };
            streaming = true;
            for (const entry of pending) sendEntry(entry);
          }),
      );
    },
  );
}

/** Last-Event-ID 解析：非正整数视为未提供（回放全部缓冲）。 */
function parseLastEventId(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function asFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

/** 可选数字：缺省/非数字视为未提供（服务端用默认值）；显式非法值（如 0）原样传递由服务端校验。 */
function asOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asWebConfig(value: unknown): LlmWebConfig | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const config = value as Record<string, unknown>;
  const pick = (key: string): string | undefined =>
    typeof config[key] === "string" ? (config[key] as string) : undefined;
  return { baseUrl: pick("baseUrl"), model: pick("model"), apiKey: pick("apiKey") };
}

function submitErrorResponse(error: unknown, reply: FastifyReply) {
  if (error instanceof FillTaskConflictError) {
    return reply.code(409).send({
      type: "fill_task_conflict",
      message: error.message,
      task: error.task,
    });
  }
  if (error instanceof FillTaskSpaceNotFoundError) {
    return reply.code(404).send({ type: "fill_task_space_not_found", message: error.message });
  }
  if (error instanceof FillTaskRangeError) {
    return reply.code(400).send({ type: "fill_task_range_invalid", message: error.message });
  }
  if (error instanceof LlmConfigError) {
    return reply
      .code(400)
      .send({ type: "llm_config_error", field: error.field, message: error.message });
  }
  throw error;
}

function controlErrorResponse(error: unknown, reply: FastifyReply) {
  if (error instanceof FillTaskNotFoundError) {
    return reply.code(404).send({ type: "fill_task_not_found", message: error.message });
  }
  if (error instanceof FillTaskStateError) {
    return reply.code(409).send({
      type: "fill_task_state_invalid",
      message: error.message,
      task: error.task,
    });
  }
  throw error;
}
