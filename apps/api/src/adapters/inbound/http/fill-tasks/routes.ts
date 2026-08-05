/**
 * 填表任务端点（ticket 13）：
 *
 * - POST /memory-spaces/:spaceId/fill-tasks：提交后台填表任务（202 + 任务视图）；
 *   冲突（该空间已有非终态任务）409 携带当前任务；空间不存在 404；范围/配置无效 400。
 * - GET /memory-spaces/:spaceId/fill-tasks/active：当前非终态任务（无则 null）。
 *
 * 任务轮询、暂停/恢复/中止等完整状态接口归 ticket 14。
 */
import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { FastifyInstance, FastifyReply } from "fastify";
import { LlmConfigError } from "../../../../application/chat/llm-config.ts";
import {
  FillTaskConflictError,
  FillTaskRangeError,
  FillTaskSpaceNotFoundError,
} from "../../../../application/fill-tasks/fill-task-service.ts";
import type { FillTaskManager } from "../../../../application/ports/fill-task-manager.ts";
import type { LlmWebConfig } from "../../../../application/chat/llm-config.ts";

interface SpaceIdParams {
  readonly spaceId: string;
}

interface SubmitBody {
  readonly from?: unknown;
  readonly to?: unknown;
  readonly blockSize?: unknown;
  readonly config?: unknown;
}

export function registerFillTaskRoutes(server: FastifyInstance, fillTasks: FillTaskManager): void {
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
