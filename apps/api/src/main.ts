import { randomUUID } from "node:crypto";
import { MemorySpaceService, type MemorySpaceId } from "@ste-memory/core";
import { SqliteMemorySpaceRepository } from "@ste-memory/core-sqlite";
import { loadConfig } from "./config.ts";
import { SqliteDatabaseHealthCheck } from "./health/sqlite-database-health-check.ts";
import { DefaultMemorySpaceManager } from "./memory-spaces/manager.ts";
import { buildServer } from "./server.ts";
import { SqliteSourceChatRepository } from "./source-store/repository.ts";

export async function startApi(environment: NodeJS.ProcessEnv): Promise<void> {
  const config = loadConfig(environment);
  const memorySpaces = new DefaultMemorySpaceManager(
    new MemorySpaceService(
      new SqliteMemorySpaceRepository(config.coreDatabaseUrl),
      () => randomUUID() as MemorySpaceId,
      () => new Date().toISOString(),
    ),
    new SqliteSourceChatRepository(config.sourceStoreDatabaseUrl),
  );
  const server = await buildServer({
    coreDatabase: new SqliteDatabaseHealthCheck(config.coreDatabaseUrl),
    sourceStoreDatabase: new SqliteDatabaseHealthCheck(config.sourceStoreDatabaseUrl),
    memorySpaces,
  });

  await server.listen({ host: config.host, port: config.port });
}

if (import.meta.main) {
  await startApi(process.env);
}
