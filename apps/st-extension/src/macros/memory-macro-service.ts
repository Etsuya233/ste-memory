import type {
  MemoryRecord,
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
} from "@ste-memory/core/memory";
import { createReadTimeDisplayTextResolver } from "@ste-memory/core/memory";
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
import { renderMemoryFullSnapshot, renderMemoryViewSnapshot } from "./memory-view-render.ts";

/**
 * 记忆宏服务（插件纯逻辑 seam，ticket 15 / ADR 0004 + ticket 02 / ADR 0025 +
 * 双 Scope 宏系统复审）：`前缀::名字` 统一分发模型。
 *
 * - 注册：全局前缀由用户配置（设置面板，默认 {{ste}}），解析为 ST 注册名
 *   （裸标识符）后经 macros.register(name, { handler, unnamedArgs }) 注册；名字不
 *   合法/为空/插件停用 → 不注册（「不放置宏则无注入」）；名字变化 → 注销旧名再
 *   注册新名。注册带一个可选名字参数（{{前缀::名字}}，ST 位置参数语法，0/1 个）；
 *   两个以上参数由 ST 参数校验拒绝（文档说明）。
 * - 分发（handler 同步查表，无任何独立宏名注册）：
 *   - 无参 {{前缀}} → 默认快照（全部启用表分组摘要）；
 *   - {{前缀::名字}} → 优先级 对话级宏 > 全局视图 > 内置宏（full / 表 Key）；
 *     名字是字符串参数，表 Key 无需满足 ST 标识符规则（{{ste::角色}} 可用）。
 * - 快照：宏 handler 必须同步返回（ST 宏引擎同步约束，返回 Promise 会被字符串化），
 *   因此维护「组装好的记忆上下文文本」预计算快照——默认快照 + 每视图快照 +
 *   内置宏快照（full + 每启用表）；数据变更时重建。翻译失败（缺表/缺字段/筛选
 *   字段类型不支持）→ 对应名字快照 = 空串 + 日志（覆盖优先：空串不回落）；
 *   查询/渲染异常 → 单轮保旧值。
 * - 重建时机：轮询当前绑定空间的变更指纹（与云同步/镜像同机制，DexieSyncChangeSource），
 *   指纹变化（同步/填表/手动编辑/导入都会改变行数或最大 updatedAt）→ 重新组装；
 *   切对话（活动空间/chatMetadata 变化）同样在轮询里收敛；设置变化（前缀/上限/
 *   开关/视图 CRUD）由宿主 kick 立即评估。
 *
 * 组装规则见 memory-context-snapshot.ts（默认快照）与 memory-view-render.ts（视图/内置）。
 */

/** 内置全量宏名（{{前缀::full}}）：所有启用表完整 Markdown */
export const BUILTIN_FULL_ARG = "full";

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
  /** 位置参数（{{前缀::名字}} → ["名字"]；无参 → []） */
  readonly unnamedArgs?: readonly string[];
}

/** 宏参数声明（ST MacroUnnamedArgDef 子集；记忆宏 = 一个可选名字参数） */
export interface MemoryMacroArgSpec {
  readonly name: string;
  readonly optional?: boolean;
  readonly defaultValue?: string;
}

/** 记忆宏的可选名字参数声明（注册时传给 ST；{{前缀::名字}}） */
export const MEMORY_MACRO_NAME_ARG: MemoryMacroArgSpec = {
  name: "name",
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
    /** 全局前缀（{{ste}} 形态；解析为裸标识符后注册） */
    readonly macroName: string;
    readonly macroLimit: number;
    readonly memoryViews: readonly MemoryView[];
  };
  readonly registerMacro: MemoryMacroRegistrationPort;
  /** 空间变更指纹（宿主 = DexieSyncChangeSource，与云同步/镜像同机制） */
  readonly changes: SyncChangeSource;
  /** 聊天 Scope 宏（双 Scope 宏系统）：读取当前对话的聊天 Scope 宏定义 */
  readonly readChatScopeMacros: () => readonly MemoryView[];
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

/** 内置宏快照集合（{{前缀::full}} + 每个启用表 {{前缀::表Key}}） */
interface BuiltinSnapshots {
  readonly full: string;
  readonly perTable: ReadonlyMap<string, string>;
}

