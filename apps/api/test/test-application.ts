import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { DatabaseContext } from "../src/database/database-context.ts";
import { createDatabase } from "../src/database/database.ts";
import { KyselyUnitOfWork } from "../src/database/kysely-unit-of-work.ts";
import { migrateDatabase } from "../src/database/migrate.ts";
import { KyselyDatabaseHealthCheck } from "../src/health/database-health-check.ts";
import { DefaultMemorySpaceManager } from "../src/memory-spaces/manager.ts";
import { KyselyMemoryFieldRepository } from "../src/persistence/memory-field-repository.ts";
import { KyselyMemoryRecordRepository } from "../src/persistence/memory-record-repository.ts";
import { KyselyMemorySpaceRepository } from "../src/persistence/memory-space-repository.ts";
import { KyselyMemoryTableRepository } from "../src/persistence/memory-table-repository.ts";
import { buildServer } from "../src/server.ts";
import { KyselySourceChatRepository } from "../src/source-store/repository.ts";
import { SystemMemoryTableInstaller } from "../src/system-memory/system-memory-table-definitions.ts";

export async function createTestApplication(prefix: string, timestamp: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const database = createDatabase(`sqlite:${join(directory, "application.sqlite")}`);
  await migrateDatabase(database);
  const context = new DatabaseContext(database);
  const unitOfWork = new KyselyUnitOfWork(database, context);
  const spaceRepository = new KyselyMemorySpaceRepository(context);
  const tableRepository = new KyselyMemoryTableRepository(context);
  const fieldRepository = new KyselyMemoryFieldRepository(context);
  const recordRepository = new KyselyMemoryRecordRepository(context, unitOfWork);
  const spaces = new MemorySpaceService(
    spaceRepository,
    () => randomUUID() as MemorySpaceId,
    () => timestamp,
  );
  const tables = new MemoryTableService(
    spaceRepository,
    tableRepository,
    () => randomUUID() as MemoryTableId,
    () => timestamp,
  );
  const fields = new MemoryFieldService(
    tableRepository,
    fieldRepository,
    () => randomUUID() as MemoryFieldId,
    () => timestamp,
  );
  const systemTables = new SystemMemoryTableInstaller(tables, fields);
  const memorySpaces = new DefaultMemorySpaceManager(
    spaces,
    systemTables,
    new KyselySourceChatRepository(context, unitOfWork),
    unitOfWork,
  );
  const server = await buildServer({
    database: new KyselyDatabaseHealthCheck(context),
    memorySpaces,
    memoryTables: tables,
    memoryFields: fields,
    memoryRecords: new MemoryRecordService(
      tableRepository,
      fieldRepository,
      recordRepository,
      () => randomUUID() as MemoryRecordId,
      () => randomUUID() as MemoryRecordHistoryId,
      () => randomUUID() as MemoryRevisionId,
      () => timestamp,
    ),
  });
  server.addHook("onClose", async () => database.destroy());
  return {
    server,
    database,
    context,
    unitOfWork,
    spaces,
    tables,
    fields,
    systemTables,
    memorySpaces,
    spaceRepository,
    tableRepository,
    fieldRepository,
    recordRepository,
  };
}
