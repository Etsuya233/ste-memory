import type {
  MemoryRecordId,
  MemoryRecordSource,
  MemoryRevisionId,
  MemorySpaceId,
  MemoryTableId,
  QueryRecordsInput,
} from "@ste-memory/core/memory";
import type { FastifyInstance } from "fastify";
import type { MemoryRecordManager } from "../../../../application/ports/memory-record.ts";
import type { MemoryRecordQueryManager } from "../../../../application/ports/memory-record-query.ts";

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

interface UpdateBody {
  readonly expectedRevisionId?: unknown;
  readonly patch?: unknown;
}

interface DeleteBody {
  readonly expectedRevisionId?: unknown;
}

interface HistoryQuery {
  readonly tableId?: string;
  readonly recordId?: string;
  readonly revisionId?: string;
  readonly archivedFrom?: string;
  readonly archivedTo?: string;
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
  memoryRecordQueries: MemoryRecordQueryManager,
): void {
  server.post<{ Params: Pick<RecordParams, "spaceId">; Body: QueryRecordsInput }>(
    "/memory-spaces/:spaceId/query-records",
    async (request) =>
      memoryRecordQueries.query(request.params.spaceId as MemorySpaceId, request.body),
  );
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
      const created = await memoryRecords.create(
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
      const result = await memoryRecords.list(
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
      const record = await memoryRecords.find(
        request.params.spaceId as MemorySpaceId,
        request.params.tableId as MemoryTableId,
        request.params.recordId as MemoryRecordId,
      );
      return record ?? reply.code(404).send({ message: "记忆记录不存在" });
    },
  );

  server.patch<{ Params: RecordParams; Body: UpdateBody }>(
    "/memory-spaces/:spaceId/tables/:tableId/records/:recordId",
    async (request, reply) => {
      if (
        typeof request.body?.expectedRevisionId !== "string" ||
        request.body.expectedRevisionId.length === 0 ||
        typeof request.body.patch !== "object" ||
        request.body.patch === null ||
        Array.isArray(request.body.patch)
      ) {
        return reply
          .code(400)
          .send({ message: "更新记录需要 expectedRevisionId 和对象形式的 patch" });
      }
      const updated = await memoryRecords.update(
        request.params.spaceId as MemorySpaceId,
        request.params.tableId as MemoryTableId,
        request.params.recordId as MemoryRecordId,
        {
          expectedRevisionId: request.body.expectedRevisionId as MemoryRevisionId,
          patch: request.body.patch as Record<string, unknown>,
          revisionSource: "user",
        },
      );
      return updated ?? reply.code(404).send({ message: "记忆记录不存在" });
    },
  );

  server.delete<{ Params: RecordParams; Body: DeleteBody }>(
    "/memory-spaces/:spaceId/tables/:tableId/records/:recordId",
    async (request, reply) => {
      if (
        typeof request.body?.expectedRevisionId !== "string" ||
        request.body.expectedRevisionId.length === 0
      ) {
        return reply.code(400).send({ message: "删除记录需要 expectedRevisionId" });
      }
      const removed = await memoryRecords.delete(
        request.params.spaceId as MemorySpaceId,
        request.params.tableId as MemoryTableId,
        request.params.recordId as MemoryRecordId,
        request.body.expectedRevisionId as MemoryRevisionId,
        "user",
      );
      return removed ? reply.code(204).send() : reply.code(404).send({ message: "记忆记录不存在" });
    },
  );

  server.get<{ Params: Pick<RecordParams, "spaceId">; Querystring: HistoryQuery }>(
    "/memory-spaces/:spaceId/record-history",
    async (request, reply) => {
      const invalidTime = [request.query.archivedFrom, request.query.archivedTo].find(
        (value) => value !== undefined && Number.isNaN(Date.parse(value)),
      );
      if (invalidTime !== undefined) {
        return reply.code(400).send({ message: "历史时间筛选必须是有效的日期时间" });
      }
      return memoryRecords.listHistory(request.params.spaceId as MemorySpaceId, {
        tableId: request.query.tableId as MemoryTableId | undefined,
        recordId: request.query.recordId as MemoryRecordId | undefined,
        revisionId: request.query.revisionId as MemoryRevisionId | undefined,
        archivedFrom:
          request.query.archivedFrom === undefined
            ? undefined
            : new Date(request.query.archivedFrom).toISOString(),
        archivedTo:
          request.query.archivedTo === undefined
            ? undefined
            : new Date(request.query.archivedTo).toISOString(),
      });
    },
  );
}
