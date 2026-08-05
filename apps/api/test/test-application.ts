import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryFieldService,
  MemoryRecordQueryService,
  MemoryRecordService,
  MemorySpaceService,
  MemoryTableService,
  computeMemoryRecordDisplayText,
  type MemoryEvidenceId,
  type MemoryFieldId,
  type MemoryRecordHistoryId,
  type MemoryRecordId,
  type MemoryRevisionId,
  type MemorySpaceId,
  type MemoryTableId,
} from "@ste-memory/core/memory";
import { DatabaseContext } from "../src/adapters/outbound/sqlite/database/database-context.ts";
import { createDatabase } from "../src/adapters/outbound/sqlite/database/database.ts";
import { KyselyUnitOfWork } from "../src/adapters/outbound/sqlite/database/kysely-unit-of-work.ts";
import { migrateDatabase } from "../src/adapters/outbound/sqlite/database/migrate.ts";
import { KyselyDatabaseHealthCheck } from "../src/adapters/outbound/sqlite/database/database-health-check.ts";
import { DefaultMemorySpaceManager } from "../src/application/memory-spaces/manager.ts";
import { KyselyMemoryFieldRepository } from "../src/adapters/outbound/sqlite/memory/memory-field-repository.ts";
import { KyselyMemoryRecordRepository } from "../src/adapters/outbound/sqlite/memory/memory-record-repository.ts";
import { KyselyMemorySpaceRepository } from "../src/adapters/outbound/sqlite/memory/memory-space-repository.ts";
import { KyselyMemoryTableRepository } from "../src/adapters/outbound/sqlite/memory/memory-table-repository.ts";
import { buildServer } from "../src/adapters/inbound/http/server.ts";
import { KyselySourceChatRepository } from "../src/adapters/outbound/sqlite/source-store/repository.ts";
import { KyselyFillTaskRepository } from "../src/adapters/outbound/sqlite/fill-tasks/repository.ts";
import { SystemMemoryTableInstaller } from "../src/application/system-memory/system-memory-table-definitions.ts";
import { DefaultChatManager } from "../src/application/chat/chat-manager.ts";
import { loadLlmEnvConfig } from "../src/application/chat/llm-config.ts";
import { UseCaseMemorySpaceReader } from "../src/adapters/outbound/memory/memory-space-reader.ts";
import type { ChatManagerOptions } from "../src/application/chat/chat-manager.ts";
import { FillTaskService } from "../src/application/fill-tasks/fill-task-service.ts";
import { FillTaskWriteGuard } from "../src/application/fill-tasks/write-guard.ts";

export interface TestChatOptions {
  readonly envConfig?: ChatManagerOptions["envConfig"];
  readonly buildLlmPort?: ChatManagerOptions["buildLlmPort"];
  readonly timeoutMs?: number;
}

export async function createTestApplication(
  prefix: string,
  timestamp: string,
  chatOptions: TestChatOptions = {},
) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const database = createDatabase(`sqlite:${join(directory, "application.sqlite")}`);
  await migrateDatabase(database);
  const context = new DatabaseContext(database);
  const unitOfWork = new KyselyUnitOfWork(database, context);
  const spaceRepository = new KyselyMemorySpaceRepository(context);
  const tableRepository = new KyselyMemoryTableRepository(context);
  const fieldRepository = new KyselyMemoryFieldRepository(context);
  const recordRepository = new KyselyMemoryRecordRepository(context, unitOfWork);
  const memoryRecordQueries = new MemoryRecordQueryService(
    tableRepository,
    fieldRepository,
    recordRepository,
  );
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
  const memoryRecords = new MemoryRecordService(
    tableRepository,
    fieldRepository,
    recordRepository,
    () => randomUUID() as MemoryRecordId,
    () => randomUUID() as MemoryRecordHistoryId,
    () => randomUUID() as MemoryRevisionId,
    () => timestamp,
    recordRepository,
    () => randomUUID() as MemoryEvidenceId,
  );
  const sourceChats = new KyselySourceChatRepository(context, unitOfWork);
  const memorySpaces = new DefaultMemorySpaceManager(spaces, systemTables, sourceChats, unitOfWork);
  const reader = new UseCaseMemorySpaceReader(tables, fields, memoryRecordQueries);
  const chat = new DefaultChatManager({
    envConfig: chatOptions.envConfig ?? loadLlmEnvConfig({}),
    spaces: memorySpaces,
    reader,
    // 默认不接真实 LLM：用到流式对话的测试必须显式注入假 provider。
    buildLlmPort:
      chatOptions.buildLlmPort ??
      (() => {
        throw new Error("测试未注入 LLM provider");
      }),
    timeoutMs: chatOptions.timeoutMs,
  });
  const fillTaskRepository = new KyselyFillTaskRepository(context);
  const fillTasks = new FillTaskService({
    tasks: fillTaskRepository,
    sources: sourceChats,
    spaces: memorySpaces,
    envConfig: chatOptions.envConfig ?? loadLlmEnvConfig({}),
    buildLlmPort:
      chatOptions.buildLlmPort ??
      (() => {
        throw new Error("测试未注入 LLM provider");
      }),
    reader,
    ports: { tables: tableRepository, fields: fieldRepository, records: recordRepository },
    evidence: recordRepository,
    commitContext: {
      tables: tableRepository,
      fields: fieldRepository,
      records: recordRepository,
      createId: () => randomUUID() as MemoryRecordId,
      createHistoryId: () => randomUUID() as MemoryRecordHistoryId,
      createRevisionId: () => randomUUID() as MemoryRevisionId,
      now: () => timestamp,
      displayText: (table, tableFields, payload) =>
        computeMemoryRecordDisplayText(
          recordRepository,
          table.memorySpaceId,
          table,
          tableFields,
          payload,
        ),
    },
    unitOfWork,
    createEvidenceId: () => randomUUID() as MemoryEvidenceId,
  });
  const writeGuard = new FillTaskWriteGuard(fillTaskRepository, {
    spaces: memorySpaces,
    tables,
    fields,
    records: memoryRecords,
  });
  const server = await buildServer({
    database: new KyselyDatabaseHealthCheck(context),
    memorySpaces: writeGuard.spaces,
    memoryTables: writeGuard.tables,
    memoryFields: writeGuard.fields,
    memoryRecords: writeGuard.records,
    memoryRecordQueries,
    chat,
    fillTasks,
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
    memoryRecords,
    sourceChats,
    fillTasks,
    fillTaskRepository,
    spaceRepository,
    tableRepository,
    fieldRepository,
    recordRepository,
  };
}
