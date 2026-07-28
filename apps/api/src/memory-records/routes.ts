import type {
  MemoryRecordId,
  MemoryRecordSource,
  MemorySpaceId,
  MemoryTableId,
} from "@ste-memory/core";
import type { FastifyInstance } from "fastify";
import type { MemoryRecordManager } from "./types.ts";

interface RecordParams {
  readonly spaceId: string;
  readonly tableId: string;
  readonly recordId: string;
}

interface ListQuery {
  readonly page?: string;
  readonly pageSize?: string;
  readonly search?: string;
}

interface CreateBody {
  readonly payload?: unknown;
  readonly source?: unknown;
}

function recordSource(value: unknown): MemoryRecordSource | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("记录来源格式无效");
  }
  const source = value as Record<string, unknown>;
  if (source.type === "manual" && Object.keys(source).length === 1) return { type: "manual" };
  if (
    source.type === "source" &&
    (source.sourceTime === null || typeof source.sourceTime === "string") &&
    (source.sourceLocation === null || typeof source.sourceLocation === "string")
  ) {
    return {
      type: "source",
      sourceTime: source.sourceTime,
      sourceLocation: source.sourceLocation,
    };
  }
  throw new Error("记录来源格式无效");
}

export function registerMemoryRecordRoutes(
  server: FastifyInstance,
  memoryRecords: MemoryRecordManager,
): void {
  server.post<{ Params: Omit<RecordParams, "recordId">; Body: CreateBody }>(
    "/memory-spaces/:spaceId/tables/:tableId/records",
    async (request, reply) => {
      if (
        typeof request.body?.payload !== "object" ||
        request.body.payload === null ||
        Array.isArray(request.body.payload)
      ) {
        return reply.code(400).send({ message: "记录 payload 必须是对象" });
      }
      let source: MemoryRecordSource | undefined;
      try {
        source = recordSource(request.body.source);
      } catch (error) {
        return reply.code(400).send({ message: (error as Error).message });
      }
      const created = memoryRecords.create(
        request.params.spaceId as MemorySpaceId,
        request.params.tableId as MemoryTableId,
        { payload: request.body.payload as Record<string, unknown>, source },
      );
      return created
        ? reply.code(201).send(created)
        : reply.code(404).send({ message: "记忆表格不存在" });
    },
  );

  server.get<{ Params: Omit<RecordParams, "recordId">; Querystring: ListQuery }>(
    "/memory-spaces/:spaceId/tables/:tableId/records",
    async (request, reply) => {
      const result = memoryRecords.list(
        request.params.spaceId as MemorySpaceId,
        request.params.tableId as MemoryTableId,
        {
          page: request.query.page === undefined ? 1 : Number(request.query.page),
          pageSize: request.query.pageSize === undefined ? 20 : Number(request.query.pageSize),
          search: request.query.search,
        },
      );
      return result ?? reply.code(404).send({ message: "记忆表格不存在" });
    },
  );

  server.get<{ Params: RecordParams }>(
    "/memory-spaces/:spaceId/tables/:tableId/records/:recordId",
    async (request, reply) => {
      const record = memoryRecords.find(
        request.params.spaceId as MemorySpaceId,
        request.params.tableId as MemoryTableId,
        request.params.recordId as MemoryRecordId,
      );
      return record ?? reply.code(404).send({ message: "记忆记录不存在" });
    },
  );
}
