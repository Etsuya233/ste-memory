import { SqliteFloorLedger } from "./infrastructure/memory-runtime/sqlite-floor-ledger.ts";
import { PresetSpaceUpdater } from "./infrastructure/memory-runtime/preset-space-updater.ts";
import { MemorySpaceLifecycle } from "./infrastructure/memory-runtime/memory-space-lifecycle.ts";
import { instantiateTablePreset } from "./features/table-presets/preset-instantiation.ts";
import { MEMORY_SNAPSHOT_SCHEMA_VERSION } from "./features/memory-snapshot/snapshot.ts";
import { QueryChatStore } from "./features/query-chat/session-store.ts";
import { PublicMemoryReader, type MemoryReadApi } from "./features/public-read/public-read-api.ts";
import { createMemoryChatApi } from "./features/public-read/chat-api.ts";
import { IndexedDbAssistantSessions } from "./infrastructure/indexeddb/assistant-session-repository.ts";
import { HttpRerankPort } from "./infrastructure/sillytavern/embedding/http-rerank.ts";
import type { RerankPort } from "./features/semantic-query/rerank.ts";
import type {
  SqlValue,
  SqlExecutionResult,
  SqlResultSet,
} from "./features/sql-console/sql-console.ts";
import { createSemanticQuerySession } from "./features/semantic-query/semantic-query-session.ts";
import { createSemanticQueryExecutor } from "./features/semantic-query/semantic-query-service.ts";
import {
  isAgentPresetSelectable,
  setActiveAgentPreset,
} from "./features/agent-presets/preset-model.ts";
import {
  AutoFillService,
  type AutoFillNotification,
} from "./features/fill-tasks/auto-fill-service.ts";
import type { PresetSpaceUpdateService } from "./features/table-presets/preset-space-update.ts";
import { VectorRetrievalService } from "./features/vector-retrieval/vector-retrieval-service.ts";
import { trackRetrievalChanges } from "./infrastructure/indexeddb/retrieval-change-sync.ts";
import {
  MemoryCommitPersistenceError,
  MemoryFieldService,
  MemoryRecordQueryService,
  MemoryRecordService,
  MemorySpaceService,
  MemoryTableService,
  createReadTimeDisplayTextResolver,
  effectiveVectorIndexGroups,
  type MemoryEvidenceId,
  type MemoryFieldId,
  type MemoryRecordHistoryId,
  type MemoryRecordId,
  type MemoryRevisionId,
  type MemorySpaceId,
  type MemoryTableId,
} from "./features/memory/index.ts";
import type { MemoryBackupRepository } from "./features/backup/index.ts";
import type { MemorySpaceReader } from "./features/memory/index.ts";
import { buildMemorySpaceTableDigest } from "./features/agent/index.ts";

import { PLUGIN_DISPLAY_NAME } from "./constants.ts";
import {
  ChatSnapshotPersistence,
  ChatSnapshotReplacementSaveError,
  type ChatSnapshotFileStore,
} from "./features/chat-mirror/chat-snapshot-persistence.ts";
import {
  createSqliteMemoryClient,
  type SqliteMemoryClient,
} from "./infrastructure/sqlite/client.ts";
import { querySqliteRecords } from "./infrastructure/sqlite/query-executor.ts";
import type { SqlConsole } from "./features/sql-console/sql-console.ts";
import { SqliteMemoryStore } from "./infrastructure/memory-runtime/sqlite-memory-store.ts";
import { SqliteMemoryBackupRepository } from "./infrastructure/memory-runtime/sqlite-backup-repository.ts";
import type { SqliteRepositories } from "./infrastructure/memory-runtime/sqlite-memory-store.ts";
import type { MemorySpaceBackup } from "./features/backup/backup-file.ts";
import type { FillTaskSession } from "./features/fill-tasks/fill-task-session.ts";
import {
  DexieFillTaskRepository,
  DexieLogRepository,
  SteMemoryDatabase,
  SteMemoryLogDatabase,
} from "./infrastructure/indexeddb/index.ts";
import { FillTaskService } from "./features/fill-tasks/fill-task-service.ts";
import { VectorIndexService } from "./features/vector-index/index.ts";
import type { VectorEmbeddingPort } from "./features/vector-index/index.ts";
import { DexieVectorIndexRepository } from "./infrastructure/indexeddb/vector-index/vector-index-repository.ts";
import { VectorIndexChangeSync } from "./infrastructure/memory-runtime/vector-index-change-sync.ts";
import { OpenAiEmbeddingPort } from "./infrastructure/sillytavern/embedding/openai-embedding.ts";
import { SpaceMaintenanceService } from "./features/space-maintenance/space-maintenance-service.ts";
import { QueryChatService } from "./features/query-chat/query-chat-service.ts";
import type { LogRepository } from "./features/logging/log.ts";
import { MemoryMacroService } from "./features/macros/memory-macro-service.ts";
import { createMacroEvaluationBatch } from "./features/macros/macro-evaluation.ts";
import { QueryVectorCache } from "./features/semantic-query/query-vector-cache.ts";
import type { MemoryMacro } from "./features/macros/macro-expression.ts";
import {
  AgentMacroService,
  AGENT_TABLES_DIGEST_MACRO,
  AGENT_SYSTEM_DEFAULT_PROMPT_MACRO,
} from "./features/agent-presets/agent-macro-service.ts";
import { resolveMacroRegistrationName } from "./features/macros/macro-name.ts";
import { createMacroOverviewReader } from "./features/macros/macro-overview.ts";
import type { MacroOverviewRow } from "./features/macros/macro-overview-model.ts";
import type { AgentPresetPreviewPorts } from "./features/agent-presets/preset-preview-model.ts";
import { createPresetPreviewPorts } from "./features/agent-presets/preset-preview-ports.ts";
import { createFillTaskPromptContext } from "./features/fill-tasks/prompt-context.ts";
import type { FillSourceMessage } from "./features/fill-tasks/fill-task.ts";
import type { SettingsStore } from "./features/settings/plugin-settings.ts";
import { SettingsService } from "./features/settings/settings-service.ts";
import { findSelectedCleaningRule } from "./features/cleaning/cleaning-rules.ts";
import {
  ChatSpaceManager,
  chatIdentityKey,
  type SpaceContextStatus,
} from "./features/chat-binding/chat-space-manager.ts";
import { TablePresetApplyService } from "./features/table-presets/table-preset-apply-service.ts";
import { SYSTEM_TABLE_PRESET } from "./features/table-presets/system-preset.ts";
import { resolveDefaultTablePreset } from "./features/table-presets/preset-model.ts";
import { StChatAdapter, type StContext } from "./infrastructure/sillytavern/chat-adapter.ts";
import { StSettingsStore } from "./infrastructure/sillytavern/settings-store.ts";
import {
  createAgentConnectionLlmPort,
  createStLlmPort,
} from "./infrastructure/sillytavern/llm/st-backends-llm.ts";
import type { LlmPort } from "./features/agent/index.ts";
import {
  resolveAgentConnection,
  type AgentConnectionTarget,
} from "./features/settings/agent-connections.ts";
import type { PluginLog } from "./bootstrap.ts";

