import {
  MemoryFieldService,
  MemorySpaceService,
  MemoryTableService,
  type MemoryFieldId,
  type MemorySpaceId,
  type MemoryTableId,
} from "@ste-memory/core/memory";
import { SystemMemoryTableInstaller } from "@ste-memory/memory-host-shared";
import { PLUGIN_DISPLAY_NAME } from "./constants.ts";
import {
  DexieMemoryFieldRepository,
  DexieMemorySpaceRepository,
  DexieMemoryTableRepository,
  SteMemoryDatabase,
} from "./db/index.ts";
import { ChatSpaceManager } from "./space-binding/chat-space-manager.ts";
import { StChatAdapter, type StContext } from "./st/st-chat-adapter.ts";
import type { PluginLog } from "./bootstrap.ts";

/** 插件运行时（UI 与后续 ticket 的访问点） */
export interface SteMemoryRuntime {
  readonly manager: ChatSpaceManager;
  readonly adapter: StChatAdapter;
}

export interface StartSteMemoryOptions {
  readonly log?: PluginLog;
  /** 时钟；缺省 = Date.toISOString（测试注入固定时钟） */
  readonly now?: () => string;
  /** id 工厂；缺省 = crypto.randomUUID（TauriTavern 非安全上下文时降级时间戳+随机） */
  readonly createId?: (prefix: string) => string;
  /** Dexie 库工厂；缺省 = 默认库（测试注入临时库） */
  readonly createDb?: () => SteMemoryDatabase;
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

  const spaceRepository = new DexieMemorySpaceRepository(db);
  const tableRepository = new DexieMemoryTableRepository(db);
  const fieldRepository = new DexieMemoryFieldRepository(db);

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

  adapter.registerEventBridge({
    onChatChanged: () => {
      void manager.syncToCurrentChat().catch((error) => {
        log.error(`[${PLUGIN_DISPLAY_NAME}] 同步空间上下文失败`, error);
      });
    },
    // MESSAGE_SENT / MESSAGE_RECEIVED：未来自动填表的触发点（ticket 13），当前无消费方
    onMessageEvent: () => {},
  });

  await manager.syncToCurrentChat();
  return { manager, adapter };
}
