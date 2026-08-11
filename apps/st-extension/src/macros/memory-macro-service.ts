import type {
  MemoryRecord,
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
} from "@ste-memory/core/memory";
import {
  fingerprintsEqual,
  type SpaceFingerprint,
  type SyncChangeSource,
} from "../cloud/space-fingerprint.ts";
import type { SyncTimerPort } from "../cloud/sync-coordinator.ts";
import { resolveMacroRegistrationName } from "./macro-name.ts";
import { assembleMemoryContextSnapshot } from "./memory-context-snapshot.ts";

/**
 * 记忆宏服务（插件纯逻辑 seam，ticket 15 / ADR 0004）：
 *
 * - 注册：宏名由用户配置（设置面板，默认 {{memoryContext}}），解析为 ST 注册名
 *   （裸标识符）后经 macros.register(name, { handler }) 注册；名字不合法/为空/
 *   插件停用 → 不注册（「不放置宏则无注入」）；名字变化 → 注销旧名再注册新名。
 * - 快照：宏 handler 必须同步返回（ST 宏引擎同步约束，返回 Promise 会被字符串化），
 *   因此维护「组装好的记忆上下文文本」预计算快照；数据变更时重建。
 * - 重建时机：轮询当前绑定空间的变更指纹（与云同步/镜像同机制，DexieSyncChangeSource），
 *   指纹变化（同步/填表/手动编辑/导入都会改变行数或最大 updatedAt）→ 重新组装；
 *   切对话（活动空间变化）同样在轮询里收敛；设置变化（宏名/上限）由宿主 kick 立即评估。
 *
 * 组装规则见 memory-context-snapshot.ts（纯函数，有测试）。
 */

/** 宏数据端口：宿主 = Dexie repository（结构满足 core 端口契约的窄子集） */
export interface MemoryMacroDataPorts {
  listTables(memorySpaceId: MemorySpaceId): Promise<readonly MemoryTable[]>;
  listRecords(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
  ): Promise<readonly MemoryRecord[]>;
}

/** 宏注册端口：宿主 = StChatAdapter（ST context.macros，薄层不测） */
export interface MemoryMacroRegistrationPort {
  /** 注册宏：name 为裸标识符（不含花括号）；同名覆盖是 ST 语义 */
  register(name: string, handler: () => string): void;
  /** 注销宏：名字变化/不合法/插件停用时清理旧注册 */
  unregister(name: string): void;
}

export interface MemoryMacroServicePorts {
  /** 当前活动记忆空间（宿主 = ChatSpaceManager 状态）；undefined = 无活动空间 */
  getSpaceId(): MemorySpaceId | undefined;
  readonly data: MemoryMacroDataPorts;
  /** 设置读取（宿主 = settings.read() 子集）：每次评估重取，保证拿到最新值 */
  readonly readSettings: () => {
    readonly enabled: boolean;
    readonly macroName: string;
    readonly macroLimit: number;
  };
  readonly registerMacro: MemoryMacroRegistrationPort;
  /** 空间变更指纹（宿主 = DexieSyncChangeSource，与云同步/镜像同机制） */
  readonly changes: SyncChangeSource;
  /** 可选日志（宿主 = ST console，消息带插件前缀由宿主包装） */
  readonly log?: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  /** 指纹轮询间隔；缺省 2s（与云同步/镜像同节奏） */
  readonly pollIntervalMs?: number;
  /** 定时器端口（测试注入 fake timers）；缺省 = globalThis */
  readonly timers?: SyncTimerPort;
}

/** 解析后的端口（可选字段带默认值），运行时只读 */
interface ResolvedMemoryMacroServicePorts extends MemoryMacroServicePorts {
  readonly pollIntervalMs: number;
  readonly timers: SyncTimerPort;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;

const defaultTimers: SyncTimerPort = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class MemoryMacroService {
  readonly #ports: ResolvedMemoryMacroServicePorts;
  /** 当前已注册的宏名（裸标识符）；未注册 = undefined */
  #registeredName: string | undefined;
  /** 预计算快照（宏 handler 同步返回；无活动空间/无数据 = 空串） */
  #snapshot = "";
  /** 最近一次重建时的空间与指纹（相同即内容等价，跳过重建）；上限也参与判定 */
  #lastSpaceId: MemorySpaceId | undefined;
  #lastFingerprint: SpaceFingerprint | undefined;
  #lastLimit: number | undefined;
  #pollTimer: unknown = undefined;
  #stopped = false;
  #evaluating: Promise<void> = Promise.resolve();

  constructor(ports: MemoryMacroServicePorts) {
    this.#ports = {
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      timers: defaultTimers,
      ...ports,
    };
  }

