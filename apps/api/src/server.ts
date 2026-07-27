import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { DatabaseHealthCheck, SystemHealth } from "@ste-memory/core";

export interface ServerDependencies {
  readonly coreDatabase: DatabaseHealthCheck;
  readonly sourceStoreDatabase: DatabaseHealthCheck;
}

export async function buildServer(dependencies: ServerDependencies): Promise<FastifyInstance> {
  const server = Fastify({ logger: true });
  await server.register(cors, {
    origin: /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/,
  });

  server.get("/health", async (): Promise<SystemHealth> => ({
    api: "ok",
    databases: {
      core: dependencies.coreDatabase.check(),
      sourceStore: dependencies.sourceStoreDatabase.check(),
    },
  }));

  return server;
}
