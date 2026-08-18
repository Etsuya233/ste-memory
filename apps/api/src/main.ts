import { randomUUID } from "node:crypto";
import {
  MemoryFieldService,
  MemoryRecordQueryService,
  MemoryRecordService,
  MemorySpaceService,
  MemoryTableService,
  commitMemoryProposalBatch,
  computeMemoryRecordDisplayText,
  type MemoryEvidenceId,
  type MemoryFieldId,
  type MemoryRecordHistoryId,
  type MemoryRecordId,
  type MemoryRevisionId,
  type MemorySpaceId,
  type MemoryTableId,
} from "@ste-memory/core/memory";
import { loadConfig } from "./config.ts";
import { buildOpenAiCompatibleLlmPort } from "./adapters/outbound/llm/openai-compatible-llm.ts";
import { UseCaseMemorySpaceReader } from "./adapters/outbound/memory/memory-space-reader.ts";
import { DefaultChatManager } from "./application/chat/chat-manager.ts";
import { loadLlmEnvConfig } from "./application/chat/llm-config.ts";
import { DatabaseContext } from "./adapters/outbound/sqlite/database/database-context.ts";
import { createDatabase } from "./adapters/outbound/sqlite/database/database.ts";
import { KyselyUnitOfWork } from "./adapters/outbound/sqlite/database/kysely-unit-of-work.ts";
import { KyselyDatabaseHealthCheck } from "./adapters/outbound/sqlite/database/database-health-check.ts";
import { DefaultMemorySpaceManager } from "./application/memory-spaces/manager.ts";
import { KyselyMemoryFieldRepository } from "./adapters/outbound/sqlite/memory/memory-field-repository.ts";
import { KyselyMemoryRecordRepository } from "./adapters/outbound/sqlite/memory/memory-record-repository.ts";
import { KyselyMemorySpaceRepository } from "./adapters/outbound/sqlite/memory/memory-space-repository.ts";
import { KyselyMemoryTableRepository } from "./adapters/outbound/sqlite/memory/memory-table-repository.ts";
import { buildServer } from "./adapters/inbound/http/server.ts";
import { KyselySourceChatRepository } from "./adapters/outbound/sqlite/source-store/repository.ts";
import { SystemMemoryTableInstaller } from "@ste-memory/memory-host-shared";
import { FillTaskService } from "./application/fill-tasks/fill-task-service.ts";
import { FillTaskWriteGuard } from "./application/fill-tasks/write-guard.ts";
import { KyselyFillTaskRepository } from "./adapters/outbound/sqlite/fill-tasks/repository.ts";
import { KyselyCleaningRuleRepository } from "./adapters/outbound/sqlite/cleaning-rules/repository.ts";
import { DefaultCleaningRuleManager } from "./application/cleaning-rules/manager.ts";