/** 插件运行时（UI 与后续 ticket 的访问点） */
export interface SteMemoryRuntime {
  readonly publicRead: MemoryReadApi;
  readonly manager: ChatSpaceManager;
  readonly adapter: StChatAdapter;
  /** Memory 服务（面板表格列表/启停等 UI 操作入口） */
  readonly spaces: MemorySpaceService;
  readonly tables: MemoryTableService;
  readonly fields: MemoryFieldService;
  /** 记忆记录（ticket 10/11）：显示文本预览、列表/搜索分页、手动增删改入口 */
  readonly records: MemoryRecordService;
  /** 重试当前聊天最新待保存快照，不重放已经提交的业务。 */
  readonly retryMemorySave: () => Promise<void>;
  /** 保存已提交 SQLite 完整快照并从固定文件核验；不提交 UI 草稿。 */
  readonly forceSyncMemory: () => Promise<void>;
  /** 当前聊天完整空间导出与候选SQLite验证 */
  readonly backup: MemoryBackupRepository;
  /** 插件设置存储（设置面板读写与运行时开关门控共用同一实例） */
  readonly settings: SettingsStore;
  readonly settingsService: SettingsService;
  readonly normalizeImportedSpace: (unit: MemorySpaceBackup) => Promise<MemorySpaceBackup>;
  /** 固定聊天目标的快照保存、候选激活与明确重试 */
  readonly persistence: ChatSnapshotPersistence;
  /** 填表任务（ticket 13）：手动楼层范围触发/取消 + 台账；启动时中断非终态任务 */
  readonly tasks: FillTaskService;
  readonly vector: VectorIndexService;
  readonly retrieval: VectorRetrievalService;
  readonly sqlConsole: SqlConsole;
  readonly autoFill: AutoFillService;
  /** 空间维护（spec reset-space）：清除空间记录（危险操作区） */
  readonly spaceMaintenance: SpaceMaintenanceService;
  /** 表格预设（spec table-presets）：首次创建安装与当前空间应用（原子重建） */
  readonly presetApply: TablePresetApplyService;
  readonly presetUpdate: PresetSpaceUpdateService;
  /** 通用日志（独立数据库，ADR 0015）：本地审计日志（填表行流）；不同步不备份不随空间删除 */
  readonly logs: LogRepository;
  /** 记忆宏：注册、生成时统一计算与独立测试。 */
  readonly macro: MemoryMacroService;
  /** Agent 预设宏（ticket 17）：{{tablesDigest}}/{{systemDefaultPrompt}} 注册 + 快照轮询 */
  readonly agentMacro: AgentMacroService;
  /**
   * Agent 预设预览（issue 01）：点击预览时即时构建展开数据（ST 上下文快照 /
   * 活动空间 digest / 世界书 dry-run 扫描），预览构建的纯逻辑在 preset-preview-model。
   */
  readonly presetPreview: AgentPresetPreviewPorts;
  /** 宏内容一览（issue 01）：聚合记忆宏 + Agent 预设宏预计算快照为展示行（同步读） */
  readonly macroOverview: () => readonly MacroOverviewRow[];
  /** LLM 端口工厂（ticket 12）：任务开始时读 ST 当前配置构造一次（模型+参数快照），
   * 之后 streamFn 是纯函数（model, context, options）——填表任务（ticket 13）每 run 调一次；
   * Agent 连接（ADR 0010）：填表选择连接时改用连接（模型/URL/Key），参数仍读 ST 快照 */
  readonly createLlm: () => LlmPort;
  /** 问答面板 LLM 端口工厂（ADR 0010）：与 createLlm 同语义，开启思考流
   * （includeReasoning），查询 Agent 选择连接时改用连接 */
  readonly createQueryChatLlm: () => LlmPort;
  /** 问答面板（ticket 20 / ADR 0009）：查询/填写双模式 run 编排；LLM 端口开启
   * 思考流（includeReasoning，ticket 19），提交直通 repository + 空间切换守卫 */
  readonly queryChat: QueryChatService;
  /** 对话级 Agent 预设覆盖：undefined = 跟随全局活动预设 */
  readonly agentPresetOverride: {
    readonly read: () => string | undefined;
    readonly write: (presetId: string | undefined) => void;
  };
  /** 清洗规则（ticket 22 / ADR 0011）：当前对话规则选择读写 + 聊天 Scope 宏 */
  readonly cleaning: {
    readonly readSelection: () => string | undefined;
    readonly writeSelection: (ruleId: string | undefined) => void;
    /** 最近 N 条对话消息（ticket 27 清洗测试「从当前对话载入」数据源，与填表任务同源） */
    readonly readRecentMessages: (count: number) => readonly FillSourceMessage[];
    readonly readChatScopeMacros: () => readonly MemoryMacro[];
    readonly writeChatScopeMacros: (macros: readonly MemoryMacro[]) => Promise<void>;
  };
  /** 插件版本（构建时注入，设置面板展示） */
  readonly version: string;
  /** 弹窗 API（分支检测等需要用户交互的场景） */
  readonly popup: {
    show(
      content: string,
      options?: {
        type?: number;
        okButton?: string;
        cancelButton?: string;
        wide?: boolean;
      },
    ): Promise<number | string | boolean | null | undefined>;
  };
}

export interface StartSteMemoryOptions {
  /** UI notifications are supplied by the mounted frontend. */
  readonly autoFillNotifications?: {
    show: (notice: AutoFillNotification) => void;
    dismissReminder: () => void;
  };
  /** Explicit host adapter; tests use the real WASM engine in-process. */
  readonly createSqlite?: () => SqliteMemoryClient | Promise<SqliteMemoryClient>;
  readonly snapshotFiles?: ChatSnapshotFileStore;
  /** 测试与其他宿主可注入 embedding 实现；浏览器默认使用独立 HTTP 连接。 */
  readonly embedding?: VectorEmbeddingPort;
  readonly rerank?: RerankPort;
  readonly log?: PluginLog;
  /** 时钟；缺省 = Date.toISOString（测试注入固定时钟） */
  readonly now?: () => string;
  /** id 工厂；缺省 = crypto.randomUUID（TauriTavern 非安全上下文时降级时间戳+随机） */
  readonly createId?: (prefix: string) => string;
  /** Dexie 库工厂；缺省 = 默认库（测试注入临时库） */
  readonly createDb?: () => SteMemoryDatabase;
  /** 通用日志库工厂（ADR 0015）；缺省 = 默认库（测试注入临时库，afterEach 删除） */
  readonly createLogDb?: () => SteMemoryLogDatabase;
  /** 设置存储；缺省 = ST extension_settings 宿主（测试注入固定值） */
  readonly settingsStore?: SettingsStore;
  /** 插件版本（构建时注入；缺省空串，设置面板显示 v） */
  readonly version?: string;
}

/**
 * 浏览器 id 工厂：优先 crypto.randomUUID；不可用（非安全上下文）时降级
 * 「前缀-时间戳-随机」，仍满足空间/表格/字段 id 唯一性。
 */
export function defaultIdFactory(prefix: string): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID();
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 启动插件运行时（组合根，bootstrap 在 ST 环境可用时调用）：
 * SQLite在线内容 + 独立辅助数据 + 表格预设 + 指定聊天文件保存 + ST事件桥
 * + 首次同步。
 *
 * getContext 必须是可重复调用的工厂（ST getContext() 每次构造新对象，切对话后
 * chatId / chatMetadata 均需重取），而不是一次性快照。
 */
