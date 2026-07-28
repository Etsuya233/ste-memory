import { randomUUID } from "node:crypto";
import {
  MemorySpaceService,
  MemoryFieldService,
  MemoryRecordService,
  type MemoryFieldId,
  type MemoryRecordId,
  type MemoryRecordHistoryId,
  type MemoryRevisionId,
  MemoryTableService,
  type MemorySpaceId,
  type MemoryTableId,
} from "@ste-memory/core";
import {
  SqliteMemoryFieldRepository,
  SqliteMemoryRecordRepository,
  SqliteMemorySpaceRepository,
  SqliteMemoryTableRepository,
} from "@ste-memory/core-sqlite";
import { loadConfig } from "./config.ts";
import { SqliteDatabaseHealthCheck } from "./health/sqlite-database-health-check.ts";
import { DefaultMemorySpaceManager } from "./memory-spaces/manager.ts";
import { SystemMemoryTableInstaller } from "./system-memory/system-memory-table-definitions.ts";
import { buildServer } from "./server.ts";
import { SqliteSourceChatRepository } from "./source-store/repository.ts";

export async function startApi(environment: NodeJS.ProcessEnv): Promise<void> {
  const config = loadConfig(environment);
  const memorySpaceRepository = new SqliteMemorySpaceRepository(config.coreDatabaseUrl);
  const memoryTableRepository = new SqliteMemoryTableRepository(config.coreDatabaseUrl);
  const memoryTableService = new MemoryTableService(
    memorySpaceRepository,
    memoryTableRepository,
    () => randomUUID() as MemoryTableId,
    () => new Date().toISOString(),
  );
  const memoryFieldService = new MemoryFieldService(
    memoryTableRepository,
    new SqliteMemoryFieldRepository(config.coreDatabaseUrl),
    () => randomUUID() as MemoryFieldId,
    () => new Date().toISOString(),
  );
  const memorySpaces = new DefaultMemorySpaceManager(
    new MemorySpaceService(
      memorySpaceRepository,
      () => randomUUID() as MemorySpaceId,
      () => new Date().toISOString(),
    ),
    new SystemMemoryTableInstaller(memoryTableService, memoryFieldService),
    new SqliteSourceChatRepository(config.sourceStoreDatabaseUrl),
  );
  const server = await buildServer({
    coreDatabase: new SqliteDatabaseHealthCheck(config.coreDatabaseUrl),
    sourceStoreDatabase: new SqliteDatabaseHealthCheck(config.sourceStoreDatabaseUrl),
    memorySpaces,
    memoryTables: memoryTableService,
    memoryFields: memoryFieldService,
    memoryRecords: new MemoryRecordService(
      memoryTableRepository,
      new SqliteMemoryFieldRepository(config.coreDatabaseUrl),
      new SqliteMemoryRecordRepository(config.coreDatabaseUrl),
      () => randomUUID() as MemoryRecordId,
      () => randomUUID() as MemoryRecordHistoryId,
      () => randomUUID() as MemoryRevisionId,
      () => new Date().toISOString(),
    ),
  });

  await server.listen({ host: config.host, port: config.port });
}

if (import.meta.main) {
  await startApi(process.env);
}
