import type { MemorySpaceId, MemoryTableId, UpdateMemoryTableInput } from "@ste-memory/core";
import type { FastifyInstance } from "fastify";
import type { MemorySpaceManager } from "../memory-spaces/types.ts";
import type { MemoryTableManager } from "./types.ts";

interface SpaceParams {
  readonly spaceId: string;
}

interface CreateBody {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly prompt?: unknown;
}

interface TableParams extends SpaceParams {
  readonly tableId: string;
}

interface UpdateBody extends CreateBody {
  readonly enabled?: unknown;
}

export function registerMemoryTableRoutes(
  server: FastifyInstance,
  memorySpaces: MemorySpaceManager,
  memoryTables: MemoryTableManager,
): void {
  server.get<{ Params: SpaceParams }>("/memory-spaces/:spaceId/tables", async (request, reply) => {
    const memorySpaceId = request.params.spaceId as MemorySpaceId;
    if (!memorySpaces.exists(memorySpaceId)) {
      return reply.code(404).send({ message: "记忆空间不存在" });
    }
    return memoryTables.list(memorySpaceId);
  });

  server.post<{ Params: SpaceParams; Body: CreateBody }>(
    "/memory-spaces/:spaceId/tables",
    async (request, reply) => {
      if (typeof request.body?.name !== "string") {
        return reply.code(400).send({ message: "记忆表格名称不能为空" });
      }
      if (request.body.description !== undefined && typeof request.body.description !== "string") {
        return reply.code(400).send({ message: "记忆表格描述必须是文本" });
      }
      if (request.body.prompt !== undefined && typeof request.body.prompt !== "string") {
        return reply.code(400).send({ message: "记忆表格 Prompt 必须是文本" });
      }
      const created = memoryTables.createCustom(request.params.spaceId as MemorySpaceId, {
        name: request.body.name,
        description: request.body.description ?? "",
        prompt: request.body.prompt ?? "",
      });
      return created
        ? reply.code(201).send(created)
        : reply.code(404).send({ message: "记忆空间不存在" });
    },
  );

  server.get<{ Params: TableParams }>(
    "/memory-spaces/:spaceId/tables/:tableId",
    async (request, reply) => {
      const table = memoryTables.find(
        request.params.spaceId as MemorySpaceId,
        request.params.tableId as MemoryTableId,
      );
      return table ?? reply.code(404).send({ message: "记忆表格不存在" });
    },
  );

  server.patch<{ Params: TableParams; Body: UpdateBody }>(
    "/memory-spaces/:spaceId/tables/:tableId",
    async (request, reply) => {
      if (request.body?.name !== undefined && typeof request.body.name !== "string") {
        return reply.code(400).send({ message: "记忆表格名称必须是文本" });
      }
      if (request.body?.description !== undefined && typeof request.body.description !== "string") {
        return reply.code(400).send({ message: "记忆表格描述必须是文本" });
      }
      if (request.body?.prompt !== undefined && typeof request.body.prompt !== "string") {
        return reply.code(400).send({ message: "记忆表格 Prompt 必须是文本" });
      }
      if (request.body?.enabled !== undefined && typeof request.body.enabled !== "boolean") {
        return reply.code(400).send({ message: "记忆表格启用状态必须是布尔值" });
      }
      const input: UpdateMemoryTableInput = {
        name: request.body?.name,
        description: request.body?.description,
        prompt: request.body?.prompt,
        enabled: request.body?.enabled,
      };
      const updated = memoryTables.update(
        request.params.spaceId as MemorySpaceId,
        request.params.tableId as MemoryTableId,
        input,
      );
      return updated ?? reply.code(404).send({ message: "记忆表格不存在" });
    },
  );

  server.delete<{ Params: TableParams }>(
    "/memory-spaces/:spaceId/tables/:tableId",
    async (request, reply) => {
      const deleted = memoryTables.delete(
        request.params.spaceId as MemorySpaceId,
        request.params.tableId as MemoryTableId,
      );
      return deleted ? reply.code(204).send() : reply.code(404).send({ message: "记忆表格不存在" });
    },
  );
}
