import { randomUUID } from "node:crypto";
import {
  MemorySpaceService,
  MemoryTableService,
  type MemorySpaceId,
  type MemoryTableId,
} from "@ste-memory/core";
import { SqliteMemorySpaceRepository, SqliteMemoryTableRepository } from "@ste-memory/core-sqlite";
import { loadConfig } from "./config.ts";
import { SqliteDatabaseHealthCheck } from "./health/sqlite-database-health-check.ts";
import { DefaultMemorySpaceManager } from "./memory-spaces/manager.ts";
import { buildServer } from "./server.ts";
import { SqliteSourceChatRepository } from "./source-store/repository.ts";

export async function startApi(environment: NodeJS.ProcessEnv): Promise<void> {
  const config = loadConfig(environment);
  const memorySpaceRepository = new SqliteMemorySpaceRepository(config.coreDatabaseUrl);
  const memoryTableService = new MemoryTableService(
    memorySpaceRepository,
    new SqliteMemoryTableRepository(config.coreDatabaseUrl),
    () => randomUUID() as MemoryTableId,
    () => new Date().toISOString(),
  );
  const memorySpaces = new DefaultMemorySpaceManager(
    new MemorySpaceService(
      memorySpaceRepository,
      () => randomUUID() as MemorySpaceId,
      () => new Date().toISOString(),
    ),
    new SqliteSourceChatRepository(config.sourceStoreDatabaseUrl),
  );
  const server = await buildServer({
    coreDatabase: new SqliteDatabaseHealthCheck(config.coreDatabaseUrl),
    sourceStoreDatabase: new SqliteDatabaseHealthCheck(config.sourceStoreDatabaseUrl),
    memorySpaces,
    memoryTables: memoryTableService,
  });

  await server.listen({ host: config.host, port: config.port });
}

if (import.meta.main) {
  await startApi(process.env);
}