  /** 当前快照文本（宏 handler 的返回源；调试/验收可读） */
  getSnapshot(): string {
    return this.#snapshot;
  }

  /** 启动（runtime 组合根调用）：立即注册宏 + 重建快照，并保持轮询刷新。 */
  start(): Promise<void> {
    return this.#queueEvaluate();
  }

  /** 停止（测试）：取消定时器，不再轮询；注册保留（页面生命周期内同名覆盖无害）。 */
  stop(): void {
    this.#stopped = true;
    this.#clearTimer();
  }

  /** 设置变化后立即评估（幂等）：宏名/上限/开关改动时宿主调用（与 sync.kick 同语义）。 */
  kick(): Promise<void> {
    return this.#queueEvaluate();
  }

  /** 评估排队：并发触发串行执行，最终收敛到最新状态；单轮异常不毒化队列。 */
  #queueEvaluate(): Promise<void> {
    const run = this.#evaluating.then(() => this.#evaluate());
    this.#evaluating = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #evaluate(): Promise<void> {
    if (this.#stopped) return;
    const settings = this.#ports.readSettings();
    const name = resolveMacroRegistrationName(settings.macroName);
    if (!settings.enabled || name === undefined) {
      // 插件停用 / 宏名缺失或不合法：注销旧注册、清空快照、不轮询（无宏可展开）；
      // 指纹/上限状态一并重置——重新启用且数据未变时不能命中「指纹相同早退”而
      // 让快照永久为空（重建判定必须重新武装）
      this.#unregisterCurrent();
      this.#snapshot = "";
      this.#lastSpaceId = undefined;
      this.#lastFingerprint = undefined;
      this.#lastLimit = undefined;
      this.#clearTimer();
      return;
    }
    if (name !== this.#registeredName) {
      this.#unregisterCurrent();
      this.#ports.registerMacro.register(name, () => this.#snapshot);
      this.#registeredName = name;
    }
    this.#armPoll();
    const spaceId = this.#ports.getSpaceId();
    if (spaceId === undefined) {
      // 无活动空间（未绑定/切对话间隙）：快照置空，下轮轮询自然恢复
      if (this.#lastSpaceId !== undefined) {
        this.#lastSpaceId = undefined;
        this.#lastFingerprint = undefined;
        this.#lastLimit = undefined;
        this.#snapshot = "";
      }
      return;
    }
    try {
      const fingerprint = await this.#ports.changes.fingerprint(spaceId);
      if (
        spaceId === this.#lastSpaceId &&
        this.#lastFingerprint !== undefined &&
        fingerprintsEqual(this.#lastFingerprint, fingerprint) &&
        // 上限是设置项：只改了上限也必须重建（指纹不反映设置）
        this.#lastLimit === settings.macroLimit
      ) {
        return;
      }
      await this.#rebuild(spaceId, fingerprint, settings.macroLimit);
    } catch (error) {
      // 单轮失败只记日志：下轮轮询自然重试（快照保持旧值，宏仍可展开）
      this.#ports.log?.error(
        `记忆宏快照重建失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 重建快照：启用表 + 记录显示文本 → 按上限组装（纯函数，见 memory-context-snapshot） */
  async #rebuild(
    spaceId: MemorySpaceId,
    fingerprint: SpaceFingerprint,
    limit: number,
  ): Promise<void> {
    const tables = await this.#ports.data.listTables(spaceId);
    const tableInputs = await Promise.all(
      tables.map(async (table) => ({
        name: table.name,
        enabled: table.enabled,
        records: table.enabled ? await this.#ports.data.listRecords(spaceId, table.id) : [],
      })),
    );
    // 组装期间切走了空间：放弃本轮（下轮轮询按新状态重建）
    if (this.#ports.getSpaceId() !== spaceId) return;
    this.#snapshot = assembleMemoryContextSnapshot(tableInputs, limit);
    this.#lastSpaceId = spaceId;
    this.#lastFingerprint = fingerprint;
    this.#lastLimit = limit;
  }

  #unregisterCurrent(): void {
    if (this.#registeredName === undefined) return;
    this.#ports.registerMacro.unregister(this.#registeredName);
    this.#registeredName = undefined;
  }

  /** 启用期间保持轮询（每次评估续期；停用/停止时取消） */
  #armPoll(): void {
    if (this.#pollTimer !== undefined || this.#stopped) return;
    this.#pollTimer = this.#ports.timers.setTimeout(() => {
      this.#pollTimer = undefined;
      void this.#queueEvaluate();
    }, this.#ports.pollIntervalMs);
  }

  #clearTimer(): void {
    if (this.#pollTimer !== undefined) {
      this.#ports.timers.clearTimeout(this.#pollTimer);
      this.#pollTimer = undefined;
    }
  }
}
