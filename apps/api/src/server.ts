import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { DomainError, type DomainErrorType } from "@ste-memory/core";
import Fastify, { type FastifyInstance } from "fastify";
import type { DatabaseHealthCheck, SystemHealth } from "./health/types.ts";
import { registerMemorySpaceRoutes } from "./memory-spaces/routes.ts";
import type { MemorySpaceManager } from "./memory-spaces/types.ts";

export interface ServerDependencies {
  readonly coreDatabase: DatabaseHealthCheck;
  readonly sourceStoreDatabase: DatabaseHealthCheck;
  readonly memorySpaces: MemorySpaceManager;
}

const domainErrorMessages: Record<DomainErrorType, string> = {
  memory_space_name_required: "记忆空间名称不能为空",
  memory_space_name_too_long: "记忆空间名称不能超过 120 个字符",
};

export async function buildServer(dependencies: ServerDependencies): Promise<FastifyInstance> {
  const server = Fastify({ logger: true });
  await server.register(cors, {
    origin: /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/,
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  await server.register(multipart, {
    limits: { files: 1, fileSize: 50 * 1024 * 1024, fields: 1 },
  });

  server.setErrorHandler((error: Error, _request, reply) => {
    if (error instanceof DomainError) {
      return reply.code(400).send({
        type: error.type,
        param: error.param,
        message: domainErrorMessages[error.type],
      });
    }
    return reply.send(error);
  });

  server.get("/health", async (): Promise<SystemHealth> => ({
    api: "ok",
    databases: {
      core: dependencies.coreDatabase.check(),
      sourceStore: dependencies.sourceStoreDatabase.check(),
    },
  }));
  registerMemorySpaceRoutes(server, dependencies.memorySpaces);

  return server;
}
