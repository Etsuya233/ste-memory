import { randomUUID } from "node:crypto";
import {
  MemoryFieldService,
  MemoryRecordService,
  MemorySpaceService,
  MemoryTableService,
  type MemoryFieldId,
  type MemoryRecordHistoryId,
  type MemoryRecordId,
  type MemoryRevisionId,
  type MemorySpaceId,
  type MemoryTableId,
} from "@ste-memory/core";
import { loadConfig } from "./config.ts";
import { DatabaseContext } from "./database/database-context.ts";
import { createDatabase } from "./database/database.ts";
import { KyselyUnitOfWork } from "./database/kysely-unit-of-work.ts";
import { KyselyDatabaseHealthCheck } from "./health/database-health-check.ts";
import { DefaultMemorySpaceManager } from "./memory-spaces/manager.ts";
import { KyselyMemoryFieldRepository } from "./persistence/memory-field-repository.ts";
import { KyselyMemoryRecordRepository } from "./persistence/memory-record-repository.ts";
import { KyselyMemorySpaceRepository } from "./persistence/memory-space-repository.ts";
import { KyselyMemoryTableRepository } from "./persistence/memory-table-repository.ts";
import { buildServer } from "./server.ts";
import { KyselySourceChatRepository } from "./source-store/repository.ts";
import { SystemMemoryTableInstaller } from "./system-memory/system-memory-table-definitions.ts";

export async function startApi(environment: NodeJS.ProcessEnv): Promise<void> {
  const config = loadConfig(environment);
  const database = createDatabase(config.databaseUrl);
  try {
    const context = new DatabaseContext(database);
    const unitOfWork = new KyselyUnitOfWork(database, context);
    const memorySpaceRepository = new KyselyMemorySpaceRepository(context);
    const memoryTableRepository = new KyselyMemoryTableRepository(context);
    const memoryFieldRepository = new KyselyMemoryFieldRepository(context);
    const memoryRecordRepository = new KyselyMemoryRecordRepository(context, unitOfWork);
    const memoryTableService = new MemoryTableService(
      memorySpaceRepository,
      memoryTableRepository,
      () => randomUUID() as MemoryTableId,
      () => new Date().toISOString(),
    );
    const memoryFieldService = new MemoryFieldService(
      memoryTableRepository,
      memoryFieldRepository,
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
      new KyselySourceChatRepository(context, unitOfWork),
      unitOfWork,
    );
    const server = await buildServer({
      database: new KyselyDatabaseHealthCheck(context),
      memorySpaces,
      memoryTables: memoryTableService,
      memoryFields: memoryFieldService,
      memoryRecords: new MemoryRecordService(
        memoryTableRepository,
        memoryFieldRepository,
        memoryRecordRepository,
        () => randomUUID() as MemoryRecordId,
        () => randomUUID() as MemoryRecordHistoryId,
        () => randomUUID() as MemoryRevisionId,
        () => new Date().toISOString(),
      ),
    });
    server.addHook("onClose", async () => database.destroy());
    await server.listen({ host: config.host, port: config.port });
  } catch (error) {
    await database.destroy();
    throw error;
  }
}

if (import.meta.main) await startApi(process.env);
