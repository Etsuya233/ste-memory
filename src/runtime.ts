import {
  MemoryRecallService,
  DEFAULT_RECALL_CONFIGURATION,
  type RecallConfiguration,
} from "./features/vector-retrieval/memory-recall-service.ts";
import { VectorRetrievalService } from "./features/vector-retrieval/vector-retrieval-service.ts";
import { trackRetrievalChanges } from "./infrastructure/indexeddb/retrieval-change-sync.ts";
import {
  MemoryFieldService,
  MemoryRecordQueryService,
  MemoryRecordService,
  MemorySpaceService,
  MemoryTableService,
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
  DexieFillTaskRepository,
  DexieFloorLedgerRepository,
  DexieLogRepository,
  DexieMemoryBackupRepository,
  DexieMemoryFieldRepository,
  DexieMemoryChangeSource,
  DexieMemoryRecordRepository,
  DexieMemorySpaceRepository,
  DexieMemoryTableRepository,
  DexieSpaceStructureRebuild,
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
import { resolveSelectedCleaningRules } from "./features/cleaning/cleaning-rule-lists.ts";
import type { MemoryView } from "./features/macros/memory-views.ts";
import { ChatSpaceManager, chatIdentityKey } from "./features/chat-binding/chat-space-manager.ts";
import { TablePresetApplyService } from "./features/table-presets/table-preset-apply-service.ts";
import { SYSTEM_TABLE_PRESET } from "./features/table-presets/system-preset.ts";
import { resolveDefaultTablePreset } from "./features/table-presets/preset-model.ts";
import {
  StChatAdapter,
  type StContext,
  type StRegexEntry,
} from "./infrastructure/sillytavern/chat-adapter.ts";
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
  readonly manager: ChatSpaceManager;
  readonly adapter: StChatAdapter;
  /** Memory 服务（面板表格列表/启停等 UI 操作入口） */
  readonly spaces: MemorySpaceService;
  readonly tables: MemoryTableService;
  readonly fields: MemoryFieldService;
  /** 记忆记录（ticket 10/11）：显示文本预览、列表/搜索分页、手动增删改入口 */
  readonly records: MemoryRecordService;
  /** 全库备份（导出/导入，ticket 07）：快照读取与整体还原 */
  readonly backup: MemoryBackupRepository;
  /** Dexie 备份仓库（扩展方法：cloneSpace 用于分支对话分离） */
  readonly backupRepo: DexieMemoryBackupRepository;
  /** 插件设置存储（设置面板读写与运行时开关门控共用同一实例） */
  readonly settings: SettingsStore;
  readonly settingsService: SettingsService;
  /** 对话文件镜像（ticket 16）：状态订阅 + 设置变化 kick；随聊天文件同步记忆快照 */
  readonly mirror: ChatMetadataMirrorSync;
  /** 填表任务（ticket 13）：手动楼层范围触发/取消 + 台账；启动时中断非终态任务 */
  readonly tasks: FillTaskService;
  readonly vector: VectorIndexService;
  readonly retrieval: VectorRetrievalService;
  readonly memoryRecall: MemoryRecallService;
  /** 空间维护（spec reset-space）：清除空间记录（危险操作区） */
  readonly spaceMaintenance: SpaceMaintenanceService;
  /** 表格预设（spec table-presets）：首次创建安装与当前空间应用（原子重建） */
  readonly presetApply: TablePresetApplyService;
  /** 通用日志（独立数据库，ADR 0015）：本地审计日志（填表行流）；不同步不备份不随空间删除 */
  readonly logs: LogRepository;
  /** 记忆宏（ticket 15）：设置变化 kick（宏名/上限/开关即时生效）；快照按指纹轮询重建 */
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
  /** 清洗规则（ticket 22 / ADR 0011）：当前对话列表选择读写 + ST 正则条目读取 + 聊天 Scope 宏 */
  readonly cleaning: {
    readonly readSelection: () => string | undefined;
    readonly writeSelection: (listId: string | undefined) => void;
    readonly readStRegexEntries: () => readonly StRegexEntry[];
    /** 最近 N 条对话消息（ticket 27 清洗测试「从当前对话载入」数据源，与填表任务同源） */
    readonly readRecentMessages: (count: number) => readonly FillSourceMessage[];
    readonly readChatScopeMacros: () => readonly MemoryView[];
    readonly writeChatScopeMacros: (macros: readonly MemoryView[]) => void;
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
  /** 测试与其他宿主可注入 embedding 实现；浏览器默认使用独立 HTTP 连接。 */
  readonly embedding?: VectorEmbeddingPort;
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

  const spaceRepository = new DexieMemorySpaceRepository(db);
  const tableRepository = new DexieMemoryTableRepository(db);
  const fieldRepository = new DexieMemoryFieldRepository(db);
  const recordRepository = new DexieMemoryRecordRepository(db);
  const backup = new DexieMemoryBackupRepository(db);
  const spaceStructureRebuild = new DexieSpaceStructureRebuild(db, spaceRepository);

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
  const reader: MemorySpaceReader = {
    getSpace: (id) => spaces.find(id),
    listTables: (memorySpaceId) => tables.list(memorySpaceId),
    listFields: (memorySpaceId, tableId) => fields.list(memorySpaceId, tableId),
    queryRecords: (memorySpaceId, input) =>
      new MemoryRecordQueryService(tableRepository, fieldRepository, recordRepository).query(
        memorySpaceId,
        input,
      ),
  };
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
    readPresetSettings: () => settings.read().agentPresets,
    readSnapshot: () => adapter.getPromptSnapshot(),
    getStContext: () => getContext() as StContext,
    logWarn: (message) => log.warn(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
  });
  const logs = new DexieLogRepository(logDb, { now });
  /**
   * Dexie 原子事务运行器工厂：提交批次在单事务内（scope 必须声明为 async——
   * Dexie expected-awaits 追踪，否则 PrematureCommit）。表集合 = 批次提交读写全集：
   * 填表任务含台账表，问答面板不含。
   */
  const runInTransaction = (tables: readonly Table[]) => (work: () => Promise<void>) =>
    db.transaction("rw", tables, async () => {
      await work();
    });
  const fillTaskRepository = new DexieFillTaskRepository(db, now);
  const floorLedgerRepository = new DexieFloorLedgerRepository(db);
  const tasks = new FillTaskService({
    tasks: fillTaskRepository,
    ledger: floorLedgerRepository,
    logs,
    source: adapter,
    reader,
    ports: { tables: tableRepository, fields: fieldRepository, records: recordRepository },
    evidence: recordRepository,
    recordWriter: records,
    runInTransaction: runInTransaction([
      db.memoryTables,
      db.memoryFields,
      db.memoryRecords,
      db.memoryRecordHistory,
      db.memoryEvidence,
      db.floorFillLedger,
      // 任务表进事务：块提交在事务内复检任务行（running），与空间结构重建
      // （删除任务行）互斥——重建后旧任务不可能再写入（spec 6.3 / AC-12）
      db.memoryFillTasks,
    ]),
    createLlm,
    createPromptContext,
    createRunId: () => createId("task"),
    readAgentTimeoutMs: () => settings.read().fillAgentTimeoutSeconds * 1000,
    createEvidenceId: () => createId("evidence") as MemoryEvidenceId,
    now,
    logError: (message, error) => log.error(`[${PLUGIN_DISPLAY_NAME}] ${message}`, error),
    // 填表任务内容清洗（ticket 22 / ADR 0011）：块处理时实时读取当前对话所选
    // 列表的规则（设置活对象 + chatMetadata 小指针；未选择/列表已删 → 不清洗）
    resolveCleaningRules: () =>
      resolveSelectedCleaningRules(
        settings.read().cleaningRuleLists,
        adapter.cleaningListStore.read(),
      ),
  });

  const mirror = new ChatMetadataMirrorSync({
    getChat: () => adapter.getChatSnapshot(),
    bindingStore: adapter.bindingStore,
    mirrorStore: adapter.mirrorStore,
    backup,
    changes: new DexieMemoryChangeSource(db),
    isEnabled: () => settings.read().enabled && settings.read().mirror.enabled,
    includeHistory: () => settings.read().mirror.includeHistory,
    appVersion: () => options.version ?? "",
    now: () => new Date(),
    log: {
      info: (message) => log.info(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
      warn: (message) => log.warn(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
      error: (message) => log.error(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
    },
  });
  const presetApply = new TablePresetApplyService({
    cancelActiveTask: async (id) => {
      const active = await tasks.activeTask(id);
      if (active) await tasks.cancel(id, active.runId);
    },
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
  const manager = new ChatSpaceManager({
    getChat: () => adapter.getChatSnapshot(),
    bindingStore: adapter.bindingStore,
    spaces,
    installer: { installDefaultStructure: (id) => presetApply.installDefaultStructure(id) },
    mirrorRestore: {
      // 空间缺失时从对话文件镜像恢复（镜像有效 + spaceId 与绑定一致才恢复）
      restore: (binding) => mirror.restoreFromMirror(binding),
    },
    log: { info: (message) => log.info(`[${PLUGIN_DISPLAY_NAME}] ${message}`) },
    // 分支对话分离：cloneSpace 克隆空间 + ID 工厂
    backup,
    createId,
  });

  const embedding =
    options.embedding ?? new OpenAiEmbeddingPort(() => settings.read().embeddingConnection);
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
  const recallRetrieval = new VectorRetrievalService(
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
  const memoryRecall = new MemoryRecallService({
    retrieval: recallRetrieval,
    reader,
    context: retrievalContext,
    spaceId: currentSpaceId,
    readConfiguration: () =>
      ((getContext() as StContext).chatMetadata?.steMemoryRecall as
        RecallConfiguration | undefined) ?? DEFAULT_RECALL_CONFIGURATION,
    writeConfiguration: (configuration) => {
      const context = getContext() as StContext;
      if (!context.chatMetadata) throw new Error("当前对话尚未准备好");
      context.chatMetadata.steMemoryRecall = configuration;
      context.saveMetadataDebounced?.();
    },
    views: (scope) =>
      scope === "global" ? settings.read().memoryViews : adapter.chatScopeMacroStore.read(),
    enabled: () =>
      settings.read().enabled &&
      resolveMacroRegistrationName(settings.read().macroName)?.toLowerCase() !== "memoryrecall",
    source: (floor) => adapter.getMessageAt(floor),
    lastUser: () => {
      for (let floor = adapter.chatMessageCount() - 1; floor >= 0; floor--)
        if (adapter.getMessageAt(floor)?.isUser) return floor;
      return -1;
    },
    stopGeneration: () => {
      (getContext() as StContext).stopGeneration?.();
    },
    isGroup: () => Boolean((getContext() as StContext).groupId),
  });
  let recallContext = "";
  const syncRetrievalContext = () => {
    const status = manager.getStatus();
    retrieval.setContext(retrievalContext(), status?.kind === "active" ? status.space.id : null);
    recallRetrieval.setContext(retrievalContext(), currentSpaceId());
    if (recallContext !== retrievalContext()) {
      recallContext = retrievalContext();
      memoryRecall.syncContext();
    }
  };
  manager.onStatusChange(syncRetrievalContext);
  trackRetrievalChanges(db, retrieval);
  trackRetrievalChanges(db, recallRetrieval);
  await vector.start();
  const vectorSync = new VectorIndexChangeSync(
    db,
    vector,
    () => settings.read().enabled,
    (error) => log.error(`[${PLUGIN_DISPLAY_NAME}] 向量索引核对失败`, error),
  );
  vectorSync.start();

  // 问答面板（ticket 20 / ADR 0009）：查询/填写双模式。LLM 端口开启思考流
  // （ticket 19）；填写提交前校验当前绑定空间 == run 起始空间（决策 7）。
  const queryChat = new QueryChatService({
    reader,
    ports: { tables: tableRepository, fields: fieldRepository, records: recordRepository },
    recordWriter: records,
    // 提交批次的事务作用域（不含台账表）：记录/历史/证据读写全集。
    runInTransaction: runInTransaction([
      db.memoryTables,
      db.memoryFields,
      db.memoryRecords,
      db.memoryRecordHistory,
      db.memoryEvidence,
    ]),
    createLlm: createQueryChatLlm,
    getCurrentSpaceId: () => {
      const status = manager.getStatus();
      return status?.kind === "active" ? status.space.id : undefined;
    },
  });

  // 空间维护：清除空间记录（保留表格结构与初始化来源）；按预设重建统一走
  // 表格预设的应用流程（TablePresetApplyService）。
  const spaceMaintenance = new SpaceMaintenanceService({
    clearRecords: (id) => spaces.clearRecords(id),
    cancelActiveTask: async (id) => {
      const active = await tasks.activeTask(id);
      if (active) await tasks.cancel(id, active.runId);
    },
    clearTasks: (id) => fillTaskRepository.clear(id),
    clearLedger: (id) => floorLedgerRepository.clear(id),
  });

  // 页面/浏览器重开：所有非终态填表任务标记 interrupted，不自动重放（关页语义）
  await tasks.markInterruptedOnStartup();
  // 镜像同步启动：本地变更在轮询中回填进对话文件（文件自洽）
  await mirror.start();

  // 记忆宏（ticket 15 / ADR 0004 + ticket 02 / ADR 0025）：注册由设置面板配置的宏名
  // （带可选视图名参数），预计算快照（默认 + 每视图）随变更指纹/视图设置重建
  // （与镜像同机制）；handler 同步返回快照（ST 宏引擎同步约束）
  const macro = new MemoryMacroService({
    getSpaceId: () => {
      const status = manager.getStatus();
      return status?.kind === "active" ? status.space.id : undefined;
    },
    data: {
      listTables: (id) => tableRepository.list(id),
      listRecords: (id, tableId) => recordRepository.list(id, tableId),
    },
    // 视图翻译/查询/引用解析共用既有 reader（queryRecords → MemoryRecordQueryService）
    reader,
    readSettings: () => {
      const settingsValue = settings.read();
      return {
        enabled: settingsValue.enabled,
        macroName: settingsValue.macroName,
        macroLimit: settingsValue.macroLimit,
        memoryViews: settingsValue.memoryViews,
      };
    },
    registerMacro: adapter.macroRegistration,
    changes: new DexieMemoryChangeSource(db),
    readChatScopeMacros: () => adapter.chatScopeMacroStore.read(),
    log: {
      info: (message) => log.info(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
      warn: (message) => log.warn(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
      error: (message) => log.error(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
    },
  });

  adapter.registerEventBridge({
    onChatChanged: () => {
      memoryRecall.chatChanged();
      chatEpoch++;
      retrieval.setContext(retrievalContext(), null, true);
      // 插件总开关门控：停用期间不响应切对话（重新启用时由设置面板触发同步）
      if (!settings.read().enabled) return;
      void manager.syncToCurrentChat().catch((error) => {
        log.error(`[${PLUGIN_DISPLAY_NAME}] 同步空间上下文失败`, error);
      });
    },
    // 把召回 Promise 原样返回 MESSAGE_SENT，ST 等待后才构建本轮提示词。
    onMessageEvent: (kind, floor) =>
      kind === "message_sent" && floor !== undefined ? memoryRecall.messageSent(floor) : undefined,
    onGenerationStarted: (type, options, dryRun) => memoryRecall.started(type, options, dryRun),
    onGenerationStopped: () => memoryRecall.stop(),
    onGenerationFinished: (dryRun) => memoryRecall.generationFinished(dryRun),
    shouldAwaitRecall: () => memoryRecall.getState().status === "preparing",
    onGroupStarted: () => memoryRecall.groupStarted(),
    onGroupEnded: () => memoryRecall.groupEnded(),
    onMessageChanged: () => memoryRecall.sourceChanged(),
  });

  // Agent 预设宏（ticket 17 / ADR 0006）：{{tablesDigest}}/{{systemDefaultPrompt}} 注册 +
  // 预计算快照（digest 摘要 + 默认提示词全文）随变更指纹重建（与记忆宏同机制）；
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
    await manager.syncToCurrentChat();
    const status = manager.getStatus();
    if (status?.kind === "active") vectorSync.activate(status.space.id);
  }
  // 记忆宏（ticket 15）：注册 + 首次快照重建放在首次空间同步之后——
  // 活动空间就绪后立即展开的就是最新记忆，而非等第一轮轮询
  await macro.start();
  let recallMacroRegistered = false;
  if (resolveMacroRegistrationName(settings.read().macroName)?.toLowerCase() !== "memoryrecall") {
    adapter.macroRegistration.register("memoryRecall", () => memoryRecall.getMacroText());
    recallMacroRegistered = true;
  }
  await agentMacro.start();
  // 空间切换（打开对话/切对话）立即重建快照：宏服务本身靠指纹轮询收敛，
  // 状态变化事件让它不等下一轮轮询（打开对话后马上生成也要展开当前空间记忆）
  manager.onStatusChange(() => {
    const status = manager.getStatus();
    if (status?.kind === "active") vectorSync.activate(status.space.id);
    void macro.kick().catch((error) => {
      log.error(`[${PLUGIN_DISPLAY_NAME}] 记忆宏快照重建失败`, error);
    });
    void agentMacro.kick().catch((error) => {
      log.error(`[${PLUGIN_DISPLAY_NAME}] Agent 预设宏快照重建失败`, error);
    });
  });
  const settingsService = new SettingsService({
    store: settings,
    syncToCurrentChat: () => manager.syncToCurrentChat(),
    refreshMemoryMacros: async () => {
      memoryRecall.invalidate("记忆宏或视图设置已修改");
      await macro.kick();
      if (
        !recallMacroRegistered &&
        resolveMacroRegistrationName(settings.read().macroName)?.toLowerCase() !== "memoryrecall"
      ) {
        adapter.macroRegistration.register("memoryRecall", () => memoryRecall.getMacroText());
        recallMacroRegistered = true;
      }
    },
    refreshAgentMacros: () => agentMacro.kick(),
    refreshMirror: () => mirror.kick(),
    writeChatScopeMacros: (macros) => adapter.chatScopeMacroStore.write(macros),
    refreshVectorIndex: () => {
      retrieval.profileChanged();
      recallRetrieval.profileChanged();
      memoryRecall.invalidate("设置已修改");
      return vectorSync.refreshSettings();
    },
  });
  return {
    manager,
    adapter,
    spaces,
    tables,
    fields,
    records,
    backup,
    backupRepo: backup,
    settings,
    settingsService,
    mirror,
    tasks,
    vector,
    retrieval,
    memoryRecall,
    spaceMaintenance,
    presetApply,
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
        memoryViews: settings.read().memoryViews,
      }),
      resolveRegistrationName: resolveMacroRegistrationName,
      readDefaultSnapshot: () => macro.getSnapshot(),
      readViewSnapshot: (viewName) => macro.getViewSnapshot(viewName),
      readChannelScopeMacros: () => adapter.chatScopeMacroStore.read(),
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
    // 清洗规则（ticket 22 / ADR 0011）：当前对话列表选择读写 + ST 全局正则条目
    cleaning: {
      readSelection: () => adapter.cleaningListStore.read(),
      writeSelection: (listId) => adapter.cleaningListStore.write(listId),
      readStRegexEntries: () => adapter.stRegexEntries,
      readRecentMessages: (count) => adapter.recentMessages(count),
      readChatScopeMacros: () => adapter.chatScopeMacroStore.read(),
      writeChatScopeMacros: (macros) => adapter.chatScopeMacroStore.write(macros),
    },
    // 弹窗 API（分支检测等需要用户交互的场景）
    popup: {
      show: (content, options) => adapter.showPopup(content, options),
    },
  };
}
