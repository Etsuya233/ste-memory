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
import {
  buildPresetUpdate,
  previewPresetUpdate,
  type PresetSpaceUpdateService,
} from "./features/table-presets/preset-space-update.ts";
import { VectorRetrievalService } from "./features/vector-retrieval/vector-retrieval-service.ts";
import { trackRetrievalChanges } from "./infrastructure/indexeddb/retrieval-change-sync.ts";
import {
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
import { ChatMetadataMirrorSync } from "./features/chat-mirror/chat-metadata-mirror-sync.ts";
import {
  ChatSnapshotPersistence,
  type ChatSnapshotFileStore,
  type ChatFileTarget,
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
  DexieFloorLedgerRepository,
  DexieLogRepository,
  type DexieMemoryBackupRepository,
  DexieMemoryChangeSource,
  SteMemoryDatabase,
  SteMemoryLogDatabase,
} from "./infrastructure/indexeddb/index.ts";
import { FillTaskService } from "./features/fill-tasks/fill-task-service.ts";
import { VectorIndexService } from "./features/vector-index/index.ts";
import type { VectorEmbeddingPort } from "./features/vector-index/index.ts";
import { DexieVectorIndexRepository } from "./infrastructure/indexeddb/vector-index/vector-index-repository.ts";
import { VectorIndexChangeSync } from "./infrastructure/indexeddb/vector-index-change-sync.ts";
import { OpenAiEmbeddingPort } from "./infrastructure/sillytavern/embedding/openai-embedding.ts";
import { SpaceMaintenanceService } from "./features/space-maintenance/space-maintenance-service.ts";
import { QueryChatService } from "./features/query-chat/query-chat-service.ts";
import type { Table } from "dexie";
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
import { ChatSpaceManager, chatIdentityKey } from "./features/chat-binding/chat-space-manager.ts";
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
  /** Retry the committed snapshot's cache and file persistence without replaying edits. */
  readonly retryMemorySave: () => Promise<void>;
  /** 全库备份（导出/导入，ticket 07）：快照读取与整体还原 */
  readonly backup: MemoryBackupRepository;
  /** Dexie 备份仓库（扩展方法：cloneSpace 用于分支对话分离） */
  readonly backupRepo: DexieMemoryBackupRepository;
  /** 插件设置存储（设置面板读写与运行时开关门控共用同一实例） */
  readonly settings: SettingsStore;
  readonly settingsService: SettingsService;
  readonly normalizeImportedSpace: (unit: MemorySpaceBackup) => Promise<MemorySpaceBackup>;
  /** 对话文件镜像（ticket 16）：状态订阅 + 设置变化 kick；随聊天文件同步记忆快照 */
  readonly mirror: ChatMetadataMirrorSync;
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
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 启动插件运行时（组合根，bootstrap 在 ST 环境可用时调用）：
 * Dexie 持久层 + Memory 服务 + 表格预设（结构初始化/应用）+ ST 适配器 + 事件桥
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

  const sqlite = await (options.createSqlite ?? createSqliteMemoryClient)();
  const memoryStore = new SqliteMemoryStore(sqlite, db);
  const repositories = memoryStore.repositories();
  const {
    spaces: spaceRepository,
    tables: tableRepository,
    fields: fieldRepository,
    records: recordRepository,
  } = repositories;
  const backup = new SqliteMemoryBackupRepository(
    db,
    memoryStore,
    options.createSqlite ?? createSqliteMemoryClient,
  );
  const spaceStructureRebuild = memoryStore.structureRebuild();

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
  // repository；批次提交 + 台账标记包在同一个 Dexie 事务（失败回滚不产生半批数据/半批状态）。
  const adapter = new StChatAdapter(() => getContext() as StContext);
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
      if (!(await memoryStore.ensure(id))) throw new Error(`记忆空间不存在: ${id}`);
      const allowedTables: Record<string, readonly string[]> = {};
      const display = createReadTimeDisplayTextResolver({
        getTable: (tableId) => repos.tables.find(id, tableId),
        getFields: (tableId) => repos.fields.list(id, tableId),
        findRecord: (tableId, recordId) =>
          repos.records.find(id, tableId, recordId as MemoryRecordId),
      });
      for (const table of await repos.tables.list(id)) {
        if (!table.enabled) continue;
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
  const persistence = new ChatSnapshotPersistence(
    options.snapshotFiles ?? adapter.snapshotFileStore,
    () => options.version ?? "",
  );
  const targets = new Map<string, ChatFileTarget>();
  const saveSnapshot = async (unit: MemorySpaceBackup): Promise<void> => {
    if (!settings.read().enabled || !settings.read().mirror.enabled) return;
    const target = targets.get(unit.space.id);
    if (!target) return; // New spaces acquire their file target when the binding is published.
    const binding = adapter.bindingStore.read();
    const ownBinding =
      binding.kind === "bound" &&
      binding.binding.spaceId === unit.space.id &&
      chatIdentityKey(adapter.getChatSnapshot()) === target.identity
        ? binding.binding
        : undefined;
    await persistence.save(target, unit, ownBinding);
  };
  memoryStore.onCommitted = saveSnapshot;
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
  /**
   * 填表任务台账使用 Dexie 原子事务；scope 必须声明为 async，
   * 供 Dexie expected-awaits 追踪，避免 PrematureCommit。
   * 记忆记录的提交事务由 MemoryRecordService 管理。
   */
  const runInTransaction = (tables: readonly Table[]) => (work: () => Promise<void>) =>
    db.transaction("rw", tables, async () => {
      await work();
    });
  const fillTaskRepository = new DexieFillTaskRepository(db, now);
  const floorLedgerRepository = new DexieFloorLedgerRepository(db);
  const tasks = new FillTaskService({
    onAutomaticSuccess: (task): Promise<void> => autoFill.taskSucceeded(task),
    tasks: fillTaskRepository,
    ledger: floorLedgerRepository,
    logs,
    source: adapter,
    beginTask: async (task, signal): Promise<FillTaskSession> => {
      signal.throwIfAborted();
      const token = await memoryStore.begin(task.memorySpaceId);
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
        commitAndSave: async () => {
          signal.throwIfAborted();
          await memoryStore.consolidateTask(
            baseline,
            token,
            createId("revision") as MemoryRevisionId,
            now(),
          );
          ended = true;
          await memoryStore.finish(task.memorySpaceId, token, true);
        },
        rollback: async () => {
          if (ended) return;
          ended = true;
          await memoryStore.finish(task.memorySpaceId, token, false);
        },
        release: async () => {
          if (ended) return;
          ended = true;
          await memoryStore.finish(task.memorySpaceId, token, false);
        },
      };
    },
    runInTransaction: runInTransaction([db.floorFillLedger, db.memoryFillTasks]),
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

  const mirror = new ChatMetadataMirrorSync({
    directSave: async (id, expectedIdentity) => {
      if (chatIdentityKey(adapter.getChatSnapshot()) !== expectedIdentity)
        throw new Error("对话已切换，未保存当前快照");
      const target = adapter.captureFileTarget();
      if (target) targets.set(id, target);
      const unit = await memoryStore.snapshot(id);
      if (unit) await saveSnapshot(unit);
    },
    getChat: () => adapter.getChatSnapshot(),
    bindingStore: adapter.bindingStore,
    mirrorStore: adapter.mirrorStore,
    backup,
    changes: new DexieMemoryChangeSource(db),
    isEnabled: () => settings.read().enabled && settings.read().mirror.enabled,
    includeHistory: () => true,
    appVersion: () => options.version ?? "",
    now: () => new Date(),
    log: {
      info: (message) => log.info(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
      warn: (message) => log.warn(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
      error: (message) => log.error(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
    },
  });
  persistence.onStatusChange(() => mirror.reportSaveStatus(persistence.getStatus()));
  const presetApply = new TablePresetApplyService({
    validateStructure: async (structure) => {
      if (!structure.macros.length) return structure;
      const at = now();
      const snapshot: MemorySpaceBackup = {
        space: {
          id: structure.tables[0]?.memorySpaceId ?? ("preset-validation" as MemorySpaceId),
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
    rebuild: spaceStructureRebuild,
    defaultPreset: () =>
      resolveDefaultTablePreset(settings.read().tablePresets, SYSTEM_TABLE_PRESET),
    currentChatIdentity: () => chatIdentityKey(adapter.getChatSnapshot()),
    clearChatScopeMacros: () => adapter.chatScopeMacroStore.write([]),
    createIds: {
      table: () => createId("table") as MemoryTableId,
      field: () => createId("field") as MemoryFieldId,
      group: () => createId("vector-group"),
    },
    now,
  });
  const newBindings = new Set<string>();
  const branchSources = new Map<MemorySpaceId, MemorySpaceBackup>();
  const manager = new ChatSpaceManager({
    getChat: () => adapter.getChatSnapshot(),
    bindingStore: {
      read: () => adapter.bindingStore.read(),
      write: (binding) => {
        const previous = adapter.bindingStore.read();
        const target = adapter.captureFileTarget();
        if (target) targets.set(binding.spaceId, target);
        if (previous.kind !== "bound" || previous.binding.spaceId !== binding.spaceId)
          newBindings.add(binding.spaceId);
        adapter.bindingStore.write(binding);
      },
    },
    prepareSpace: async (binding) => {
      const target = adapter.captureFileTarget();
      if (!target) throw new Error("当前对话缺少可保存的文件身份");
      targets.set(binding.spaceId, target);
      if (!settings.read().mirror.enabled || newBindings.has(binding.spaceId)) return false;
      const existed = await db.memorySpaces.get(binding.spaceId);
      const unit = await persistence.load(target, binding.spaceId);
      if (chatIdentityKey(adapter.getChatSnapshot()) !== target.identity) return false;
      if (unit && binding.version === 2 && binding.chatIdentity !== target.identity) {
        const sameFileImport =
          !existed &&
          target.kind === "character" &&
          binding.chatIdentity.replace(/^char:[^:]+:/, "") === target.chatId;
        if (!sameFileImport) {
          branchSources.set(binding.spaceId, unit);
          return { restored: false, space: unit.space };
        }
      }
      if (unit) await memoryStore.replace(unit);
      return unit !== undefined && existed === undefined;
    },
    branchSource: (id) => branchSources.get(id),
    onReady: async (binding) => {
      const unit = await memoryStore.snapshot(binding.spaceId);
      if (unit) await saveSnapshot(unit);
      newBindings.delete(binding.spaceId);
    },
    spaces,
    installer: { installDefaultStructure: (id) => presetApply.installDefaultStructure(id) },
    log: { info: (message) => log.info(`[${PLUGIN_DISPLAY_NAME}] ${message}`) },
    // 新空间副本重新编译宏依赖，避免导入元数据伪装成普通 SQL。
    backup: {
      cloneSpace: async (id, ids) => {
        const snapshot = await backup.loadSnapshot();
        const unit = snapshot.spaces.find((item) => item.space.id === id);
        if (!unit) throw new Error(`源空间不存在：${id}`);
        const committed = await memoryStore.snapshot(id);
        if (!committed) throw new Error(`源空间尚未就绪：${id}`);
        return backup.cloneSpaceFromUnit(
          await normalizeImportedSpace({ ...unit, ...committed }),
          ids,
        );
      },
      cloneSpaceFromUnit: async (unit, ids) =>
        backup.cloneSpaceFromUnit(await normalizeImportedSpace(unit), ids),
    },
    createId,
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
  const retrievalContext = () => {
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
    retrievalContext,
  );
  const currentSpaceId = () => {
    const status = manager.getStatus();
    return status?.kind === "active" ? status.space.id : null;
  };
  let chatMacros: readonly MemoryMacro[] = [];
  const syncRetrievalContext = () => retrieval.setContext(retrievalContext(), currentSpaceId());
  manager.onStatusChange(syncRetrievalContext);
  trackRetrievalChanges(db, retrieval);
  await vector.start();
  const vectorSync = new VectorIndexChangeSync(
    db,
    vector,
    () => settings.read().enabled,
    (error) => log.error(`[${PLUGIN_DISPLAY_NAME}] 向量索引核对失败`, error),
  );
  vectorSync.start();

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
      if (!(await memoryStore.ensure(spaceId))) throw new Error(`记忆空间不存在: ${spaceId}`);
      const snapshot = await memoryStore.snapshot(spaceId);
      if (!snapshot) throw new Error(`记忆空间不存在: ${spaceId}`);
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
  let assistantContextGeneration = 0;
  manager.onStatusChange(() => {
    assistantContextGeneration++;
  });
  await assistantStore.ready;
  const queryChat = new QueryChatService({
    store: assistantStore,
    semanticQuery,
    reader,
    ports: { tables: tableRepository, fields: fieldRepository, records: recordRepository },
    recordWriter: records,
    createLlm: createQueryChatLlm,
    getCurrentContext: () => {
      if (!settings.read().enabled) return undefined;
      const status = manager.getStatus();
      const chatKey = chatIdentityKey(adapter.getChatSnapshot());
      return status?.kind === "active" && chatKey
        ? { chatKey, spaceId: status.space.id, generation: assistantContextGeneration }
        : undefined;
    },
  });

  // 空间维护：清除空间记录（保留表格结构与初始化来源）；按预设重建统一走
  // 表格预设的应用流程（TablePresetApplyService）。
  const spaceMaintenance = new SpaceMaintenanceService({
    clearRecords: (id) => spaces.clearRecords(id),
    cancelActiveTask: (id) => tasks.cancelAll(id),
    clearTasks: (id) => fillTaskRepository.clear(id),
    clearLedger: (id) => floorLedgerRepository.clear(id),
  });

  // 页面/浏览器重开：运行项标记 interrupted 并暂停队列，等待项保留
  await tasks.markInterruptedOnStartup();
  // 镜像同步启动：本地变更在轮询中回填进对话文件（文件自洽）
  await mirror.start();

  const refreshChatMacros = async () => {
    const context = retrievalContext();
    const id = currentSpaceId();
    const space = id ? await spaces.find(id) : undefined;
    if (context === retrievalContext()) chatMacros = space?.macros ?? [];
  };
  const createMacroBatch = (
    snapshot: MemorySpaceBackup,
    context: { lastUserMessage: string | null; signal: AbortSignal; deadline: number },
  ) => createMacroEvaluationBatch(semanticEvaluationInput(snapshot, context));
  const classifyMacros = async (
    snapshot: MemorySpaceBackup,
    macros: readonly MemoryMacro[],
  ): Promise<readonly MemoryMacro[]> => {
    if (!macros.length) return macros;
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
    if (!macros.length) return macros;
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
      } else pending.push(macro);
    }
    if (!pending.length) return macros.map((macro) => normalized.get(macro.id)!);
    const id = currentSpaceId();
    if (!id) {
      if (pending.some((macro) => macro.expression.language === "sql"))
        throw new Error("请先打开已绑定记忆空间的对话，再保存 SQL 宏");
      for (const macro of pending) normalized.set(macro.id, macro);
      return macros.map((macro) => normalized.get(macro.id)!);
    }
    const snapshot = await memoryStore.snapshot(id);
    if (!snapshot) throw new Error("当前记忆空间尚未准备好");
    for (const macro of await classifyMacros(snapshot, pending)) normalized.set(macro.id, macro);
    return macros.map((macro) => normalized.get(macro.id)!);
  };
  const normalizeImportedSpace = async (unit: MemorySpaceBackup): Promise<MemorySpaceBackup> => ({
    ...unit,
    space: { ...unit.space, macros: await classifyMacros(unit, unit.space.macros ?? []) },
    ...(unit.chatScopeMacros === undefined
      ? {}
      : { chatScopeMacros: await classifyMacros(unit, unit.chatScopeMacros) }),
  });
  const writeChatMacros = async (macros: readonly MemoryMacro[]) => {
    const id = currentSpaceId();
    const context = retrievalContext();
    if (!id) throw new Error("当前对话尚未准备好");
    const saved = await spaces.setMacros(id, macros);
    if (!saved) throw new Error("记忆空间已不存在");
    if (context !== retrievalContext()) return;
    chatMacros = macros;
    await manager.refreshSpace(id);
  };
  const macro = new MemoryMacroService({
    getContext: retrievalContext,
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
  memoryStore.onCommitted = async (snapshot) => {
    macro.markStale();
    await saveSnapshot(snapshot);
  };
  const autoFill = new AutoFillService({
    hideFloors: (identity, to) => adapter.hideFloors(identity, to),
    tasks,
    chatStore: adapter.autoFillStore,
    globalSettings: () => settings.read().autoFill,
    current: () => {
      const status = manager.getStatus();
      const snapshot = adapter.getChatSnapshot();
      const identity = chatIdentityKey(snapshot);
      if (!settings.read().enabled || status?.kind !== "active" || !identity) return undefined;
      const binding = adapter.bindingStore.read();
      if (binding.kind !== "bound" || binding.binding.spaceId !== status.space.id) return undefined;
      if (binding.binding.version === 2 && binding.binding.chatIdentity !== identity)
        return undefined;
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
    const state = await manager.syncToCurrentChat();
    await refreshChatMacros();
    if (state.kind === "active") await macro.migrateLegacyChatMacros();
    return state;
  }

  let switching = Promise.resolve();
  adapter.registerEventBridge({
    onChatChanged: () => {
      const stoppingAutoFill = autoFill.chatChanged();
      macro.chatChanged();
      chatMacros = [];
      chatEpoch++;
      retrieval.setContext(retrievalContext(), null, true);
      // 插件总开关门控：停用期间不响应切对话（重新启用时由设置面板触发同步）
      if (!settings.read().enabled) return;
      const previous = manager.getStatus();
      manager.clearCurrent();
      const next = switching.then(async () => {
        await stoppingAutoFill;
        await tasks.interruptForChatChange();
        if (previous?.kind === "active") {
          await memoryStore.whenIdle(previous.space.id);
          const snapshot = await memoryStore.snapshot(previous.space.id);
          // Capture/export precedes closing SQLite. The file writer owns its independent copy.
          if (snapshot)
            void saveSnapshot(snapshot).catch((error) => log.error("旧对话记忆保存失败", error));
          await memoryStore.unload(previous.space.id);
        }
        await syncCurrentChat();
        autoFill.chatReady();
      });
      switching = next.catch((error) => {
        manager.reportLoadError(error);
        log.error(`[${PLUGIN_DISPLAY_NAME}] 同步空间上下文失败`, error);
      });
      return switching;
    },
    onMessageEvent: (kind, floor) =>
      kind === "message_sent" && floor !== undefined
        ? macro.messageSent(adapter.getMessageAt(floor))
        : undefined,
    onGenerationStarted: (type, options, dryRun) => {
      macro.started(type, options, dryRun);
      if (!dryRun && type !== "quiet" && type !== "impersonate") autoFill.generationStarted();
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
    onGenerationStopped: () => macro.cancel("ST 已停止生成"),
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
    changes: new DexieMemoryChangeSource(db),
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
    if (status?.kind === "active") vectorSync.activate(status.space.id);
  }
  // 空间就绪后注册宏，表达式只在实际生成或显式测试时求值。
  autoFill.start();
  await macro.start();
  await agentMacro.start();
  // 空间切换时刷新注册并使旧结果失效，Agent 提示词摘要沿用自身刷新机制。
  manager.onStatusChange(() => {
    const status = manager.getStatus();
    if (status?.kind === "active") vectorSync.activate(status.space.id);
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
    getChatContext: retrievalContext,
    refreshAgentMacros: () => agentMacro.kick(),
    refreshMirror: () => mirror.kick(),
    writeChatScopeMacros: writeChatMacros,
    refreshVectorIndex: () => {
      retrieval.profileChanged();
      return vectorSync.refreshSettings();
    },
  });
  const assertUpdateTarget = (spaceId: MemorySpaceId, chatIdentity: string) => {
    presetApply.assertCurrentChat(chatIdentity);
    const status = manager.getStatus();
    if (!settings.read().enabled || status?.kind !== "active" || status.space.id !== spaceId)
      throw new Error("当前空间绑定或插件状态已变化，请重新比较");
  };
  const finishPresetUpdate = async (spaceId: MemorySpaceId, initialIssues: string[] = []) => {
    const issues = [...initialIssues];
    try {
      await manager.refreshSpace(spaceId);
    } catch (error) {
      issues.push(`空间状态刷新失败：${error instanceof Error ? error.message : String(error)}`);
    }
    retrieval.invalidate(spaceId, "空间已更新，请重新搜索");
    try {
      await macro.kick();
    } catch (error) {
      issues.push(`宏刷新失败：${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await vector.reconcile({ memorySpaceId: spaceId });
      const latest = await memoryStore.snapshot(spaceId);
      if (!latest) throw new Error("记忆空间不存在");
      const groupIds = new Map(
        latest.tables.map((table) => [
          table.id,
          new Set(
            effectiveVectorIndexGroups(
              table.vectorIndex,
              latest.fields.filter((field) => field.tableId === table.id),
            ).map((group) => group.id),
          ),
        ]),
      );
      const recordIds = new Set(latest.records.map((record) => record.id));
      for (const item of await vectorRepository.listVectors({ memorySpaceId: spaceId })) {
        if (!recordIds.has(item.recordId) || !groupIds.get(item.tableId)?.has(item.groupId))
          await vectorRepository.deleteVector(item.id);
      }
      for (const suppression of await vectorRepository.listSuppressions()) {
        if (suppression.memorySpaceId !== spaceId) continue;
        const [, tableId, recordId, groupId] = suppression.id.split("\u0000");
        if (
          !recordIds.has(recordId as MemoryRecordId) ||
          !groupIds.get(tableId as MemoryTableId)?.has(groupId!)
        )
          await vectorRepository.deleteSuppression(suppression.id);
      }
    } catch (error) {
      issues.push(`索引处理失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return { issues };
  };
  const presetUpdate: PresetSpaceUpdateService = {
    async preview(spaceId, preset, chatIdentity) {
      assertUpdateTarget(spaceId, chatIdentity);
      const unit = await memoryStore.snapshot(spaceId);
      if (!unit) throw new Error("记忆空间不存在");
      assertUpdateTarget(spaceId, chatIdentity);
      return previewPresetUpdate(unit, preset);
    },
    async apply(plan, selectedIds, chatIdentity) {
      assertUpdateTarget(plan.spaceId, chatIdentity);
      const previewUnit = await memoryStore.snapshot(plan.spaceId);
      if (!previewUnit) throw new Error("记忆空间不存在");
      buildPresetUpdate(
        previewUnit,
        plan,
        selectedIds,
        {
          table: () => createId("table") as MemoryTableId,
          field: () => createId("field") as MemoryFieldId,
          group: () => createId("vector-group"),
        },
        now(),
      );
      await tasks.cancelAll(plan.spaceId);
      await memoryStore.whenIdle(plan.spaceId);
      const issues: string[] = [];
      await memoryStore.exclusive(plan.spaceId, async () => {
        assertUpdateTarget(plan.spaceId, chatIdentity);
        const unit = await memoryStore.snapshot(plan.spaceId);
        if (!unit) throw new Error("记忆空间不存在");
        let next = buildPresetUpdate(
          unit,
          plan,
          selectedIds,
          {
            table: () => createId("table") as MemoryTableId,
            field: () => createId("field") as MemoryFieldId,
            group: () => createId("vector-group"),
          },
          now(),
        );
        const display = createReadTimeDisplayTextResolver({
          getTable: async (id) => next.tables.find((table) => table.id === id),
          getFields: async (id) => next.fields.filter((field) => field.tableId === id),
          findRecord: async (tableId, recordId) =>
            next.records.find((record) => record.tableId === tableId && record.id === recordId),
        });
        next = {
          ...next,
          records: await Promise.all(
            next.records.map(async (record) => ({ ...record, displayText: await display(record) })),
          ),
        };
        assertUpdateTarget(plan.spaceId, chatIdentity);
        // importSpace builds and commits a separate SQLite database before publishing it.
        // It retains the old database if validation or publication fails; it does not clear vectors/tasks.
        await sqlite.importSpace(next);
        memoryStore.onPublished(plan.spaceId);
        try {
          await memoryStore.cache(next);
        } catch (error) {
          issues.push(
            `本地缓存保存失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
        try {
          await saveSnapshot(next);
        } catch (error) {
          issues.push(
            `对话文件保存失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
      return finishPresetUpdate(plan.spaceId, issues);
    },
    async retrySave(spaceId, chatIdentity) {
      assertUpdateTarget(spaceId, chatIdentity);
      const issues: string[] = [];
      await memoryStore.exclusive(spaceId, async () => {
        const latest = await memoryStore.snapshot(spaceId);
        if (!latest) throw new Error("记忆空间不存在");
        try {
          await memoryStore.cache(latest);
        } catch (error) {
          issues.push(
            `本地缓存保存失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
        try {
          await saveSnapshot(latest);
        } catch (error) {
          issues.push(
            `对话文件保存失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
      return finishPresetUpdate(spaceId, issues);
    },
  };
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
      if (!(await memoryStore.ensure(spaceId))) throw new Error("当前记忆空间已不存在");
      return sqlite.readSnapshot(spaceId);
    },
    sqlite,
    async (spaceId) => {
      if (!(await memoryStore.ensure(spaceId))) throw new Error("当前记忆空间已不存在");
    },
    createMemoryChatApi({
      getChatIdentity: () => chatIdentityKey(adapter.getChatSnapshot()) ?? null,
      readRecentMessages: (count) => adapter.recentStoryMessages(count),
      readCleaningRule: () => {
        const selection = adapter.cleaningRuleStore.read();
        const rule = findSelectedCleaningRule(settings.read().cleaningRules, selection);
        if (selection !== undefined && !rule)
          throw new Error("当前聊天所选清洗规则已不存在，请在 Memory 中重新选择");
        return rule;
      },
    }),
  );
  manager.onStatusChange(() => publicRead.invalidate());
  memoryStore.onPublished = (spaceId) => {
    if (publicRead.getContext().spaceId === spaceId) publicRead.invalidate();
  };
  return {
    publicRead,
    manager,
    retryMemorySave: async () => {
      const status = manager.getStatus();
      if (status?.kind !== "active") throw new Error("当前对话的记忆空间尚未就绪");
      await memoryStore.write(status.space.id, async () => undefined);
    },
    adapter,
    spaces,
    tables,
    fields,
    records,
    backup,
    backupRepo: backup,
    settings,
    settingsService,
    normalizeImportedSpace,
    mirror,
    tasks,
    vector,
    retrieval,
    sqlConsole: {
      async execute(spaceId, sql, signal) {
        if (!(await memoryStore.ensure(spaceId))) throw new Error(`记忆空间不存在: ${spaceId}`);
        const started = performance.now();
        const results: SqlResultSet[] = [];
        let changes = 0;
        let transactionOpen: boolean;
        let semantic: SqlExecutionResult["semantic"];
        let remainingSql = sql;
        try {
          do {
            signal?.throwIfAborted();
            const chunk = await sqlite.executeConsole(spaceId, remainingSql);
            signal?.throwIfAborted();
            results.push(...chunk.results);
            changes += chunk.changes;
            transactionOpen = chunk.transactionOpen;
            if (!chunk.semanticStatement) break;
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
            if (!semantic) semantic = { sources, diagnostics: result.diagnostics };
            else
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
        if (!(await memoryStore.ensure(spaceId))) throw new Error(`记忆空间不存在: ${spaceId}`);
        const [entries, snapshot] = await Promise.all([
          sqlite.consoleSchema(spaceId),
          memoryStore.snapshot(spaceId),
        ]);
        if (!snapshot) throw new Error(`记忆空间不存在: ${spaceId}`);
        return entries.map((entry) => {
          const table = snapshot.tables.find((table) => table.key === entry.name && table.enabled);
          if (!table?.vectorIndex?.enabled) return entry;
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
