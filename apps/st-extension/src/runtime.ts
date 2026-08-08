import {
  MemoryFieldService,
  MemorySpaceService,
  MemoryTableService,
  type MemoryFieldId,
  type MemorySpaceId,
  type MemoryTableId,
} from "@ste-memory/core/memory";
import type { MemoryBackupRepository } from "@ste-memory/core/memory/export";
import { SystemMemoryTableInstaller } from "@ste-memory/memory-host-shared";
import { PLUGIN_DISPLAY_NAME } from "./constants.ts";
import { CloudSyncCoordinator, R2CloudSyncAdapter } from "./cloud/index.ts";
import {
  DexieMemoryBackupRepository,
  DexieMemoryFieldRepository,
  DexieMemorySpaceRepository,
  DexieMemoryTableRepository,
  DexieSyncChangeSource,
  SteMemoryDatabase,
} from "./db/index.ts";
import { isR2Configured, type SettingsStore } from "./settings/plugin-settings.ts";
import { ChatSpaceManager } from "./space-binding/chat-space-manager.ts";
import { StChatAdapter, type StContext } from "./st/st-chat-adapter.ts";
import { StSettingsStore } from "./st/st-settings-store.ts";
import type { PluginLog } from "./bootstrap.ts";

/** 插件运行时（UI 与后续 ticket 的访问点） */
export interface SteMemoryRuntime {
  readonly manager: ChatSpaceManager;
  readonly adapter: StChatAdapter;
  /** core 服务（面板表格列表/启停等 UI 操作入口） */
  readonly spaces: MemorySpaceService;
  readonly tables: MemoryTableService;
  readonly fields: MemoryFieldService;
  /** 全库备份（导出/导入，ticket 07）：快照读取与整体还原 */
  readonly backup: MemoryBackupRepository;
  /** 插件设置存储（设置面板读写与运行时开关门控共用同一实例） */
  readonly settings: SettingsStore;
  /** 云同步（ticket 08）：状态订阅 + 立即同步；R2 配置齐即自动防抖推送/空库拉取 */
  readonly sync: CloudSyncCoordinator;
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

  const adapter = new StChatAdapter(() => getContext() as StContext);
  const manager = new ChatSpaceManager({
    getChat: () => adapter.getChatSnapshot(),
    bindingStore: adapter.bindingStore,
    spaces,
    installer: new SystemMemoryTableInstaller(tables, fields),
    log: { info: (message) => log.info(`[${PLUGIN_DISPLAY_NAME}] ${message}`) },
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

  if (settings.read().enabled) {
    await manager.syncToCurrentChat();
  }
  return {
    manager,
    adapter,
    spaces,
    tables,
    fields,
    backup,
    settings,
    sync,
    version: options.version ?? "",
  };
}
