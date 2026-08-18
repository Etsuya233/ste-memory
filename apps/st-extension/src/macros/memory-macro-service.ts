import type {
  MemoryRecord,
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
} from "@ste-memory/core/memory";
import type { MemorySpaceReader } from "@ste-memory/core/memory/agent";
import { buildMemorySpaceTableDigest } from "@ste-memory/core/memory/agent";
import {
  fingerprintsEqual,
  type SpaceFingerprint,
  type SyncChangeSource,
} from "../cloud/space-fingerprint.ts";
import type { SyncTimerPort } from "../cloud/sync-coordinator.ts";
import { PollingEvaluator } from "../polling-evaluator.ts";
import type { MemoryView } from "../settings/memory-views.ts";
import { resolveMacroRegistrationName } from "./macro-name.ts";
import { assembleMemoryContextSnapshot } from "./memory-context-snapshot.ts";
import { planMemoryViewQuery, resolveViewReferenceLabels } from "./memory-view-query.ts";
import { renderMemoryViewSnapshot } from "./memory-view-render.ts";

/**
 * 记忆宏服务（插件纯逻辑 seam，ticket 15 / ADR 0004 + ticket 02 / ADR 0025）：
 *
 * - 注册：宏名由用户配置（设置面板，默认 {{memoryContext}}），解析为 ST 注册名
 *   （裸标识符）后经 macros.register(name, { handler, unnamedArgs }) 注册；名字不
 *   合法/为空/插件停用 → 不注册（「不放置宏则无注入」）；名字变化 → 注销旧名再
 *   注册新名。注册带一个可选视图名参数（{{宏名::视图名}}，ST 位置参数语法）；
 *   两个以上参数由 ST 参数校验拒绝（文档说明）。
 * - 快照：宏 handler 必须同步返回（ST 宏引擎同步约束，返回 Promise 会被字符串化），
 *   因此维护「组装好的记忆上下文文本」预计算快照——默认快照（无参展开，ticket 15
 *   行为不变）+ 每视图快照（{{宏名::视图名}} 展开）；数据变更时重建。
 * - 视图快照重建 = 视图翻译成记忆查询（core 查询契约）经 reader.queryRecords
 *   异步执行 → 渲染 → 缓存；翻译失败（缺表/缺字段/筛选字段类型不支持）→ 该视图
 *   快照 = 空串 + 日志（面板可显示配置错误）；查询/渲染异常 → 单轮保旧值。
 * - 重建时机：轮询当前绑定空间的变更指纹（与云同步/镜像同机制，DexieSyncChangeSource），
 *   指纹变化（同步/填表/手动编辑/导入都会改变行数或最大 updatedAt）→ 重新组装；
 *   切对话（活动空间变化）同样在轮询里收敛；设置变化（宏名/上限/开关/视图 CRUD）
 *   由宿主 kick 立即评估。
 *
 * 组装规则见 memory-context-snapshot.ts（默认快照）与 memory-view-render.ts（视图）。
 */

/** 宏数据端口：宿主 = Dexie repository（结构满足 core 端口契约的窄子集） */
export interface MemoryMacroDataPorts {
  listTables(memorySpaceId: MemorySpaceId): Promise<readonly MemoryTable[]>;
  listRecords(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
  ): Promise<readonly MemoryRecord[]>;
}

/** ST 宏执行上下文子集（宿主 = ST MacroExecutionContext；宏 handler 的入参） */
export interface MemoryMacroExecutionContext {
  /** 位置参数（{{宏名::视图名}} → ["视图名"]；无参 → []） */
  readonly unnamedArgs?: readonly string[];
}

/** 宏参数声明（ST MacroUnnamedArgDef 子集；记忆宏 = 一个可选视图名参数） */
export interface MemoryMacroArgSpec {
  readonly name: string;
  readonly optional?: boolean;
  readonly defaultValue?: string;
}

/** 记忆宏的可选视图名参数声明（注册时传给 ST） */
export const MEMORY_MACRO_VIEW_NAME_ARG: MemoryMacroArgSpec = {
  name: "viewName",
  optional: true,
  defaultValue: "",
};

/** 宏注册端口：宿主 = StChatAdapter（ST context.macros，薄层不测） */
export interface MemoryMacroRegistrationPort {
  /** 注册宏：name 为裸标识符（不含花括号）；同名覆盖是 ST 语义；args 缺省 = 无参数宏 */
  register(
    name: string,
    handler: (context: MemoryMacroExecutionContext) => string,
    args?: readonly MemoryMacroArgSpec[],
  ): void;
  /** 注销宏：名字变化/不合法/插件停用时清理旧注册 */
  unregister(name: string): void;
}