export class MemoryMacroService {
  readonly #ports: ResolvedMemoryMacroServicePorts;
  /** 当前已注册的前缀名（裸标识符）；未注册 = undefined */
  #registeredName: string | undefined;
  /** 默认快照（{{前缀}} 无参展开；无活动空间/无数据 = 空串） */
  #snapshot = "";
  /** 每视图快照（{{前缀::视图名}}；名字 → 文本） */
  #viewSnapshots = new Map<string, string>();
  /** 聊天 Scope 宏快照（{{前缀::宏名}}；名字 → 文本；配置错误 = 空串不回落） */
  #chatScopeSnapshots = new Map<string, string>();
  /** 内置宏快照（{{前缀::full}} + {{前缀::表Key}}） */
  #builtinSnapshots: BuiltinSnapshots = { full: "", perTable: new Map() };
  /** 最近一次重建时的空间与指纹（相同即内容等价，跳过重建）；上限/视图/聊天 Scope 也参与判定 */
  #lastSpaceId: MemorySpaceId | undefined;
  #lastFingerprint: SpaceFingerprint | undefined;
  #lastLimit: number | undefined;
  #lastViewsSignature: string | undefined;
  #lastChatScopeSignature: string | undefined;
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

  /** 当前默认快照文本（{{前缀}} 无参展开的返回源；调试/验收可读） */
  getSnapshot(): string {
    return this.#snapshot;
  }

  /** 当前全局视图快照（视图名 → 文本；调试/验收可读） */
  getViewSnapshot(viewName: string): string | undefined {
    return this.#viewSnapshots.get(viewName);
  }

