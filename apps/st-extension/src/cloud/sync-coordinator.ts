import type { CloudIndexEntry, CloudSyncAdapter } from "@ste-memory/core/memory/cloud";
import type { MemoryBackupRepository } from "@ste-memory/core/memory/export";
import {
  CLOUD_INDEX_KEY,
  cloudSpaceFileKey,
  createCloudIndexFile,
  createCloudSpaceFile,
  parseCloudIndexFile,
  parseCloudSpaceFile,
  resolveCloudLww,
} from "@ste-memory/core/memory/cloud";
import type { MemorySpaceBackup } from "@ste-memory/core/memory/export";
import { fingerprintsEqual, type SpaceFingerprint, type SyncChangeSource } from "./space-fingerprint.ts";

/**
 * 云同步协调器（插件纯逻辑 seam，spec「云同步序列化/索引/冲突（LWW）」
 * 测试点）：数据变更防抖周期推送 + 空库启动拉取全量 + last-write-wins。
 *
 * 同步模型（spec 决策 6）：
 * - 本地优先：本地库非空时绝不拉取（离线可用）；空库启动才拉全量；
 * - 变更检测：轮询 Dexie 空间指纹（行数 + 最大 updatedAt），与上次推送
 *   的指纹比对，脏空间经防抖窗口合并后整体推送；
 * - 推送 = 每空间一个云文件（备份同信封 + spaceId/updatedAt）+ 索引文件
 *   （空间清单 + 更新时间）；推送前与云端索引做 LWW 比较——云端较新则
 *   本地不覆盖（较新版本胜出），相同也跳过；
 * - 失败重试：错误状态 + 指数退避（10s 起，封顶 5min），轮询周期内自动
 *   重试；「立即同步」忽略退避强制跑一轮；
 * - 未知版本（索引/空间文件 format/version 不匹配）明确报错，绝不覆盖本地。
 *
 * 时间线顺序保证：start() 完成初始评估（空库拉取）后才允许宿主创建空间，
 * 避免拉取恢复覆盖启动期间新建的空间（拉取前还会二次确认本地仍为空）。
 */

export interface SyncCoordinatorPorts {
  readonly adapter: CloudSyncAdapter;
  readonly backup: MemoryBackupRepository;
  readonly changes: SyncChangeSource;
  /** 同步开关：插件总开关 && R2 四项配置齐全（宿主 = settings 读取） */
  readonly isEnabled: () => boolean;
  readonly appVersion: () => string;
  /** 时钟（导出/索引文件的 exportedAt 与 LWW 时间戳） */
  readonly now: () => Date;
  readonly log?: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  /** 拉取恢复完成后回调（宿主 = manager.syncToCurrentChat，恢复绑定空间） */
  readonly onRestored?: () => void;
  /** 变更轮询间隔；缺省 2s */
  readonly pollIntervalMs?: number;
  /** 脏空间推送防抖窗口；缺省 3s */
  readonly debounceMs?: number;
  /** 失败重试基准间隔；缺省 10s，指数退避封顶 5min */
  readonly retryBaseMs?: number;
  /** 定时器端口（测试注入 fake timers）；缺省 = globalThis */
  readonly timers?: SyncTimerPort;
}