export async function startApi(environment: NodeJS.ProcessEnv): Promise<void> {
  const config = loadConfig(environment);
  const database = createDatabase(config.databaseUrl);
  try {
    const context = new DatabaseContext(database);
    const unitOfWork = new KyselyUnitOfWork(database, context);
    const memorySpaceRepository = new KyselyMemorySpaceRepository(context, unitOfWork);
    const cleaningRuleRepository = new KyselyCleaningRuleRepository(
      context,
      unitOfWork,
      () => randomUUID(),
      () => new Date().toISOString(),
    );
    const cleaningRules = new DefaultCleaningRuleManager(
      cleaningRuleRepository,
      memorySpaceRepository,
    );
    const memoryTableRepository = new KyselyMemoryTableRepository(context);
    const memoryFieldRepository = new KyselyMemoryFieldRepository(context);
    const memoryRecordRepository = new KyselyMemoryRecordRepository(context, unitOfWork);
    const memoryRecordQueries = new MemoryRecordQueryService(
      memoryTableRepository,
      memoryFieldRepository,
      memoryRecordRepository,
    );
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
    const memorySpaceService = new MemorySpaceService(
      memorySpaceRepository,
      () => randomUUID() as MemorySpaceId,
      () => new Date().toISOString(),
    );
    const memorySpaces = new DefaultMemorySpaceManager(
      memorySpaceService,
      new SystemMemoryTableInstaller(memoryTableService, memoryFieldService),
      new KyselySourceChatRepository(context, unitOfWork),
      cleaningRuleRepository,
      unitOfWork,
    );
    // 提案管线（填表任务与交互式填写共用）的领域访问端口与提交上下文
    const proposalPorts = {
      tables: memoryTableRepository,
      fields: memoryFieldRepository,
      records: memoryRecordRepository,
    };
    const commitContext = {
      tables: memoryTableRepository,
      fields: memoryFieldRepository,
      records: memoryRecordRepository,
      createId: () => randomUUID() as MemoryRecordId,
      createHistoryId: () => randomUUID() as MemoryRecordHistoryId,
      createRevisionId: () => randomUUID() as MemoryRevisionId,
      now: () => new Date().toISOString(),
      displayText: (
        table: Parameters<typeof computeMemoryRecordDisplayText>[2],
        fields: Parameters<typeof computeMemoryRecordDisplayText>[3],
        payload: Parameters<typeof computeMemoryRecordDisplayText>[4],
      ) =>
        computeMemoryRecordDisplayText(
          memoryRecordRepository,
          table.memorySpaceId,
          table,
          fields,
          payload,
        ),
    };
    const chat = new DefaultChatManager({
      envConfig: loadLlmEnvConfig(environment),
      spaces: memorySpaces,
      reader: new UseCaseMemorySpaceReader(
        memoryTableService,
        memoryFieldService,
        memoryRecordQueries,
      ),
      ports: proposalPorts,
      commitProposal: (memorySpaceId, submission) =>
        unitOfWork.run(() =>
          commitMemoryProposalBatch(commitContext, memorySpaceId, submission, "agent"),
        ),
      buildLlmPort: (config) =>
        buildOpenAiCompatibleLlmPort({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          modelId: config.model,
        }),
    });
    const fillTasks = new FillTaskService({
      tasks: new KyselyFillTaskRepository(context),
      sources: new KyselySourceChatRepository(context, unitOfWork),
      spaces: memorySpaces,
      cleaningRules: cleaningRuleRepository,
      envConfig: loadLlmEnvConfig(environment),
      buildLlmPort: (config) =>
        buildOpenAiCompatibleLlmPort({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          modelId: config.model,
        }),
      reader: new UseCaseMemorySpaceReader(
        memoryTableService,
        memoryFieldService,
        memoryRecordQueries,
      ),
      ports: proposalPorts,
      evidence: memoryRecordRepository,
      commitContext,
      unitOfWork,
      createEvidenceId: () => randomUUID() as MemoryEvidenceId,
    });
    const writeGuard = new FillTaskWriteGuard(new KyselyFillTaskRepository(context), {
      spaces: memorySpaces,
      tables: memoryTableService,
      fields: memoryFieldService,
      records: new MemoryRecordService(
        memoryTableRepository,
        memoryFieldRepository,
        memoryRecordRepository,
        () => randomUUID() as MemoryRecordId,
        () => randomUUID() as MemoryRecordHistoryId,
        () => randomUUID() as MemoryRevisionId,
        () => new Date().toISOString(),
        memoryRecordRepository,
        () => randomUUID() as MemoryEvidenceId,
      ),
    });
    // API 重启：所有非终态任务标记 interrupted（不自动重放）。
    await fillTasks.markInterruptedOnStartup();
    const server = await buildServer({
      database: new KyselyDatabaseHealthCheck(context),
      memorySpaces: writeGuard.spaces,
      memoryTables: writeGuard.tables,
      memoryFields: writeGuard.fields,
      memoryRecords: writeGuard.records,
      memoryRecordQueries,
      chat,
      fillTasks,
      fillTaskEvents: fillTasks,
      cleaningRules,
    });
    server.addHook("onClose", async () => database.destroy());
    await server.listen({ host: config.host, port: config.port });
  } catch (error) {
    await database.destroy();
    throw error;
  }
}

if (import.meta.main) await startApi(process.env);