  /** 当前聊天 Scope 宏快照（宏名 → 文本；调试/验收可读） */
  getChatScopeSnapshot(name: string): string | undefined {
    return this.#chatScopeSnapshots.get(name);
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

  /** 设置变化后立即评估（幂等）：前缀/上限/开关/视图改动时宿主调用（与 sync.kick 同语义）。 */
  kick(): Promise<void> {
    return this.#evaluator.kick();
  }

  async #evaluate(): Promise<void> {
    const settings = this.#ports.readSettings();
    const name = resolveMacroRegistrationName(settings.macroName);
    if (!settings.enabled || name === undefined) {
      // 插件停用 / 前缀缺失或不合法：注销旧注册、清空快照、不轮询（无宏可展开）；
      // 指纹/上限/视图状态一并重置——重新启用且数据未变时不能命中「指纹相同早退”而
      // 让快照永久为空（重建判定必须重新武装）
      this.#unregisterCurrent();
      this.#snapshot = "";
      this.#viewSnapshots = new Map();
      this.#chatScopeSnapshots = new Map();
      this.#builtinSnapshots = { full: "", perTable: new Map() };
      this.#lastSpaceId = undefined;
      this.#lastFingerprint = undefined;
      this.#lastLimit = undefined;
      this.#lastViewsSignature = undefined;
      this.#evaluator.clearPollTimer();
      return;
    }
    // 注册全局前缀宏（带一个可选名字参数）
    if (name !== this.#registeredName) {
      this.#unregisterCurrent();
      this.#ports.registerMacro.register(name, (context) => this.#snapshotFor(context), [
        MEMORY_MACRO_NAME_ARG,
      ]);
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
        this.#chatScopeSnapshots = new Map();
        this.#builtinSnapshots = { full: "", perTable: new Map() };
      }
      return;
    }
    try {
      const fingerprint = await this.#ports.changes.fingerprint(spaceId);
      const viewsSignature = JSON.stringify(settings.memoryViews);
      const chatScopeSignature = JSON.stringify(this.#ports.readChatScopeMacros());
      if (
        spaceId === this.#lastSpaceId &&
        this.#lastFingerprint !== undefined &&
        fingerprintsEqual(this.#lastFingerprint, fingerprint) &&
        // 上限/视图/聊天 Scope 是设置项：只改了它们也必须重建（指纹不反映设置）
        this.#lastLimit === settings.macroLimit &&
        this.#lastViewsSignature === viewsSignature &&
        this.#lastChatScopeSignature === chatScopeSignature
      ) {
        return;
      }
      await this.#rebuild(spaceId, fingerprint, settings);
      this.#lastChatScopeSignature = chatScopeSignature;
    } catch (error) {
      // 单轮失败只记日志：下轮轮询自然重试（快照保持旧值，宏仍可展开）
      this.#ports.log?.error(
        `记忆宏快照重建失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 宏 handler（同步）：无参 = 默认快照；一个参数 = 名字 → 按优先级分发
   * 对话级宏 > 全局视图 > 内置（full / 表 Key）；空参数/未知名字 → 空串 + 日志
   * （不阻断生成）。两个以上参数由 ST 参数校验拒绝（handler 只处理 0/1 个参数）。
   */
  #snapshotFor(context: MemoryMacroExecutionContext): string {
    const args = context?.unnamedArgs ?? [];
    if (args.length === 0) return this.#snapshot; // {{前缀}} = 默认快照
    const name = args[0] ?? "";
    if (name === "") {
      this.#ports.log?.warn("记忆宏：空名字参数，展开为空串");
      return "";
    }
    // 1. 对话级宏（当前对话，最高优先级）
    const chatSnapshot = this.#chatScopeSnapshots.get(name);
    if (chatSnapshot !== undefined) return chatSnapshot;
    // 2. 全局视图
    const viewSnapshot = this.#viewSnapshots.get(name);
    if (viewSnapshot !== undefined) return viewSnapshot;
    // 3. 内置宏：full（全量）→ 表 Key（单表）
    if (name === BUILTIN_FULL_ARG) return this.#builtinSnapshots.full;
    const tableSnapshot = this.#builtinSnapshots.perTable.get(name);
    if (tableSnapshot !== undefined) return tableSnapshot;
    this.#ports.log?.warn(`记忆宏：未知宏名「${name}」，展开为空串`);
    return "";
  }

  /** 重建快照：默认快照 = listTables + listRecords + 读时重渲显示文本 +
   *  assembleMemoryContextSnapshot；视图/聊天宏快照 = 翻译 → queryRecords（异步）→
   *  渲染 → 缓存（digest 每轮构建一次共用）；内置宏 = 同一批数据渲染 Markdown。 */
  async #rebuild(
    spaceId: MemorySpaceId,
    fingerprint: SpaceFingerprint,
    settings: {
      readonly macroLimit: number;
      readonly memoryViews: readonly MemoryView[];
    },
  ): Promise<void> {
    const tables = await this.#ports.data.listTables(spaceId);
    const recordsByTable = new Map<MemoryTableId, readonly MemoryRecord[]>();
    await Promise.all(
      tables.map(async (table) => {
        if (!table.enabled) return;
        recordsByTable.set(table.id, await this.#ports.data.listRecords(spaceId, table.id));
      }),
    );
    // 组装期间切走了空间：放弃本轮（下轮轮询按新状态重建）
    if (this.#ports.getSpaceId() !== spaceId) return;

    // 读时显示文本：模板策略表按当前定义与目标记录重渲（存储 displayText 可能过期），
    // 默认快照/视图快照/内置宏快照同语义。引用查找走本轮预载的全空间记录映射
    // （引用必在同空间内），零额外查询；预载未命中（如目标表停用未加载）按未找到渲染空串。
    const resolveDisplay = createReadTimeDisplayTextResolver({
      getTable: async (tableId) => tables.find((candidate) => candidate.id === tableId),
      getFields: (tableId) => this.#ports.reader.listFields(spaceId, tableId),
      findRecord: async (tableId, recordId) =>
        recordsByTable.get(tableId)?.find((candidate) => candidate.id === recordId),
    });
    const tableInputs = await Promise.all(
      tables.map(async (table) => ({
        name: table.name,
        enabled: table.enabled,
        records: await Promise.all(
          (recordsByTable.get(table.id) ?? []).map(async (record) => ({
            ...record,
            displayText: await resolveDisplay(record),
          })),
        ),
      })),
    );
    const snapshot = assembleMemoryContextSnapshot(tableInputs, settings.macroLimit);

    const digest = await buildMemorySpaceTableDigest(this.#ports.reader, spaceId);

    // 全局视图快照（{{前缀::视图名}}）
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

    // 聊天 Scope 宏快照（{{前缀::宏名}}，优先于全局视图/内置宏）：
    // 与全局视图同一翻译 → 查询 → 渲染管线；配置错误 = 空串（覆盖优先，不回落）
    const chatScopeSnapshots = new Map<string, string>();
    for (const macro of this.#ports.readChatScopeMacros()) {
      const previous = this.#chatScopeSnapshots.get(macro.name);
      try {
        const plan = planMemoryViewQuery(macro, digest);
        if (plan === undefined) {
          this.#ports.log?.warn(
            `记忆宏：聊天 Scope 宏「${macro.name}」配置错误（表/字段不存在或已停用），展开为空串`,
          );
          chatScopeSnapshots.set(macro.name, "");
          continue;
        }
        const page = await this.#ports.reader.queryRecords(spaceId, plan.query);
        const referenceLabels =
          macro.projection.length > 0
            ? await resolveViewReferenceLabels(
                this.#ports.reader,
                spaceId,
                digest,
                plan.table,
                page.records,
                macro.projection,
              )
            : new Map();
        const text = renderMemoryViewSnapshot({
          view: macro,
          fields: plan.table.fields,
          records: page.records,
          referenceLabels,
          limit: settings.macroLimit,
        });
        chatScopeSnapshots.set(macro.name, text);
      } catch (error) {
        // 单轮失败保旧值（与全局视图同语义）；下轮轮询重试
        if (previous !== undefined) chatScopeSnapshots.set(macro.name, previous);
        this.#ports.log?.error(
          `记忆宏聊天 Scope「${macro.name}」快照重建失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // 内置宏快照（{{前缀::full}} + 每启用表 {{前缀::表Key}}）：表 Key 是字符串
    // 参数，无需满足 ST 标识符规则（{{ste::角色}} 可用）；失败保旧值
    const builtinSnapshots = await this.#buildBuiltinSnapshots(
      spaceId,
      tables,
      settings.macroLimit,
      resolveDisplay,
      recordsByTable,
    );

    this.#snapshot = snapshot;
    this.#viewSnapshots = viewSnapshots;
    this.#chatScopeSnapshots = chatScopeSnapshots;
    this.#builtinSnapshots = builtinSnapshots;
    this.#lastSpaceId = spaceId;
    this.#lastFingerprint = fingerprint;
    this.#lastLimit = settings.macroLimit;
    this.#lastViewsSignature = JSON.stringify(settings.memoryViews);
  }

  /** 内置宏快照：full = 所有启用表逐表 section；perTable = 每启用表单表渲染。 */
  async #buildBuiltinSnapshots(
    spaceId: MemorySpaceId,
    tables: readonly MemoryTable[],
    macroLimit: number,
    resolveDisplay: ReturnType<typeof createReadTimeDisplayTextResolver>,
    recordsByTable: ReadonlyMap<MemoryTableId, readonly MemoryRecord[]>,
  ): Promise<BuiltinSnapshots> {
    try {
      const enabledTables = tables.filter((table) => table.enabled);
      const tableInputs: {
        readonly name: string;
        readonly fields: readonly { readonly name: string; readonly id: string }[];
        readonly records: readonly {
          readonly payload: Map<string, MemoryRecord["payload"][string]>;
          readonly displayText: string;
        }[];
      }[] = [];
      const perTable = new Map<string, string>();
      for (const table of enabledTables) {
        const fields = await this.#ports.reader.listFields(spaceId, table.id);
        const enabledFields = fields.filter((field) => field.enabled);
        const records = recordsByTable.get(table.id) ?? [];
        const recordsWithDisplay = await Promise.all(
          records.map(async (record) => ({
            payload: new Map(Object.entries(record.payload)),
            displayText: await resolveDisplay(record),
          })),
        );
        const input = {
          name: table.name,
          fields: enabledFields.map((field) => ({ name: field.name, id: field.id })),
          records: recordsWithDisplay,
        };
        tableInputs.push(input);
        perTable.set(table.key, renderMemoryFullSnapshot({ tables: [input], limit: macroLimit }));
      }
      return {
        full: renderMemoryFullSnapshot({ tables: tableInputs, limit: macroLimit }),
        perTable,
      };
    } catch (error) {
      // 单轮失败保旧值（下轮轮询重试）
      this.#ports.log?.error(
        `记忆宏内置宏快照重建失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return this.#builtinSnapshots;
    }
  }

  #unregisterCurrent(): void {
    if (this.#registeredName === undefined) return;
    this.#ports.registerMacro.unregister(this.#registeredName);
    this.#registeredName = undefined;
  }
}
