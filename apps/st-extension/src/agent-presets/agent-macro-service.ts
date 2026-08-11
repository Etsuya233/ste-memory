/**
 * Agent 提示词预设宏服务（ticket 17 / ADR 0006）：把 {{tablesDigest}} 与
 * {{systemDefaultPrompt}} 注册为 ST 全局宏（与记忆宏同模式，用户可在角色卡/
 * 提示词中使用；Agent 预设文本内的展开走 preset-composer 自研展开，不经此处）。
 *
 * ST 宏 handler 必须同步（Promise 会被字符串化）→ 维护预计算快照：
 * - digestText：当前活动空间的表/字段摘要（composeTableDigestSummary）；
 * - defaultPromptText：默认提示词全文（composeProposalAgentSystemPrompt）。
 * 重建时机 = 指纹轮询（与记忆宏/云同步同机制：Dexie 无写事务事件，轮询是
 * 服务侧唯一变更感知通道）；无活动空间 → 快照置空，轮询自然恢复。
 */
import {
  buildMemorySpaceTableDigest,
  composeProposalAgentSystemPrompt,
  composeTableDigestSummary,
  type MemorySpaceReader,
} from "@ste-memory/core/memory/agent";
import type { MemorySpaceId } from "@ste-memory/core/memory";
import { fingerprintsEqual, type SpaceFingerprint, type SyncChangeSource } from "../cloud/space-fingerprint.ts";
import type { SyncTimerPort } from "../cloud/sync-coordinator.ts";
import { PollingEvaluator } from "../polling-evaluator.ts";
import type { MemoryMacroRegistrationPort } from "../macros/memory-macro-service.ts";
import { AGENT_PRESET_PLACEHOLDERS } from "./preset-composer.ts";

/**
 * ST 注册名（裸标识符）：从占位符文案派生（单源：改占位符名自动跟随，
 * 与 AGENT_PRESET_PLACEHOLDERS 不脱节）。
 */
export const AGENT_TABLES_DIGEST_MACRO = AGENT_PRESET_PLACEHOLDERS.tablesDigest.slice(2, -2);
export const AGENT_SYSTEM_DEFAULT_PROMPT_MACRO = AGENT_PRESET_PLACEHOLDERS.systemDefaultPrompt.slice(2, -2);

/** 宏服务端口（宿主 = runtime：ChatSpaceManager 状态 + reader + ST 宏注册 + 变更源） */
export interface AgentMacroServicePorts {
  /** 当前活动记忆空间（undefined = 无活动空间，快照置空） */
  getSpaceId(): MemorySpaceId | undefined;
  /** 记忆空间只读端口（digest 构建；与填表任务共用同一组 repository） */
  readonly reader: MemorySpaceReader;
  /** 插件总开关（停用 → 注销宏 + 停止轮询） */
  readonly readEnabled: () => boolean;
  readonly registerMacro: MemoryMacroRegistrationPort;
  /** 空间变更指纹（宿主 = DexieSyncChangeSource，与云同步/镜像/记忆宏同机制） */
  readonly changes: SyncChangeSource;
  readonly log?: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  /** 指纹轮询间隔；缺省 2s（与记忆宏同节奏） */
  readonly pollIntervalMs?: number;
  readonly timers?: SyncTimerPort;
}

/** 预计算快照（宏 handler 同步返回；无活动空间/停用 = 空串） */
export interface AgentMacroSnapshot {
  readonly digestText: string;
  readonly defaultPromptText: string;
}

const EMPTY_SNAPSHOT: AgentMacroSnapshot = { digestText: "", defaultPromptText: "" };

const defaultTimers: SyncTimerPort = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const DEFAULT_POLL_INTERVAL_MS = 2_000;

export class AgentMacroService {
  readonly #ports: Required<Pick<AgentMacroServicePorts, "pollIntervalMs" | "timers">> &
    AgentMacroServicePorts;
  #registered = false;
  #snapshot: AgentMacroSnapshot = EMPTY_SNAPSHOT;
  #lastSpaceId: MemorySpaceId | undefined;
  #lastFingerprint: SpaceFingerprint | undefined;
  /** 排队评估 + 指纹轮询骨架（与记忆宏服务共用，ticket 17） */
  readonly #evaluator: PollingEvaluator;

  constructor(ports: AgentMacroServicePorts) {
    const resolved: Required<Pick<AgentMacroServicePorts, "pollIntervalMs" | "timers">> &
      AgentMacroServicePorts = {
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

  /** 当前快照（调试/验收可读） */
  getSnapshot(): AgentMacroSnapshot {
    return this.#snapshot;
  }

  /** 启动（runtime 组合根调用）：注册两个宏 + 重建快照 + 保持轮询刷新。 */
  start(): Promise<void> {
    return this.#evaluator.start();
  }

  /** 停止（测试）：取消定时器，不再轮询；注册保留（页面生命周期内同名覆盖无害）。 */
  stop(): void {
    this.#evaluator.stop();
  }

  /** 立即评估（幂等）：插件开关改动时宿主调用（与 sync.kick / macro.kick 同语义）。 */
  kick(): Promise<void> {
    return this.#evaluator.kick();
  }

  async #evaluate(): Promise<void> {
    if (!this.#ports.readEnabled()) {
      // 插件停用：注销宏、清空快照、不轮询；状态重置——重新启用且数据未变时
      // 不能命中「指纹相同早退」而让快照永久为空。
      this.#unregisterCurrent();
      this.#snapshot = EMPTY_SNAPSHOT;
      this.#lastSpaceId = undefined;
      this.#lastFingerprint = undefined;
      this.#evaluator.clearPollTimer();
      return;
    }
    if (!this.#registered) {
      this.#ports.registerMacro.register(AGENT_TABLES_DIGEST_MACRO, () => this.#snapshot.digestText);
      this.#ports.registerMacro.register(AGENT_SYSTEM_DEFAULT_PROMPT_MACRO, () => this.#snapshot.defaultPromptText);
      this.#registered = true;
    }
    this.#evaluator.armPoll();
    const spaceId = this.#ports.getSpaceId();
    if (spaceId === undefined) {
      // 无活动空间（未绑定/切对话间隙）：快照置空，下轮轮询自然恢复
      if (this.#lastSpaceId !== undefined) {
        this.#lastSpaceId = undefined;
        this.#lastFingerprint = undefined;
        this.#snapshot = EMPTY_SNAPSHOT;
      }
      return;
    }
    try {
      const fingerprint = await this.#ports.changes.fingerprint(spaceId);
      if (
        spaceId === this.#lastSpaceId &&
        this.#lastFingerprint !== undefined &&
        fingerprintsEqual(this.#lastFingerprint, fingerprint)
      ) {
        return;
      }
      const digest = await buildMemorySpaceTableDigest(this.#ports.reader, spaceId);
      this.#snapshot = {
        digestText: composeTableDigestSummary(digest),
        defaultPromptText: composeProposalAgentSystemPrompt(digest),
      };
      this.#lastSpaceId = spaceId;
      this.#lastFingerprint = fingerprint;
    } catch (error) {
      // 单轮失败只记日志：下轮轮询自然重试（快照保持旧值，宏仍可展开）
      this.#ports.log?.error(
        `Agent 预设宏快照重建失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #unregisterCurrent(): void {
    if (!this.#registered) return;
    this.#ports.registerMacro.unregister(AGENT_TABLES_DIGEST_MACRO);
    this.#ports.registerMacro.unregister(AGENT_SYSTEM_DEFAULT_PROMPT_MACRO);
    this.#registered = false;
  }
}