export async function startSteMemory(
  getContext: () => unknown,
  options: StartSteMemoryOptions = {},
): Promise<SteMemoryRuntime> {
  const log = options.log ?? console;
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? defaultIdFactory;
  const db = options.createDb ? options.createDb() : new SteMemoryDatabase();
  const logDb = options.createLogDb ? options.createLogDb() : new SteMemoryLogDatabase();
  const settings = options.settingsStore ?? new StSettingsStore(() => getContext() as StContext);

  const adapter = new StChatAdapter(() => getContext() as StContext);
  const persistence = new ChatSnapshotPersistence(
    options.snapshotFiles ?? adapter.snapshotFileStore,
    () => options.version ?? "",
    {
      read: async (spaceId) => {
        const rows = await db.floorFillLedger.where("memorySpaceId").equals(spaceId).toArray();
        return rows.map(({ floor, status, updatedAt }) => ({ floor, status, updatedAt }));
      },
      remove: async (spaceId) => {
        await db.floorFillLedger.where("memorySpaceId").equals(spaceId).delete();
      },
      isActive: (target, spaceId) => {
        const status = manager.getStatus();
        return (
          chatIdentityKey(adapter.getChatSnapshot()) === target.identity &&
          status?.kind === "active" &&
          status.space.id === spaceId
        );
      },
    },
  );
  // 保存/编辑端口在构造时固定；首次加载前，所有生命周期依赖会完成装配。
  const saveSnapshot = (unit: MemorySpaceBackup) => lifecycle.saveSnapshot(unit);
  const sqlite = await (options.createSqlite ?? createSqliteMemoryClient)();
  const memoryStore = new SqliteMemoryStore(sqlite, {
    saveSnapshot,
    assertCanEdit: (id) => lifecycle.assertCanEdit(id),
    reportRefreshError: (error) => log.error("空间订阅刷新失败", error),
  });
  const repositories = memoryStore.repositories();
  const {
    spaces: spaceRepository,
    tables: tableRepository,
    fields: fieldRepository,
    records: recordRepository,
  } = repositories;
  const backup: SqliteMemoryBackupRepository = new SqliteMemoryBackupRepository(
    memoryStore,
    () => {
      const status = manager.getStatus();
      return status?.kind === "active" ? status.space.id : undefined;
    },
    options.createSqlite ?? createSqliteMemoryClient,
  );
  const spaces = new MemorySpaceService(
    spaceRepository,
    () => createId("space") as MemorySpaceId,
    now,
  );
  const tables = new MemoryTableService(
    spaceRepository,
    tableRepository,
    () => createId("table") as MemoryTableId,
    now,
    fieldRepository,
  );
  const fields = new MemoryFieldService(
    tableRepository,
    fieldRepository,
    () => createId("field") as MemoryFieldId,
    now,
  );
  const records = new MemoryRecordService(
    tableRepository,
    fieldRepository,
    recordRepository,
    () => createId("record") as MemoryRecordId,
    () => createId("record-history") as MemoryRecordHistoryId,
    () => createId("revision") as MemoryRevisionId,
    now,
    recordRepository,
    () => createId("evidence") as MemoryEvidenceId,
  );

  // 填表任务（ticket 13）：ProposalAgent 的只读端口/提交上下文与面板服务共用同一组
  // repository；SQLite提交、文件保存与批次确认明确分阶段，不把它们表示为共同事务。
  Object.assign(globalThis, {
    steMemoryGenerationInterceptor: (
      _chat: unknown,
      _contextSize: number,
      abort: (immediately: boolean) => void,
      type: unknown,
    ) => adapter.interceptGeneration(abort, type),
  });
  const makeReader = (
    repos: SqliteRepositories,
    view: "write" | "committed",
  ): MemorySpaceReader => ({
    getSpace: (id) => repos.spaces.find(id),
    listTables: (id) => repos.tables.list(id),
    listFields: (id, tableId) => repos.fields.list(id, tableId),
    queryRecords: (id, input) =>
      new MemoryRecordQueryService(
        repos.tables,
        repos.fields,
        repos.records,
        (spaceId, query, display) => querySqliteRecords(sqlite, spaceId, query, view, display),
      ).query(id, input),
    querySql: async (id, sql) => {
      if (!memoryStore.hasSpace(id)) {
        throw new Error(`记忆空间不存在: ${id}`);
      }
      const allowedTables: Record<string, readonly string[]> = {};
      const display = createReadTimeDisplayTextResolver({
        getTable: (tableId) => repos.tables.find(id, tableId),
        getFields: (tableId) => repos.fields.list(id, tableId),
        findRecord: (tableId, recordId) =>
          repos.records.find(id, tableId, recordId as MemoryRecordId),
      });
      for (const table of await repos.tables.list(id)) {
        if (!table.enabled) {
          continue;
        }
        allowedTables[table.key] = [
          "$record_id",
          "$display_text",
          "$created_at",
          "$updated_at",
          ...(await repos.fields.list(id, table.id))
            .filter((field) => field.enabled)
            .map((field) => field.key),
        ];
        // Display values depend on referenced records; refresh the SQL projection without creating revisions.
        const quotedTable = `"${table.key.replaceAll('"', '""')}"`;
        for (const record of await repos.records.list(id, table.id)) {
          await sqlite.exec({
            spaceId: id,
            view,
            access: "host",
            sql: `UPDATE ${quotedTable} SET "$display_text"=? WHERE "$record_id"=?`,
            bind: [await display(record), record.id],
          });
        }
      }
      return sqlite.exec({
        spaceId: id,
        sql,
        view,
        access: "read",
        allowedTables,
        maxRows: 101,
        budgetMs: 1000,
      });
    },
  });
  const reader = makeReader(repositories, "committed");
  /**
   * LLM 端口工厂（ADR 0010）：选中 Agent 连接 → 连接端口；否则跟随 ST 当前连接
   * （旧行为零变化）。任务开始时构造一次（ST 快照 + 连接快照），之后 streamFn
   * 是纯函数（model, context, options）。
   */
  const createLlmFor = (target: AgentConnectionTarget, includeReasoning: boolean): LlmPort => {
    const connection = resolveAgentConnection(settings.read(), target);
    if (connection) {
      return createAgentConnectionLlmPort(connection, () => getContext() as StContext, {
        includeReasoning,
      });
    }
    return createStLlmPort(() => getContext() as StContext, { includeReasoning });
  };
  // 填表任务：开启思考流（issue 03 / ADR 0016 请求行记录思考）；模型不支持思考时
  // 静默降级（适配器行为：上游无思考段则无思考块，不影响任务）。
  // 问答面板（ticket 20）：同样开启。
  const createLlm = (): LlmPort => createLlmFor("fillTask", true);
  const createQueryChatLlm = (): LlmPort => createLlmFor("queryChat", true);
  // 填表任务的编排上下文工厂（ADR 0024 组装迁移）：纯数据装配在所属功能
  const createPromptContext = createFillTaskPromptContext({
    // 对话覆盖优先：悬空/未知预设回退全局活动预设。
    readPresetSettings: () => {
      const presets = settings.read().agentPresets;
      const override = adapter.agentPresetStore.read();
      return override !== undefined && isAgentPresetSelectable(presets, override)
        ? setActiveAgentPreset(presets, override)
        : presets;
    },
    readSnapshot: () => adapter.getPromptSnapshot(),
    getStContext: () => getContext() as StContext,
    logWarn: (message) => log.warn(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
  });
  const logs = new DexieLogRepository(logDb, { now });
  persistence.onStatusChange((status) => {
    if (status.kind === "failed") {
      log.error("记忆保存失败", status);
      void logs
        .append({
          type: "snapshot-save",
          key: status.identity,
          level: "error",
          text: JSON.stringify(status, null, 2),
        })
        .catch((error) => log.error("保存诊断日志写入失败", error));
    }
  });
  const fillTaskRepository = new DexieFillTaskRepository(db, now);
  const floorLedgerRepository = new SqliteFloorLedger(memoryStore, now);
  const tasks = new FillTaskService({
    assertCanEditSpace: (id) => lifecycle.assertCanEdit(id),
    onAutomaticSuccess: (task): Promise<void> => autoFill.taskSucceeded(task),
    canStartAutomaticTask: (task): boolean => autoFill.canStartTask(task),
    tasks: fillTaskRepository,
    ledger: floorLedgerRepository,
    logs,
    source: adapter,
    beginTask: async (task, signal): Promise<FillTaskSession> => {
      signal.throwIfAborted();
      const token = await lifecycle.beginFillBatch(task.memorySpaceId, signal);
      const baseline = await sqlite.exportSpace(task.memorySpaceId, "write");
      const taskRepos = memoryStore.repositories("write", token);
      const taskRecords = new MemoryRecordService(
        taskRepos.tables,
        taskRepos.fields,
        taskRepos.records,
        () => createId("record") as MemoryRecordId,
        () => createId("record-history") as MemoryRecordHistoryId,
        () => createId("revision") as MemoryRevisionId,
        now,
        taskRepos.records,
        () => createId("evidence") as MemoryEvidenceId,
      );
      let ended = false;
      return {
        reader: makeReader(taskRepos, "write"),
        ports: { tables: taskRepos.tables, fields: taskRepos.fields, records: taskRepos.records },
        evidence: taskRepos.records,
        recordWriter: taskRecords,
        commitAndSave: async (batch) => {
          signal.throwIfAborted();
          await memoryStore.consolidateTask(
            baseline,
            token,
            createId("revision") as MemoryRevisionId,
            now(),
          );
          if (task.kind === "floor") {
            await new SqliteFloorLedger(memoryStore, now, token).markProcessed(
              task.memorySpaceId,
              batch.floors,
            );
          }
          ended = true;
          try {
            await memoryStore.commitTask(task.memorySpaceId, token);
          } catch (error) {
            // SQL 已提交：宿主保存失败由独立保存状态呈现，任务继续前进，不能重放本批。
            if (!(error instanceof MemoryCommitPersistenceError)) {
              throw error;
            }
          }
        },
        rollback: async (failedFloors) => {
          if (ended) {
            return;
          }
          ended = true;
          try {
            await memoryStore.rollbackTask(
              task.memorySpaceId,
              token,
              failedFloors && { floors: failedFloors, updatedAt: now() },
            );
          } catch (error) {
            if (!(error instanceof MemoryCommitPersistenceError)) {
              throw error;
            }
          }
        },
        release: async () => {
          if (ended) {
            return;
          }
          ended = true;
          await memoryStore.rollbackTask(task.memorySpaceId, token);
        },
      };
    },
    createLlm,
    createPromptContext,
    createRunId: () => createId("task"),
    readAgentTimeoutMs: () => settings.read().fillAgentTimeoutSeconds * 1000,
    createEvidenceId: () => createId("evidence") as MemoryEvidenceId,
    now,
    logError: (message, error) => log.error(`[${PLUGIN_DISPLAY_NAME}] ${message}`, error),
    // 任务开始执行时冻结当前对话的清洗规则，后续批次共用该快照。
    readCleaningRule: () =>
      findSelectedCleaningRule(settings.read().cleaningRules, adapter.cleaningRuleStore.read()),
  });

  const presetApply = new TablePresetApplyService({
    validateStructure: async (structure) => {
      if (!structure.macros.length) {
        return structure;
      }
      const at = now();
      const snapshot: MemorySpaceBackup = {
        schemaVersion: MEMORY_SNAPSHOT_SCHEMA_VERSION,
        floorLedger: [],
        space: {
          id: structure.tables[0]?.memorySpaceId ?? ("preset-validation" as MemorySpaceId),
          stableId: structure.tables[0]?.memorySpaceId ?? ("preset-validation" as MemorySpaceId),
          name: "预设校验",
          initializationSource: null,
          createdAt: at,
          updatedAt: at,
          macros: structure.macros,
        },
        tables: structure.tables,
        fields: structure.fields,
        records: [],
        history: [],
        evidence: [],
      };
      const batch = await createMacroBatch(snapshot, {
        lastUserMessage: null,
        signal: AbortSignal.timeout(10_000),
        deadline: performance.now() + 10_000,
      });
      try {
        const macros = await Promise.all(
          structure.macros.map(async (macro) => {
            const usesSemantic = await batch.validate(macro.expression);
            return macro.expression.language === "sql"
              ? { ...macro, expression: { ...macro.expression, usesSemantic } }
              : macro;
          }),
        );
        return { ...structure, macros };
      } finally {
        await batch.close();
      }
    },
    cancelActiveTask: (id) => tasks.cancelAll(id),
    rebuild: { rebuild: (input) => lifecycle.rebuildStructure(input) },
    defaultPreset: () =>
      resolveDefaultTablePreset(settings.read().tablePresets, SYSTEM_TABLE_PRESET),
    currentChatIdentity: () => chatIdentityKey(adapter.getChatSnapshot()),
    clearChatScopeMacros: () => adapter.chatScopeMacroStore.write([]),
    createStableSpaceId: () => createId("space"),
    createIds: {
      table: () => createId("table") as MemoryTableId,
      field: () => createId("field") as MemoryFieldId,
      group: () => createId("vector-group"),
    },
    now,
  });
  const manager: ChatSpaceManager = new ChatSpaceManager({
    getChat: () => adapter.getChatSnapshot(),
    captureTarget: () => adapter.captureFileTarget(),
    bindingStore: adapter.bindingStore,
    persistence,
    createSnapshot: async (name) => {
      const preset = resolveDefaultTablePreset(settings.read().tablePresets, SYSTEM_TABLE_PRESET);
      const id = createId("space") as MemorySpaceId;
      const at = now();
      const structure = instantiateTablePreset(
        preset,
        id,
        {
          table: () => createId("table") as MemoryTableId,
          field: () => createId("field") as MemoryFieldId,
          group: () => createId("vector-group"),
        },
        at,
      );
      return normalizeImportedSpace({
        schemaVersion: MEMORY_SNAPSHOT_SCHEMA_VERSION,
        floorLedger: [],
        space: {
          id,
          stableId: id,
          name,
          macros: structure.macros,
          prompt: preset.prompt ?? "",
          initializationSource: { presetId: preset.id, presetName: preset.name, appliedAt: at },
          createdAt: at,
          updatedAt: at,
        },
        tables: structure.tables,
        fields: structure.fields,
        records: [],
        history: [],
        evidence: [],
      });
    },
    validateSnapshot: (unit) => backup.validateSnapshot(unit),
    activateSnapshot: (target, binding, unit) => lifecycle.activate(target, binding, unit),
    unloadSnapshot: (id, target) => lifecycle.unload(id, target),
    stopSpaceWrites: (id) => lifecycle.stopWrites(id),
    captureRetirement: (id, target) => lifecycle.captureRetirement(id, target),
    findSpace: (id) => spaceRepository.find(id),
    createIds: {
      space: () => createId("space") as MemorySpaceId,
      table: () => createId("table") as MemoryTableId,
      field: () => createId("field") as MemoryFieldId,
      record: () => createId("record") as MemoryRecordId,
      history: () => createId("record-history") as MemoryRecordHistoryId,
      evidence: () => createId("evidence") as MemoryEvidenceId,
      macro: () => createId("macro"),
      group: () => createId("vector-group"),
    },
    now,
  });

  const embedding =
    options.embedding ?? new OpenAiEmbeddingPort(() => settings.read().embeddingConnection);
  const queryVectorCache = new QueryVectorCache();
  const vectorRepository = new DexieVectorIndexRepository(db);
  const vector = new VectorIndexService(
    tableRepository,
    fieldRepository,
    recordRepository,
    embedding,
    vectorRepository,
    () => {
      const status = manager.getStatus();
      return status?.kind === "active" ? status.space.id : null;
    },
    () => settings.read().enabled,
    () => createId("vector-task"),
  );
  let chatEpoch = 0;
  const memorySelectionKey = () => {
    const status = manager.getStatus();
    return JSON.stringify([
      chatEpoch,
      chatIdentityKey(adapter.getChatSnapshot()),
      status?.kind === "active" ? status.space.id : null,
    ]);
  };
  const retrieval = new VectorRetrievalService(
    tableRepository,
    fieldRepository,
    vector,
    vectorRepository,
    embedding,
    memorySelectionKey,
  );
  const currentSpaceId = () => {
    const status = manager.getStatus();
    return status?.kind === "active" ? status.space.id : null;
  };
  let chatMacros: readonly MemoryMacro[] = [];
  const syncRetrievalContext = () => retrieval.setContext(memorySelectionKey(), currentSpaceId());
  manager.onStatusChange(syncRetrievalContext);
  trackRetrievalChanges(db, retrieval);
  await vector.start();
  const vectorSync = new VectorIndexChangeSync(
    vector,
    () => settings.read().enabled,
    (error) => log.error(`[${PLUGIN_DISPLAY_NAME}] 向量索引核对失败`, error),
  );

  const semanticEvaluationInput = (
    snapshot: MemorySpaceBackup,
    context: { lastUserMessage: string | null; signal: AbortSignal; deadline: number },
  ) => {
    const connection = settings.read().embeddingConnection;
    const rerankSettings = structuredClone(settings.read().rerank);
    const captured = connection ? structuredClone(connection) : undefined;
    const batchEmbedding = options.embedding ?? new OpenAiEmbeddingPort(() => captured);
    const revision = queryVectorCache.revisionFor({
      connection: captured,
      profile: batchEmbedding.getProfile(),
    });
    const queryVectors = queryVectorCache.createExecution({
      embedding: batchEmbedding,
      revision,
      signal: context.signal,
      isCurrent: () =>
        queryVectorCache.revisionFor({
          connection: settings.read().embeddingConnection,
          profile: embedding.getProfile(),
        }) === revision,
    });
    return {
      sql: sqlite,
      vectors: vectorRepository,
      embedding: batchEmbedding,
      rerankSettings,
      rerank:
        options.rerank ??
        (rerankSettings.connection ? new HttpRerankPort(rerankSettings.connection) : undefined),
      queryVectors,
      onCleanupError: (error: unknown) => log.error("语义查询会话关闭失败", error),
      snapshot,
      ...context,
    };
  };
  const semanticQuery = createSemanticQueryExecutor({
    snapshot: async (spaceId) => {
      if (!memoryStore.hasSpace(spaceId)) {
        throw new Error(`记忆空间不存在: ${spaceId}`);
      }
      const snapshot = await memoryStore.snapshot(spaceId);
      if (!snapshot) {
        throw new Error(`记忆空间不存在: ${spaceId}`);
      }
      return snapshot;
    },
    createSession: (snapshot, context) =>
      createSemanticQuerySession(semanticEvaluationInput(snapshot, context)),
    onCleanupError: (error: unknown) => log.error("语义查询会话关闭失败", error),
  });

  // 记忆助手共用持久化会话及查询/提案工具，提交前检查实时对话身份和代次。
  const assistantStore = new QueryChatStore(new IndexedDbAssistantSessions(db), () =>
    createId("assistant"),
  );
  await assistantStore.ready;
  const lifecycle: MemorySpaceLifecycle = new MemorySpaceLifecycle({
    memory: memoryStore,
    persistence,
    tasks,
    vector,
    assistant: assistantStore,
    clearTasks: (id) => fillTaskRepository.clear(id),
    reportSwitchError: (error) => {
      manager.reportLoadError(error);
      log.error(`[${PLUGIN_DISPLAY_NAME}] 同步空间上下文失败`, error);
    },
  });
  const queryChat = new QueryChatService({
    store: assistantStore,
    semanticQuery,
    reader,
    ports: { tables: tableRepository, fields: fieldRepository, records: recordRepository },
    recordWriter: records,
    createLlm: createQueryChatLlm,
    getCurrentContext: () => {
      if (!settings.read().enabled) {
        return undefined;
      }
      const status = manager.getStatus();
      const chatKey = chatIdentityKey(adapter.getChatSnapshot());
      return status?.kind === "active" && chatKey
        ? { chatKey, spaceId: status.space.id, generation: chatEpoch }
        : undefined;
    },
  });

  // 空间维护：清除空间记录（保留表格结构与初始化来源）；按预设重建统一走
  // 表格预设的应用流程（TablePresetApplyService）。
  const spaceMaintenance = new SpaceMaintenanceService({
    clearRecords: (id) => lifecycle.clearRecords(id),
    cancelActiveTask: (id) => tasks.cancelAll(id),
  });

  // 页面/浏览器重开：运行项标记 interrupted 并暂停队列，等待项保留
  await tasks.markInterruptedOnStartup();
  // 后续 SQLite 提交同步交接文件保存；辅助任务只恢复自身运行状态。

  const refreshChatMacros = async () => {
    const context = memorySelectionKey();
    const id = currentSpaceId();
    const space = id ? await spaces.find(id) : undefined;
    if (context === memorySelectionKey()) {
      chatMacros = space?.macros ?? [];
    }
  };
  const createMacroBatch = (
    snapshot: MemorySpaceBackup,
    context: { lastUserMessage: string | null; signal: AbortSignal; deadline: number },
  ) => createMacroEvaluationBatch(semanticEvaluationInput(snapshot, context));
  const classifyMacros = async (
    snapshot: MemorySpaceBackup,
    macros: readonly MemoryMacro[],
  ): Promise<readonly MemoryMacro[]> => {
    if (!macros.length) {
      return macros;
    }
    const signal = AbortSignal.timeout(10_000);
    const batch = await createMacroBatch(snapshot, {
      lastUserMessage: null,
      signal,
      deadline: performance.now() + 10_000,
    });
    try {
      return await Promise.all(
        macros.map(async (macro) => {
          const usesSemantic = await batch.validate(macro.expression);
          return macro.expression.language === "sql"
            ? { ...macro, expression: { ...macro.expression, usesSemantic } }
            : macro;
        }),
      );
    } finally {
      await batch.close();
    }
  };
  const validateMacros = async (
    macros: readonly MemoryMacro[],
    previous: readonly MemoryMacro[],
  ): Promise<readonly MemoryMacro[]> => {
    if (!macros.length) {
      return macros;
    }
    const normalized = new Map<string, MemoryMacro>();
    const pending: MemoryMacro[] = [];
    for (const macro of macros) {
      const before = previous.find((item) => item.id === macro.id);
      if (
        macro.expression.language === "query" &&
        before?.expression.language === "query" &&
        JSON.stringify(macro.expression) === JSON.stringify(before.expression)
      ) {
        normalized.set(macro.id, macro);
      } else if (
        macro.expression.language === "sql" &&
        before?.expression.language === "sql" &&
        macro.expression.sql === before.expression.sql &&
        JSON.stringify(macro.expression.sources ?? []) ===
          JSON.stringify(before.expression.sources ?? []) &&
        (typeof before.expression.usesSemantic === "boolean" ||
          (before.expression.sources?.length ?? 0) > 0)
      ) {
        normalized.set(macro.id, {
          ...macro,
          expression: {
            ...macro.expression,
            usesSemantic:
              (before.expression.sources?.length ?? 0) > 0 ||
              before.expression.usesSemantic === true,
          },
        });
      } else {
        pending.push(macro);
      }
    }
    if (!pending.length) {
      return macros.map((macro) => normalized.get(macro.id)!);
    }
    const id = currentSpaceId();
    if (!id) {
      if (pending.some((macro) => macro.expression.language === "sql")) {
        throw new Error("请先打开已绑定记忆空间的对话，再保存 SQL 宏");
      }
      for (const macro of pending) {
        normalized.set(macro.id, macro);
      }
      return macros.map((macro) => normalized.get(macro.id)!);
    }
    const snapshot = await memoryStore.snapshot(id);
    if (!snapshot) {
      throw new Error("当前记忆空间尚未准备好");
    }
    for (const macro of await classifyMacros(snapshot, pending)) {
      normalized.set(macro.id, macro);
    }
    return macros.map((macro) => normalized.get(macro.id)!);
  };
  const normalizeImportedSpace = async (unit: MemorySpaceBackup): Promise<MemorySpaceBackup> => ({
    ...unit,
    space: { ...unit.space, macros: await classifyMacros(unit, unit.space.macros) },
  });
  const writeChatMacros = async (macros: readonly MemoryMacro[]) => {
    const id = currentSpaceId();
    const context = memorySelectionKey();
    if (!id) {
      throw new Error("当前对话尚未准备好");
    }
    const saved = await spaces.setMacros(id, macros);
    if (!saved) {
      throw new Error("记忆空间已不存在");
    }
    if (context !== memorySelectionKey()) {
      return;
    }
    chatMacros = macros;
    await manager.refreshSpace(id);
  };
  const macro = new MemoryMacroService({
    getContext: memorySelectionKey,
    getChatMacros: () => chatMacros,
    saveChatMacros: writeChatMacros,
    readLegacyChatMacros: () => adapter.chatScopeMacroStore.read(),
    writeLegacyChatMacros: (macros) => adapter.chatScopeMacroStore.write(macros),
    readSettings: () => settings.read(),
    capture: async () => {
      const id = currentSpaceId();
      return id ? memoryStore.snapshot(id) : undefined;
    },
    createBatch: createMacroBatch,
    registerMacro: adapter.macroRegistration,
    now,
  });
  const autoFill = new AutoFillService({
    hideFloors: (identity, to) => adapter.hideFloors(identity, to),
    tasks,
    chatStore: adapter.autoFillStore,
    globalSettings: () => settings.read().autoFill,
    current: () => {
      const status = manager.getStatus();
      const snapshot = adapter.getChatSnapshot();
      const identity = chatIdentityKey(snapshot);
      if (!settings.read().enabled || status?.kind !== "active" || !identity) {
        return undefined;
      }
      if (persistence.hasPendingReplacement(identity)) {
        return undefined;
      }
      const binding = adapter.bindingStore.read();
      if (binding.kind !== "bound" || binding.binding.spaceId !== status.space.id) {
        return undefined;
      }
      if (binding.binding.version === 2 && binding.binding.chatIdentity !== identity) {
        return undefined;
      }
      return {
        identity,
        chatId: snapshot.chatId,
        spaceId: status.space.id,
        chatLength: adapter.chatMessageCount(),
        aiFloor: adapter.latestAiFloor(),
      };
    },
    notify: (notice) => options.autoFillNotifications?.show(notice),
    confirmResume: async (task) => {
      const context = getContext() as StContext;
      const result = await context.callGenericPopup?.(
        `上次填表任务（楼层 #${task.from}–#${task.to}）因切换对话中断。是否继续填表？已成功填写的楼层会保留。`,
        2,
        "",
        { okButton: "继续填表", cancelButton: "暂不继续" },
      );
      return result === 1;
    },
    dismissReminder: () => options.autoFillNotifications?.dismissReminder(),
    reportError: (error) => log.error(`[${PLUGIN_DISPLAY_NAME}] 自动填表调度失败`, error),
  });

  async function syncCurrentChat() {
    adapter.cleaningRuleStore.read();
    adapter.clearLegacyRecall();
    let state: SpaceContextStatus;
    try {
      state = await manager.syncToCurrentChat();
    } catch (error) {
      const current = manager.getStatus();
      if (!(error instanceof ChatSnapshotReplacementSaveError) || current?.kind !== "active") {
        throw error;
      }
      // 候选已经激活，核验失败只保留保存待办；聊天的读取与自动任务就绪流程继续。
      // 新编辑与填表仍受生命周期的关键操作门控，确认成功后可正常调度。
      log.error("候选记忆尚待核验", error);
      state = current;
    }
    await refreshChatMacros();
    const identity = chatIdentityKey(adapter.getChatSnapshot());
    if (state.kind === "active" && identity && !persistence.hasPendingReplacement(identity)) {
      await macro.migrateLegacyChatMacros();
    }
    return state;
  }

  adapter.registerEventBridge({
    onChatChanged: () => {
      const stoppingAutoFill = autoFill.chatChanged();
      macro.chatChanged();
      chatMacros = [];
      chatEpoch++;
      retrieval.setContext(memorySelectionKey(), null, true);
      const previous = manager.getStatus();
      manager.clearCurrent();
      return lifecycle.switchChat(
        previous?.kind === "active" ? previous.space.id : undefined,
        stoppingAutoFill,
        async () => {
          if (settings.read().enabled) {
            await syncCurrentChat();
          }
          autoFill.chatReady();
        },
      );
    },
    onMessageEvent: (kind, floor) => {
      if (kind === "message_received") {
        autoFill.messageReceived(floor);
      }
      return kind === "message_sent" && floor !== undefined
        ? macro.messageSent(adapter.getMessageAt(floor))
        : undefined;
    },
    onGenerationStarted: (type, options, dryRun) => {
      macro.started(type, options, dryRun);
      if (!dryRun && type !== "quiet" && type !== "impersonate") {
        autoFill.generationStarted();
      }
    },
    onGenerationAfterCommands: (type, options, dryRun) => {
      let lastUserMessage: string | null = null;
      for (let floor = adapter.chatMessageCount() - 1; floor >= 0; floor--) {
        const message = adapter.getMessageAt(floor);
        if (message?.isUser) {
          lastUserMessage = message.content;
          break;
        }
      }
      return macro.afterCommands(type, options, dryRun, lastUserMessage);
    },
    onGenerationEnded: () => autoFill.generationEnded(),
    onGenerationStopped: () => {
      autoFill.generationStopped();
      macro.cancel("ST 已停止生成");
    },
    onGenerationFinished: (dryRun) => macro.generationFinished(dryRun),
    shouldAwaitMacros: macro.isPreparing,
    onGroupStarted: () => macro.groupStarted(),
    onGroupEnded: () => macro.groupEnded(),
    onMessageChanged: () => macro.markStale(),
  });

  // Agent 预设宏（ticket 17 / ADR 0006）：{{tablesDigest}}/{{systemDefaultPrompt}} 注册 +
  // 预计算快照（digest 摘要 + 默认提示词全文）随变更指纹重建；
  // 插件停用时注销（读 enabled 门控）。
  const agentMacro = new AgentMacroService({
    getSpaceId: () => {
      const status = manager.getStatus();
      return status?.kind === "active" ? status.space.id : undefined;
    },
    reader,
    readEnabled: () => settings.read().enabled,
    registerMacro: adapter.macroRegistration,
    log: {
      info: (message) => log.info(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
      warn: (message) => log.warn(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
      error: (message) => log.error(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
    },
  });

  if (settings.read().enabled) {
    try {
      await syncCurrentChat();
    } catch (error) {
      manager.reportLoadError(error);
      log.error("记忆空间初始化失败", error);
    }
    const status = manager.getStatus();
    if (status?.kind === "active") {
      vectorSync.activate(status.space.id);
    }
  }
  // 空间就绪后注册宏，表达式只在实际生成或显式测试时求值。
  autoFill.start();
  await macro.start();
  await agentMacro.start();
  // 空间切换时刷新注册并使旧结果失效，Agent 提示词摘要沿用自身刷新机制。
  manager.onStatusChange(() => {
    const status = manager.getStatus();
    vectorSync.activate(status?.kind === "active" ? status.space.id : undefined);
    autoFill.kick();
    void refreshChatMacros().catch((error) => log.error("对话宏读取失败", error));
    void macro.kick().catch((error) => {
      log.error(`[${PLUGIN_DISPLAY_NAME}] 记忆宏注册刷新失败`, error);
    });
    void agentMacro.kick().catch((error) => {
      log.error(`[${PLUGIN_DISPLAY_NAME}] Agent 预设宏快照重建失败`, error);
    });
  });
  const settingsService = new SettingsService({
    store: settings,
    refreshAutoFill: () => autoFill.kick(),
    syncToCurrentChat: () => syncCurrentChat(),
    refreshMemoryMacros: () => macro.kick(),
    validateMacros,
    getChatScopeMacros: () => chatMacros,
    getChatContext: memorySelectionKey,
    refreshAgentMacros: () => agentMacro.kick(),
    writeChatScopeMacros: writeChatMacros,
    refreshVectorIndex: () => {
      retrieval.profileChanged();
      return vectorSync.refreshSettings();
    },
  });
  const presetUpdate = new PresetSpaceUpdater({
    memory: memoryStore,
    manager,
    settings,
    tasks,
    presetApply,
    forceSync: (id, assertActive) => lifecycle.forceSync(id, assertActive),
    saveSnapshot,
    retrieval,
    macro,
    vector,
    vectors: vectorRepository,
    getSelectionKey: memorySelectionKey,
    ids: {
      table: () => createId("table") as MemoryTableId,
      field: () => createId("field") as MemoryFieldId,
      group: () => createId("vector-group"),
    },
    now,
  });
  const publicRead = new PublicMemoryReader(
    () => {
      const status = manager.getStatus();
      const chat = adapter.getChatSnapshot();
      const identity = chatIdentityKey(chat) ?? null;
      const active = status?.kind === "active";
      const bound =
        active && (status.binding.version === 1 || status.binding.chatIdentity === identity);
      return {
        chatIdentity: identity,
        chatName: chat.chatId ?? null,
        spaceId: active ? status.space.id : null,
        spaceName: active ? status.space.name : null,
        available: Boolean(bound),
        message: bound
          ? null
          : status && "humanMsg" in status
            ? status.humanMsg
            : status?.kind === "branch-detected"
              ? "请先在 Memory 中处理当前聊天的分支绑定"
              : "当前对话的记忆空间尚未就绪",
      };
    },
    async (spaceId) => {
      if (!memoryStore.hasSpace(spaceId)) {
        throw new Error("当前记忆空间已不存在");
      }
      return sqlite.readSnapshot(spaceId);
    },
    sqlite,
    async (spaceId) => {
      if (!memoryStore.hasSpace(spaceId)) {
        throw new Error("当前记忆空间已不存在");
      }
    },
    createMemoryChatApi({
      getChatIdentity: () => chatIdentityKey(adapter.getChatSnapshot()) ?? null,
      readRecentMessages: (count) => adapter.recentStoryMessages(count),
      readCleaningRule: () => {
        const selection = adapter.cleaningRuleStore.read();
        const rule = findSelectedCleaningRule(settings.read().cleaningRules, selection);
        if (selection !== undefined && !rule) {
          throw new Error("当前聊天所选清洗规则已不存在，请在 Memory 中重新选择");
        }
        return rule;
      },
    }),
  );
  manager.onStatusChange(() => publicRead.invalidate());
  memoryStore.subscribe((spaceId) => {
    macro.markStale();
    if (publicRead.getContext().spaceId === spaceId) {
      publicRead.invalidate();
    }
    retrieval.invalidate(spaceId as MemorySpaceId);
    vectorSync.committed(spaceId as MemorySpaceId);
    void macro.kick().catch((error) => log.error("记忆宏刷新失败", error));
    void agentMacro.kick().catch((error) => log.error("Agent摘要刷新失败", error));
    void manager
      .refreshSpace(spaceId as MemorySpaceId)
      .catch((error) => log.error("空间状态刷新失败", error));
    void refreshChatMacros().catch((error) => log.error("空间宏读取失败", error));
  });
  const forceSyncMemory = async (): Promise<void> => {
    const status = manager.getStatus();
    const target = adapter.captureFileTarget();
    const selectionKey = memorySelectionKey();
    if (status?.kind !== "active" || !target) {
      throw new Error("当前聊天记忆尚未就绪");
    }
    await lifecycle.forceSync(status.space.id, () => {
      if (memorySelectionKey() !== selectionKey) {
        throw new Error("聊天已切换，请在当前聊天重新强制同步");
      }
    });
    autoFill.kick();
  };
  return {
    publicRead,
    manager,
    retryMemorySave: forceSyncMemory,
    forceSyncMemory,
    adapter,
    spaces,
    tables,
    fields,
    records,
    backup,
    settings,
    settingsService,
    normalizeImportedSpace,
    persistence,
    tasks,
    vector,
    retrieval,
    sqlConsole: {
      async execute(spaceId, sql, signal) {
        if (!memoryStore.hasSpace(spaceId)) {
          throw new Error(`记忆空间不存在: ${spaceId}`);
        }
        const selectionKey = memorySelectionKey();
        const started = performance.now();
        const results: SqlResultSet[] = [];
        let changes = 0;
        let transactionOpen: boolean;
        let semantic: SqlExecutionResult["semantic"];
        let remainingSql = sql;
        try {
          do {
            signal?.throwIfAborted();
            lifecycle.assertCanEdit(spaceId);
            if (memorySelectionKey() !== selectionKey || currentSpaceId() !== spaceId) {
              throw new Error("聊天或空间已切换，SQL 执行已停止");
            }
            const chunk = await sqlite.executeConsole(spaceId, remainingSql);
            signal?.throwIfAborted();
            results.push(...chunk.results);
            changes += chunk.changes;
            transactionOpen = chunk.transactionOpen;
            if (!chunk.semanticStatement) {
              break;
            }
            const result = await semanticQuery(spaceId, {
              sql: chunk.semanticStatement.sql,
              signal,
            });
            results.push({
              columns: result.columns,
              rows: result.rows as readonly (readonly SqlValue[])[],
            });
            const sources = result.sources.map(({ table, groups, coverage }) => ({
              table,
              groups,
              coverage,
            }));
            if (!semantic) {
              semantic = { sources, diagnostics: result.diagnostics };
            } else {
              semantic = {
                sources: [...semantic.sources, ...sources],
                diagnostics: {
                  sqlPasses: semantic.diagnostics.sqlPasses + result.diagnostics.sqlPasses,
                  sqlMs: semantic.diagnostics.sqlMs + result.diagnostics.sqlMs,
                  preparedSources:
                    semantic.diagnostics.preparedSources + result.diagnostics.preparedSources,
                  queryTexts: semantic.diagnostics.queryTexts + result.diagnostics.queryTexts,
                  queryVectors: {
                    requests:
                      semantic.diagnostics.queryVectors.requests +
                      result.diagnostics.queryVectors.requests,
                    executionHits:
                      semantic.diagnostics.queryVectors.executionHits +
                      result.diagnostics.queryVectors.executionHits,
                    sharedHits:
                      semantic.diagnostics.queryVectors.sharedHits +
                      result.diagnostics.queryVectors.sharedHits,
                  },
                },
              };
            }
            remainingSql = chunk.semanticStatement.remainingSql;
          } while (remainingSql.trim());
          return {
            results,
            changes,
            transactionOpen,
            elapsedMs: performance.now() - started,
            ...(semantic ? { semantic } : {}),
          };
        } finally {
          retrieval.invalidate(spaceId, "SQL 已执行，请重新搜索");
          macro.kick();
        }
      },
      async schema(spaceId) {
        if (!memoryStore.hasSpace(spaceId)) {
          throw new Error(`记忆空间不存在: ${spaceId}`);
        }
        const [entries, snapshot] = await Promise.all([
          sqlite.consoleSchema(spaceId),
          memoryStore.snapshot(spaceId),
        ]);
        if (!snapshot) {
          throw new Error(`记忆空间不存在: ${spaceId}`);
        }
        return entries.map((entry) => {
          const table = snapshot.tables.find((table) => table.key === entry.name && table.enabled);
          if (!table?.vectorIndex?.enabled) {
            return entry;
          }
          const fields = snapshot.fields.filter((field) => field.tableId === table.id);
          return {
            ...entry,
            vectorGroups: effectiveVectorIndexGroups(table.vectorIndex, fields)
              .filter(
                (group) =>
                  group.fieldIds.length &&
                  group.fieldIds.every((id) =>
                    fields.some((field) => field.id === id && field.enabled),
                  ),
              )
              .map((group) => group.key),
          };
        });
      },
    },
    autoFill,
    spaceMaintenance,
    presetApply,
    presetUpdate,
    logs,
    macro,
    agentMacro,
    // Agent 预设预览（issue 01）：端口装配在所属功能，runtime 只接线
    presetPreview: createPresetPreviewPorts({
      readSnapshot: () => adapter.getPromptSnapshot(),
      readSpaceId: () => {
        const status = manager.getStatus();
        return status?.kind === "active" ? status.space.id : undefined;
      },
      readDigest: (memorySpaceId) => buildMemorySpaceTableDigest(reader, memorySpaceId),
      getStContext: () => getContext() as StContext,
      logWarn: (message) => log.warn(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
    }),
    // 宏内容一览（issue 01）：读取器在所属功能装配，runtime 只接线数据源
    macroOverview: createMacroOverviewReader({
      readSettings: () => ({
        macroName: settings.read().macroName,
        macros: settings.read().macros,
      }),
      resolveRegistrationName: resolveMacroRegistrationName,
      readDefaultSnapshot: () => macro.getSnapshot(),
      readViewSnapshot: (viewName) => macro.getViewSnapshot(viewName),
      readChannelScopeMacros: () => chatMacros,
      readChatScopeSnapshot: (name) => macro.getChatScopeSnapshot(name),
      readBuiltinNames: () => macro.builtinSnapshotNames(),
      readBuiltinSnapshot: (name) => macro.getBuiltinSnapshot(name),
      readAgentMacros: () => {
        const snapshot = agentMacro.getSnapshot();
        return [
          { name: `{{${AGENT_TABLES_DIGEST_MACRO}}}`, text: snapshot.digestText },
          { name: `{{${AGENT_SYSTEM_DEFAULT_PROMPT_MACRO}}}`, text: snapshot.defaultPromptText },
        ];
      },
    }),
    createLlm,
    createQueryChatLlm,
    queryChat,
    version: options.version ?? "",
    // 对话级 Agent 预设覆盖：undefined = 跟随全局活动预设
    agentPresetOverride: {
      read: () => adapter.agentPresetStore.read(),
      write: (presetId) => adapter.agentPresetStore.write(presetId),
    },
    // 清洗规则（ticket 22 / ADR 0011）：当前对话规则选择读写
    cleaning: {
      readSelection: () => adapter.cleaningRuleStore.read(),
      writeSelection: (ruleId) => adapter.cleaningRuleStore.write(ruleId),
      readRecentMessages: (count) => adapter.recentMessages(count),
      readChatScopeMacros: () => chatMacros,
      writeChatScopeMacros: writeChatMacros,
    },
    // 弹窗 API（分支检测等需要用户交互的场景）
    popup: {
      show: (content, options) => adapter.showPopup(content, options),
    },
  };
}
