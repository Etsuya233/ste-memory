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
import type { MemoryBackupRepository } from "@ste-memory/core/memory/export";
import type { MemoryRecordMutationContext } from "@ste-memory/core/memory";
import type { MemorySpaceReader } from "@ste-memory/core/memory/agent";
import { SystemMemoryTableInstaller } from "@ste-memory/memory-host-shared";
import { PLUGIN_DISPLAY_NAME } from "./constants.ts";
import { CloudSyncCoordinator, R2CloudSyncAdapter } from "./cloud/index.ts";
import { ChatMetadataMirrorSync } from "./chat-mirror/chat-metadata-mirror-sync.ts";
import {
  DexieFillTaskRepository,
  DexieFloorLedgerRepository,
  DexieLogRepository,
  DexieMemoryBackupRepository,
  DexieMemoryFieldRepository,
  DexieMemoryRecordRepository,
  DexieMemorySpaceRepository,
  DexieMemoryTableRepository,
  DexieSyncChangeSource,
  SteMemoryDatabase,
} from "./db/index.ts";
import { FillTaskService } from "./fill-tasks/fill-task-service.ts";
import { QueryChatService } from "./query-chat/query-chat-service.ts";
import type { Table } from "dexie";
import type { LogRepository } from "./logging/log.ts";
import { MemoryMacroService } from "./macros/memory-macro-service.ts";
import { AgentMacroService } from "./agent-presets/agent-macro-service.ts";
import { composePresetSystemPrompt } from "./agent-presets/preset-composer.ts";
import {
  containsWorldbookReference,
  presetPromptText,
  resolveActivePreset,
} from "./agent-presets/preset-model.ts";
import { scanWorldbookText } from "./agent-presets/worldbook-text.ts";
import type { ProposalSystemPromptComposer } from "@ste-memory/core/memory/agent";
import { isR2Configured, type SettingsStore } from "./settings/plugin-settings.ts";
import { resolveSelectedCleaningRules } from "./settings/cleaning-rule-lists.ts";
import { ChatSpaceManager } from "./space-binding/chat-space-manager.ts";
import { StChatAdapter, type StContext } from "./st/st-chat-adapter.ts";
import { StSettingsStore } from "./st/st-settings-store.ts";
import { createAgentConnectionLlmPort, createStLlmPort } from "./llm/st-backends-llm.ts";
import type { LlmPort } from "@ste-memory/core/memory/agent";
import {
  resolveAgentConnection,
  type AgentConnectionTarget,
} from "./settings/agent-connections.ts";
import type { PluginLog } from "./bootstrap.ts";

/** 插件运行时（UI 与后续 ticket 的访问点） */
export interface SteMemoryRuntime {
  readonly manager: ChatSpaceManager;
  readonly adapter: StChatAdapter;
  /** core 服务（面板表格列表/启停等 UI 操作入口） */
  readonly spaces: MemorySpaceService;
  readonly tables: MemoryTableService;
  readonly fields: MemoryFieldService;
  /** 记忆记录（ticket 10/11）：显示文本预览、列表/搜索分页、手动增删改入口 */
  readonly records: MemoryRecordService;
  /** 全库备份（导出/导入，ticket 07）：快照读取与整体还原 */
  readonly backup: MemoryBackupRepository;
  /** 插件设置存储（设置面板读写与运行时开关门控共用同一实例） */
  readonly settings: SettingsStore;
  /** 云同步（ticket 08）：状态订阅 + 立即同步；R2 配置齐即自动防抖推送/空库拉取 */
  readonly sync: CloudSyncCoordinator;
  /** 对话文件镜像（ticket 16）：状态订阅 + 设置变化 kick；随聊天文件同步记忆快照 */
  readonly mirror: ChatMetadataMirrorSync;
  /** 填表任务（ticket 13）：手动楼层范围触发/取消 + 台账；启动时中断非终态任务 */
  readonly tasks: FillTaskService;
  /** 通用日志（ADR 0008）：本地审计日志（填表运行记录）；纯本地，不同步不备份 */
  readonly logs: LogRepository;
  /** 记忆宏（ticket 15）：设置变化 kick（宏名/上限/开关即时生效）；快照按指纹轮询重建 */
  readonly macro: MemoryMacroService;
  /** Agent 预设宏（ticket 17）：{{tablesDigest}}/{{systemDefaultPrompt}} 注册 + 快照轮询 */
  readonly agentMacro: AgentMacroService;
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
  /** 清洗规则（ticket 22 / ADR 0011）：当前对话列表选择读写 + ST 全局正则条目读取 */
  readonly cleaning: {
    readonly readSelection: () => string | undefined;
    readonly writeSelection: (listId: string | undefined) => void;
    readonly readStRegexScripts: () => readonly unknown[];
  };
  /** 插件版本（构建时注入，设置面板展示） */
  readonly version: string;
}