export interface SyncTimerPort {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_DEBOUNCE_MS = 3_000;
const DEFAULT_RETRY_BASE_MS = 10_000;
const MAX_RETRY_MS = 300_000;

/** 解析后的端口（可选字段带默认值），运行时只读 */
interface ResolvedSyncCoordinatorPorts extends SyncCoordinatorPorts {
  readonly pollIntervalMs: number;
  readonly debounceMs: number;
  readonly retryBaseMs: number;
  readonly timers: SyncTimerPort;
}

/** 云同步状态（设置面板与面板头部展示）：最近同步时间 + 失败提示可见。 */
export type CloudSyncStatus =
  | { readonly kind: "unconfigured" }
  | { readonly kind: "syncing" }
  | { readonly kind: "idle"; readonly lastSyncAt: string | undefined }
  | { readonly kind: "error"; readonly message: string; readonly lastSyncAt: string | undefined };

const defaultTimers: SyncTimerPort = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class CloudSyncCoordinator {
  readonly #ports: ResolvedSyncCoordinatorPorts;
  #status: CloudSyncStatus = { kind: "unconfigured" };
  #pushed = new Map<string, SpaceFingerprint>();
  /** 本次运行是否已成功拉取过（避免空库+空云时每轮都重复拉取） */
  #pulledOnce = false;
  #attempts = 0;
  #nextAttemptAt = 0;
  #lastSyncAt: string | undefined;
  #pollTimer: unknown = undefined;
  #debounceTimer: unknown = undefined;
  #stopped = false;
  #evaluating: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<() => void>();

  constructor(ports: SyncCoordinatorPorts) {
    this.#ports = {
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      debounceMs: DEFAULT_DEBOUNCE_MS,
      retryBaseMs: DEFAULT_RETRY_BASE_MS,
      timers: defaultTimers,
      ...ports,
    };
  }
  getStatus(): CloudSyncStatus {
    return this.#status;
  }

  /** 订阅同步状态变化（面板/设置展示）；返回退订函数 */
  onStatusChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * 启动（runtime 组合根调用）：立即评估一轮（空库拉取/脏空间推送，不等防抖），
   * 并在启用期间保持轮询。调用方应先 await 本方法再创建记忆空间，
   * 保证拉取先于空间创建。
   */
  async start(): Promise<void> {
    if (this.#stopped) return;
    await this.#queueEvaluate(true);
  }

  /** 停止（测试/卸载）：取消定时器，不再轮询。 */
  stop(): void {
    this.#stopped = true;
    this.#clearTimers();
  }

  /**
   * 设置变化后立即评估（幂等）：R2 配置补齐/改动时宿主调用，让开关
   * 即时生效；启用后轮询自动接管。
   */
  kick(): Promise<void> {
    return this.#queueEvaluate();
  }

  /**
   * 立即同步一轮（设置面板「立即同步」按钮）：忽略失败退避直接评估；
   * 空库时拉取，否则推送脏空间。
   */
  syncNow(): Promise<void> {
    this.#attempts = 0;
    this.#nextAttemptAt = 0;
    return this.#queueEvaluate(true);
  }

  /** 评估排队：并发触发串行执行，最终收敛到最新状态；单轮异常不毒化队列 */
  #queueEvaluate(force = false): Promise<void> {
    const run = this.#evaluating.then(() => this.#evaluate(force));
    this.#evaluating = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #evaluate(force = false): Promise<void> {
    if (this.#stopped) return;
    if (!this.#ports.isEnabled()) {
      // 未配置/插件停用：停止轮询，状态回到未配置
      this.#clearTimers();
      this.#setStatus({ kind: "unconfigured" });
      return;
    }
    this.#armPoll();
    if (!force && Date.now() < this.#nextAttemptAt) return; // 失败退避期内不动作
    try {
      const spaceIds = await this.#ports.changes.listSpaceIds();
      if (spaceIds.length === 0) {
        // 空库：启动或手动（force）时拉取全量；日常轮询不重复拉取（本地仍空则无事发生）
        if (!this.#pulledOnce || force) {
          await this.#pull();
          this.#pulledOnce = true;
        }
        return;
      }
      const dirty = await this.#findDirty(spaceIds);
      if (dirty.length === 0) {
        this.#setStatus({ kind: "idle", lastSyncAt: this.#lastSyncAt });
        return;
      }
      if (!force) {
        // 防抖：变更窗口内的多次变更合并为一次推送（窗口内不重复武装）
        if (this.#debounceTimer === undefined) {
          this.#debounceTimer = this.#ports.timers.setTimeout(() => {
            this.#debounceTimer = undefined;
            void this.#queueEvaluate(true);
          }, this.#ports.debounceMs);
        }
        return;
      }
      await this.#pushDirty(dirty);
    } catch (error) {
      this.#fail(error);
    }
  }

  /** 空库拉取全量：索引 → 逐空间文件 → 校验 → 整体恢复（原子，失败不碰本地） */
  async #pull(): Promise<void> {
    this.#setStatus({ kind: "syncing" });
    const entries = await this.#loadIndexEntries();

    const units: MemorySpaceBackup[] = [];
    for (const entry of entries) {
      const object = await this.#ports.adapter.getObject(cloudSpaceFileKey(entry.spaceId));
      if (object === null) continue; // 索引指向的文件缺失：跳过（容忍脏索引）
      // 信封/结构/完整性校验：未知版本抛错 → 中止整个拉取，绝不半拉取
      const file = parseCloudSpaceFile(object.body);
      // 索引条目与文件身份不一致：视为脏索引，跳过该文件（文件身份以自身为准）
      if (file.spaceId !== entry.spaceId) {
        this.#ports.log?.warn(
          `索引条目 ${entry.spaceId} 与文件身份 ${file.spaceId} 不一致，跳过`,
        );
        continue;
      }
      units.push(file.data);
    }