export interface MemoryMacroServicePorts {
  /** 当前活动记忆空间（宿主 = ChatSpaceManager 状态）；undefined = 无活动空间 */
  getSpaceId(): MemorySpaceId | undefined;
  readonly data: MemoryMacroDataPorts;
  /** 记忆空间只读端口（视图翻译/查询/引用解析；与填表任务/Agent 预设宏共用 reader） */
  readonly reader: MemorySpaceReader;
  /** 设置读取（宿主 = settings.read() 子集）：每次评估重取，保证拿到最新值 */
  readonly readSettings: () => {
    readonly enabled: boolean;
    readonly macroName: string;
    readonly macroLimit: number;
    readonly memoryViews: readonly MemoryView[];
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
  /** 默认快照（宏 handler 无参返回；无活动空间/无数据 = 空串） */
  #snapshot = "";
  /** 每视图快照（宏 handler 按视图名参数返回；视图名 → 文本） */
  #viewSnapshots = new Map<string, string>();
  /** 最近一次重建时的空间与指纹（相同即内容等价，跳过重建）；上限/视图也参与判定 */
  #lastSpaceId: MemorySpaceId | undefined;
  #lastFingerprint: SpaceFingerprint | undefined;
  #lastLimit: number | undefined;
  #lastViewsSignature: string | undefined;
  /** 排队评估 + 指纹轮询骨架（与 Agent 预设宏服务共用，ticket 17） */
  readonly #evaluator: PollingEvaluator;

  constructor(ports: MemoryMacroServicePorts) {
    const resolved: ResolvedMemoryMacroServicePorts = {
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      timers: defaultTimers,
      ...ports,
    };
    this.#ports = resolved;
    this.#evaluator = new PollingEvaluator({
      evaluate: () => this.#evaluate(),
      pollIntervalMs: resolved.pollIntervalMs,
      timers: resolved.timers,
    });
  }

  /** 当前默认快照文本（宏 handler 无参展开的返回源；调试/验收可读） */
  getSnapshot(): string {
    return this.#snapshot;
  }

  /** 当前视图快照（视图名 → 文本；调试/验收可读） */
  getViewSnapshot(viewName: string): string | undefined {
    return this.#viewSnapshots.get(viewName);
  }

  /** 启动（runtime 组合根调用）：立即注册宏 + 重建快照，并保持轮询刷新。
   *  快照重建时机：指纹轮询（2s）+ 面板数据操作后的 kick（宿主侧补，
   *  sync/mirror 同模式）——Dexie 核心无「任何写事务提交」事件（changes 属
   *  Syncable 插件），轮询是服务侧唯一变更感知通道。 */
  start(): Promise<void> {
    return this.#evaluator.start();
  }

  /** 停止（测试）：取消定时器，不再轮询；注册保留（页面生命周期内同名覆盖无害）。 */
  stop(): void {
    this.#evaluator.stop();
  }

  /** 设置变化后立即评估（幂等）：宏名/上限/开关/视图改动时宿主调用（与 sync.kick 同语义）。 */
  kick(): Promise<void> {
    return this.#evaluator.kick();
  }

  async #evaluate(): Promise<void> {
    const settings = this.#ports.readSettings();
    const name = resolveMacroRegistrationName(settings.macroName);
    if (!settings.enabled || name === undefined) {
      // 插件停用 / 宏名缺失或不合法：注销旧注册、清空快照、不轮询（无宏可展开）；
      // 指纹/上限/视图状态一并重置——重新启用且数据未变时不能命中「指纹相同早退”而
      // 让快照永久为空（重建判定必须重新武装）
      this.#unregisterCurrent();
      this.#snapshot = "";
      this.#viewSnapshots = new Map();
      this.#lastSpaceId = undefined;
      this.#lastFingerprint = undefined;
      this.#lastLimit = undefined;
      this.#lastViewsSignature = undefined;
      this.#evaluator.clearPollTimer();
      return;
    }
    if (name !== this.#registeredName) {
      this.#unregisterCurrent();
      this.#ports.registerMacro.register(
        name,
        (context) => this.#snapshotFor(context),
        [MEMORY_MACRO_VIEW_NAME_ARG],
      );
      this.#registeredName = name;
    }
    this.#evaluator.armPoll();
    const spaceId = this.#ports.getSpaceId();
    if (spaceId === undefined) {
      // 无活动空间（未绑定/切对话间隙）：快照置空，下轮轮询自然恢复
      if (this.#lastSpaceId !== undefined) {
        this.#lastSpaceId = undefined;
        this.#lastFingerprint = undefined;
        this.#lastLimit = undefined;
        this.#lastViewsSignature = undefined;
        this.#snapshot = "";
        this.#viewSnapshots = new Map();
      }
      return;
    }
    try {
      const fingerprint = await this.#ports.changes.fingerprint(spaceId);
      const viewsSignature = JSON.stringify(settings.memoryViews);
      if (
        spaceId === this.#lastSpaceId &&
        this.#lastFingerprint !== undefined &&
        fingerprintsEqual(this.#lastFingerprint, fingerprint) &&
        // 上限/视图是设置项：只改了它们也必须重建（指纹不反映设置）
        this.#lastLimit === settings.macroLimit &&
        this.#lastViewsSignature === viewsSignature
      ) {
        return;
      }
      await this.#rebuild(spaceId, fingerprint, settings);
    } catch (error) {
      // 单轮失败只记日志：下轮轮询自然重试（快照保持旧值，宏仍可展开）
      this.#ports.log?.error(
        `记忆宏快照重建失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 宏 handler（同步）：无参 = 默认快照；一个参数 = 视图名 → 视图快照；
   *  空参数/未知视图名 → 空串 + 日志（不阻断生成）。两个以上参数由 ST 参数
   *  校验拒绝（handler 只处理 0/1 个参数，文档说明）。 */
  #snapshotFor(context: MemoryMacroExecutionContext): string {
    const args = context?.unnamedArgs ?? [];
    if (args.length === 0) return this.#snapshot; // 无参 = 默认快照（ticket 15 行为不变）
    const viewName = args[0] ?? "";
    if (viewName === "") {
      this.#ports.log?.warn("记忆宏：空视图名参数，展开为空串");
      return "";
    }
    const viewSnapshot = this.#viewSnapshots.get(viewName);
    if (viewSnapshot === undefined) {
      this.#ports.log?.warn(`记忆宏：未知视图「${viewName}」，展开为空串`);
      return "";
    }
    return viewSnapshot;
  }

  /** 重建快照：默认快照维持 ticket 15 现状（listTables + listRecords +
   *  assembleMemoryContextSnapshot）；视图快照 = 翻译 → queryRecords（异步）→
   *  渲染 → 缓存（digest 每轮构建一次，全部视图共用）。 */
  async #rebuild(
    spaceId: MemorySpaceId,
    fingerprint: SpaceFingerprint,
    settings: {
      readonly macroLimit: number;
      readonly memoryViews: readonly MemoryView[];
    },
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
    const snapshot = assembleMemoryContextSnapshot(tableInputs, settings.macroLimit);

    const digest = await buildMemorySpaceTableDigest(this.#ports.reader, spaceId);
    const viewSnapshots = new Map<string, string>();
    for (const view of settings.memoryViews) {
      try {
        const plan = planMemoryViewQuery(view, digest);
        if (plan === undefined) {
          // 配置错误（缺表/缺字段/筛选字段类型不支持）：该视图快照 = 空串
          this.#ports.log?.warn(
            `记忆宏：视图「${view.name}」配置错误（表/字段不存在或已停用），展开为空串`,
          );
          viewSnapshots.set(view.name, "");
          continue;
        }
        const page = await this.#ports.reader.queryRecords(spaceId, plan.query);
        const referenceLabels =
          view.projection.length > 0
            ? await resolveViewReferenceLabels(
                this.#ports.reader,
                spaceId,
                digest,
                plan.table,
                page.records,
                view.projection,
              )
            : new Map();
        const text = renderMemoryViewSnapshot({
          view,
          fields: plan.table.fields,
          records: page.records,
          referenceLabels,
          limit: settings.macroLimit,
        });
        viewSnapshots.set(view.name, text);
      } catch (error) {
        // 单轮失败保旧值：重建判定（指纹/视图设置变化）后收敛——
        // 确定性失败不因轮询重复刷日志（配置错误走翻译失败路径，见上）
        const previous = this.#viewSnapshots.get(view.name);
        if (previous !== undefined) viewSnapshots.set(view.name, previous);
        this.#ports.log?.error(
          `记忆宏视图「${view.name}」快照重建失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    this.#snapshot = snapshot;
    this.#viewSnapshots = viewSnapshots;
    this.#lastSpaceId = spaceId;
    this.#lastFingerprint = fingerprint;
    this.#lastLimit = settings.macroLimit;
    this.#lastViewsSignature = JSON.stringify(settings.memoryViews);
  }

  #unregisterCurrent(): void {
    if (this.#registeredName === undefined) return;
    this.#ports.registerMacro.unregister(this.#registeredName);
    this.#registeredName = undefined;
  }
}