export interface StartSteMemoryOptions {
  readonly log?: PluginLog;
  /** 时钟；缺省 = Date.toISOString（测试注入固定时钟） */
  readonly now?: () => string;
  /** id 工厂；缺省 = crypto.randomUUID（TauriTavern 非安全上下文时降级时间戳+随机） */
  readonly createId?: (prefix: string) => string;
  /** Dexie 库工厂；缺省 = 默认库（测试注入临时库） */
  readonly createDb?: () => SteMemoryDatabase;
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
 * Dexie 持久层 + core 服务 + 系统表安装器 + ST 适配器 + 事件桥 + 首次同步。
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
  const settings = options.settingsStore ?? new StSettingsStore(() => getContext() as StContext);

  const spaceRepository = new DexieMemorySpaceRepository(db);
  const tableRepository = new DexieMemoryTableRepository(db);
  const fieldRepository = new DexieMemoryFieldRepository(db);
  const recordRepository = new DexieMemoryRecordRepository(db);
  const backup = new DexieMemoryBackupRepository(db);

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
  const reader: MemorySpaceReader = {
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
  const createLlmFor = (
    target: AgentConnectionTarget,
    includeReasoning: boolean,
  ): LlmPort => {
    const connection = resolveAgentConnection(settings.read(), target);
    if (connection) {
      return createAgentConnectionLlmPort(connection, () => getContext() as StContext, {
        includeReasoning,
      });
    }
    return createStLlmPort(() => getContext() as StContext, { includeReasoning });
  };
  // 填表任务：缺省 includeReasoning=false（零变化）；问答面板（ticket 20）：开启
  // 思考流（ticket 19 选项），模型不支持思考时静默降级（适配器行为）
  const createLlm = (): LlmPort => createLlmFor("fillTask", false);
  const createQueryChatLlm = (): LlmPort => createLlmFor("queryChat", true);
  /**
   * 填表任务的系统提示词组合器工厂（ticket 17 / ADR 0006；世界书 ADR 0007）：
   * 提交时构造一次——活动预设文本 + 对话双方名字快照 + 世界书扫描文本快照；
   * 系统默认预设 → undefined（用核心默认组合器）。
   * 预设启用片段含 {{worldbook}} 才扫描（零引用零开销）；扫描失败 → 空串 + warn，
   * 不阻断任务（用户决策）；每次任务首次组合时 log 最终 system prompt。
   */
  const createComposeSystemPrompt = async (
    storyText: string,
  ): Promise<ProposalSystemPromptComposer | undefined> => {
    const preset = resolveActivePreset(settings.read().agentPresets);
    if (!preset) return undefined;
    let worldbookText = "";
    if (containsWorldbookReference(preset)) {
      try {
        worldbookText = await scanWorldbookText(getContext() as StContext, storyText);
      } catch (error) {
        log.warn(
          `[${PLUGIN_DISPLAY_NAME}] 世界书扫描失败，{{worldbook}} 展开为空：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const compose = composePresetSystemPrompt(
      presetPromptText(preset),
      adapter.getPromptNames(),
      worldbookText,
    );
    let logged = false;
    return (digest) => {
      const prompt = compose(digest);
      if (!logged) {
        logged = true;
        log.info(`[${PLUGIN_DISPLAY_NAME}] Agent 预设「${preset.name}」system prompt：\n${prompt}`);
      }
      return prompt;
    };
  };
  const logs = new DexieLogRepository(db, { now });
  /**
   * Dexie 原子事务运行器工厂：提交批次在单事务内（scope 必须声明为 async——
   * Dexie expected-awaits 追踪，否则 PrematureCommit）。表集合 = 批次提交读写全集：
   * 填表任务含台账表，问答面板不含。
   */
  const runInTransaction = (tables: readonly Table[]) => (work: () => Promise<void>) =>
    db.transaction("rw", tables, async () => {
      await work();
    });
  // 批次原子提交上下文：填表任务（ticket 13）与问答面板填写模式（ticket 20）共用。
  const commitContext: MemoryRecordMutationContext = {
    tables: tableRepository,
    fields: fieldRepository,
    records: recordRepository,
    createId: () => createId("record") as MemoryRecordId,
    createHistoryId: () => createId("record-history") as MemoryRecordHistoryId,
    createRevisionId: () => createId("revision") as MemoryRevisionId,
    now,
    displayText: (table, fieldList, payload) =>
      computeMemoryRecordDisplayText(
        recordRepository,
        table.memorySpaceId,
        table,
        fieldList,
        payload,
      ),
  };
  const tasks = new FillTaskService({
    tasks: new DexieFillTaskRepository(db, now),
    ledger: new DexieFloorLedgerRepository(db),
    logs,
    source: adapter,
    reader,
    ports: { tables: tableRepository, fields: fieldRepository, records: recordRepository },
    evidence: recordRepository,
    commitContext,
    runInTransaction: runInTransaction([
      db.memoryTables,
      db.memoryFields,
      db.memoryRecords,
      db.memoryRecordHistory,
      db.memoryEvidence,
      db.floorFillLedger,
    ]),
    createLlm,
    createComposeSystemPrompt,
    createRunId: () => createId("task"),
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
    changes: new DexieSyncChangeSource(db),
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
  const manager = new ChatSpaceManager({
    getChat: () => adapter.getChatSnapshot(),
    bindingStore: adapter.bindingStore,
    spaces,
    installer: new SystemMemoryTableInstaller(tables, fields),
    mirrorRestore: {
      // 空间缺失时从对话文件镜像恢复（镜像有效 + spaceId 与绑定一致才恢复）
      restore: (binding) => mirror.restoreFromMirror(binding),
    },
    log: { info: (message) => log.info(`[${PLUGIN_DISPLAY_NAME}] ${message}`) },
  });

  // 问答面板（ticket 20 / ADR 0009）：查询/填写双模式。LLM 端口开启思考流
  // （ticket 19）；填写提交前校验当前绑定空间 == run 起始空间（决策 7）。
  const queryChat = new QueryChatService({
    reader,
    ports: { tables: tableRepository, fields: fieldRepository, records: recordRepository },
    commitContext,
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

  // 云同步协调器：R2 配置齐全 + 插件总开关开启时生效（设置面板实时修改立即生效，
  // 凭证经 getter 每次请求重取）；start 先于首次空间同步执行，保证空库拉取先落地
  const sync = new CloudSyncCoordinator({
    adapter: new R2CloudSyncAdapter(() => settings.read().r2, { now: () => new Date() }),
    backup,
    changes: new DexieSyncChangeSource(db),
    isEnabled: () => settings.read().enabled && isR2Configured(settings.read()),
    appVersion: () => options.version ?? "",
    now: () => new Date(),
    log: {
      info: (message) => log.info(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
      warn: (message) => log.warn(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
      error: (message) => log.error(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
    },
    onRestored: () => {
      // 拉取恢复后立即重同步当前对话的空间绑定（绑定在、空间缺失态 → active）
      void manager.syncToCurrentChat().catch((error) => {
        log.error(`[${PLUGIN_DISPLAY_NAME}] 拉取后恢复空间上下文失败`, error);
      });
    },
  });
  // 空库拉取必须先于空间创建完成（否则拉取恢复会覆盖启动期间新建的空间）
  await sync.start();
  // 页面/浏览器重开：所有非终态填表任务标记 interrupted，不自动重放（关页语义）
  await tasks.markInterruptedOnStartup();
  // 镜像同步在 R2 拉取之后启动：拉取恢复的数据会在轮询中回填进对话文件（文件自洽）
  await mirror.start();

  // 记忆宏（ticket 15 / ADR 0004）：注册由设置面板配置的宏名，预计算快照随变更指纹
  // 重建（与镜像/云同步同机制）；handler 同步返回快照（ST 宏引擎同步约束）
  const macro = new MemoryMacroService({
    getSpaceId: () => {
      const status = manager.getStatus();
      return status?.kind === "active" ? status.space.id : undefined;
    },
    data: {
      listTables: (id) => tableRepository.list(id),
      listRecords: (id, tableId) => recordRepository.list(id, tableId),
    },
    readSettings: () => {
      const settingsValue = settings.read();
      return {
        enabled: settingsValue.enabled,
        macroName: settingsValue.macroName,
        macroLimit: settingsValue.macroLimit,
      };
    },
    registerMacro: adapter.macroRegistration,
    changes: new DexieSyncChangeSource(db),
    log: {
      info: (message) => log.info(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
      warn: (message) => log.warn(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
      error: (message) => log.error(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
    },
  });

  adapter.registerEventBridge({
    onChatChanged: () => {
      // 插件总开关门控：停用期间不响应切对话（重新启用时由设置面板触发同步）
      if (!settings.read().enabled) return;
      void manager.syncToCurrentChat().catch((error) => {
        log.error(`[${PLUGIN_DISPLAY_NAME}] 同步空间上下文失败`, error);
      });
    },
    // MESSAGE_SENT / MESSAGE_RECEIVED：未来自动填表的触发点（ticket 13），当前无消费方
    onMessageEvent: () => {},
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
    changes: new DexieSyncChangeSource(db),
    log: {
      info: (message) => log.info(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
      warn: (message) => log.warn(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
      error: (message) => log.error(`[${PLUGIN_DISPLAY_NAME}] ${message}`),
    },
  });

  if (settings.read().enabled) {
    await manager.syncToCurrentChat();
  }
  // 记忆宏（ticket 15）：注册 + 首次快照重建放在首次空间同步之后——
  // 活动空间就绪后立即展开的就是最新记忆，而非等第一轮轮询
  await macro.start();
  await agentMacro.start();
  // 空间切换（打开对话/切对话）立即重建快照：宏服务本身靠指纹轮询收敛，
  // 状态变化事件让它不等下一轮轮询（打开对话后马上生成也要展开当前空间记忆）
  manager.onStatusChange(() => {
    void macro.kick().catch((error) => {
      log.error(`[${PLUGIN_DISPLAY_NAME}] 记忆宏快照重建失败`, error);
    });
    void agentMacro.kick().catch((error) => {
      log.error(`[${PLUGIN_DISPLAY_NAME}] Agent 预设宏快照重建失败`, error);
    });
  });
  return {
    manager,
    adapter,
    spaces,
    tables,
    fields,
    records,
    backup,
    settings,
    sync,
    mirror,
    tasks,
    logs,
    macro,
    agentMacro,
    createLlm,
    createQueryChatLlm,
    queryChat,
    version: options.version ?? "",
    // 清洗规则（ticket 22 / ADR 0011）：当前对话列表选择读写 + ST 全局正则条目
    cleaning: {
      readSelection: () => adapter.cleaningListStore.read(),
      writeSelection: (listId) => adapter.cleaningListStore.write(listId),
      readStRegexScripts: () => adapter.stRegexScripts,
    },
  };
}