    if (units.length > 0) {
      // 拉取落地前二次确认本地仍为空（期间可能有其他路径创建了空间）——本地优先
      const current = await this.#ports.backup.loadSnapshot();
      if (current.spaces.length > 0) {
        this.#ports.log?.info("拉取前本地已有数据，放弃云端恢复（本地优先）");
        this.#setStatus({ kind: "idle", lastSyncAt: this.#lastSyncAt });
        return;
      }
      await this.#ports.backup.restoreSnapshot({ spaces: units });
    }

    this.#succeed();
    this.#ports.log?.info(`云同步拉取完成：恢复 ${units.length} 个记忆空间`);
    this.#ports.onRestored?.();
  }

  /** 推送脏空间：每空间文件 + 索引文件；任一步失败不标记已推送（下轮重试） */
  async #pushDirty(dirty: readonly string[]): Promise<void> {
    this.#setStatus({ kind: "syncing" });
    const cloudEntries = await this.#loadIndexEntries();
    const cloudBySpace = new Map(cloudEntries.map((entry) => [entry.spaceId, entry.updatedAt]));

    // 先逐空间取指纹（LWW 键），后读全量快照——若两者之间发生写入，下一轮会因
    // 指纹与已推送指纹不一致而再次推送（收敛）；顺序反过来会静默漏推
    const pending: { spaceId: string; fingerprint: SpaceFingerprint }[] = [];
    for (const spaceId of dirty) {
      const fingerprint = await this.#ports.changes.fingerprint(spaceId);
      const pushed = this.#pushed.get(spaceId);
      if (pushed !== undefined && fingerprintsEqual(pushed, fingerprint)) continue;
      pending.push({ spaceId, fingerprint });
    }

    // 全量快照只读一次，逐空间取单元
    const snapshot = await this.#ports.backup.loadSnapshot();
    const unitsBySpace = new Map<string, MemorySpaceBackup>(
      snapshot.spaces.map((unit) => [unit.space.id, unit]),
    );

    const uploaded: { spaceId: string; fingerprint: SpaceFingerprint }[] = [];
    for (const { spaceId, fingerprint } of pending) {
      // LWW：云端较新或相同 → 不覆盖（较新版本胜出），并视为已同步
      const decision = resolveCloudLww(fingerprint.updatedAt, cloudBySpace.get(spaceId));
      if (decision !== "local") {
        this.#pushed.set(spaceId, fingerprint);
        continue;
      }

      const unit = unitsBySpace.get(spaceId);
      if (unit === undefined) {
        // 本地已删除的空间不在清单里，不会进 dirty；这里兜底视为已同步
        this.#pushed.set(spaceId, fingerprint);
        continue;
      }

      const file = createCloudSpaceFile(
        unit,
        spaceId,
        fingerprint.updatedAt,
        this.#ports.appVersion(),
        this.#nowIso(),
      );
      await this.#ports.adapter.putObject(cloudSpaceFileKey(spaceId), JSON.stringify(file));
      uploaded.push({ spaceId, fingerprint });
    }

    if (uploaded.length > 0) {
      // 先全部空间文件、再索引文件；索引写失败则不标记已推送（下轮重传空间文件，
      // 幂等覆盖，保证索引最终一致）
      const merged = new Map(cloudBySpace);
      for (const item of uploaded) merged.set(item.spaceId, item.fingerprint.updatedAt);
      const entries: CloudIndexEntry[] = [...merged].map(([spaceId, updatedAt]) => ({
        spaceId,
        updatedAt,
      }));
      await this.#ports.adapter.putObject(
        CLOUD_INDEX_KEY,
        JSON.stringify(createCloudIndexFile(entries, this.#ports.appVersion(), this.#nowIso())),
      );
      for (const item of uploaded) this.#pushed.set(item.spaceId, item.fingerprint);
    }

    this.#succeed();
    this.#ports.log?.info(
      `云同步推送完成：${uploaded.length} 个空间，其余 ${dirty.length - uploaded.length} 个无需变更`,
    );
  }

  /** 读取并解码云端索引；不存在（404）→ 空清单；未知版本抛错（不覆盖本地） */
  async #loadIndexEntries(): Promise<readonly CloudIndexEntry[]> {
    const object = await this.#ports.adapter.getObject(CLOUD_INDEX_KEY);
    if (object === null) return [];
    return parseCloudIndexFile(object.body).spaces;
  }

  /** 与上次推送的指纹比对，找出内容有变化的空间 */
  async #findDirty(spaceIds: readonly string[]): Promise<readonly string[]> {
    const dirty: string[] = [];
    for (const spaceId of spaceIds) {
      const fingerprint = await this.#ports.changes.fingerprint(spaceId);
      const pushed = this.#pushed.get(spaceId);
      if (pushed === undefined || !fingerprintsEqual(pushed, fingerprint)) {
        dirty.push(spaceId);
      }
    }
    return dirty;
  }

  #succeed(): void {
    this.#attempts = 0;
    this.#nextAttemptAt = 0;
    this.#lastSyncAt = this.#nowIso();
    this.#setStatus({ kind: "idle", lastSyncAt: this.#lastSyncAt });
  }

  #fail(error: unknown): void {
    this.#attempts += 1;
    const delay = Math.min(
      this.#ports.retryBaseMs * 2 ** (this.#attempts - 1),
      MAX_RETRY_MS,
    );
    this.#nextAttemptAt = Date.now() + delay;
    const message = error instanceof Error ? error.message : String(error);
    this.#ports.log?.error(`云同步失败（${this.#attempts} 次，${delay}ms 后重试）：${message}`);
    this.#setStatus({ kind: "error", message, lastSyncAt: this.#lastSyncAt });
  }

  #nowIso(): string {
    return this.#ports.now().toISOString();
  }

  /** 启用期间保持轮询（每次评估续期；停用/停止时取消） */
  #armPoll(): void {
    if (this.#pollTimer !== undefined || this.#stopped) return;
    this.#pollTimer = this.#ports.timers.setTimeout(() => {
      this.#pollTimer = undefined;
      void this.#queueEvaluate();
    }, this.#ports.pollIntervalMs);
  }

  #clearTimers(): void {
    if (this.#pollTimer !== undefined) {
      this.#ports.timers.clearTimeout(this.#pollTimer);
      this.#pollTimer = undefined;
    }
    if (this.#debounceTimer !== undefined) {
      this.#ports.timers.clearTimeout(this.#debounceTimer);
      this.#debounceTimer = undefined;
    }
  }

  #setStatus(next: CloudSyncStatus): void {
    if (sameStatus(this.#status, next)) return;
    this.#status = next;
    for (const listener of this.#listeners) listener();
  }
}

function sameStatus(left: CloudSyncStatus, right: CloudSyncStatus): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "unconfigured":
    case "syncing":
      return true;
    case "idle":
      return (
        left.lastSyncAt ===
        (right as Extract<CloudSyncStatus, { kind: "idle" }>).lastSyncAt
      );
    case "error": {
      const rightError = right as Extract<CloudSyncStatus, { kind: "error" }>;
      return left.message === rightError.message && left.lastSyncAt === rightError.lastSyncAt;
    }
  }
}
