import type { MemorySpaceId, MemorySpaceReader } from "../memory/index.ts";
import {
  buildMemorySpaceTableDigest,
  composeProposalAgentSystemPrompt,
  composeTableDigestSummary,
} from "../agent/index.ts";
import type { MemoryMacroRegistrationPort } from "../macros/memory-macro-service.ts";
import { AGENT_PRESET_PLACEHOLDERS } from "./preset-composer.ts";

export const AGENT_TABLES_DIGEST_MACRO = AGENT_PRESET_PLACEHOLDERS.tablesDigest.slice(2, -2);
export const AGENT_SYSTEM_DEFAULT_PROMPT_MACRO =
  AGENT_PRESET_PLACEHOLDERS.systemDefaultPrompt.slice(2, -2);

export interface AgentMacroServicePorts {
  getSpaceId(): MemorySpaceId | undefined;
  readonly reader: MemorySpaceReader;
  readonly readEnabled: () => boolean;
  readonly registerMacro: MemoryMacroRegistrationPort;
  readonly log?: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

export interface AgentMacroSnapshot {
  readonly digestText: string;
  readonly defaultPromptText: string;
}

const EMPTY_SNAPSHOT: AgentMacroSnapshot = { digestText: "", defaultPromptText: "" };

/** ST 宏必须同步返回；运行时在 SQLite 提交、聊天及设置变化后显式刷新预计算结果。 */
export class AgentMacroService {
  private readonly ports: AgentMacroServicePorts;
  #active = false;
  #registered = false;
  #snapshot: AgentMacroSnapshot = EMPTY_SNAPSHOT;
  #spaceId: MemorySpaceId | undefined;
  #revision = 0;
  #refreshing = Promise.resolve();

  constructor(ports: AgentMacroServicePorts) {
    this.ports = ports;
  }

  getSnapshot(): AgentMacroSnapshot {
    return this.#snapshot;
  }

  start(): Promise<void> {
    this.#active = true;
    return this.kick();
  }

  stop(): void {
    this.#active = false;
    this.#revision++;
    this.#snapshot = EMPTY_SNAPSHOT;
    this.unregister();
  }

  kick(): Promise<void> {
    if (!this.#active) return Promise.resolve();
    const revision = ++this.#revision;
    const spaceId = this.ports.getSpaceId();
    if (spaceId !== this.#spaceId || !this.ports.readEnabled()) this.#snapshot = EMPTY_SNAPSHOT;
    this.#spaceId = spaceId;
    // 每次通知使先前读取失效；连续提交合并到最新一轮，迟到结果不能覆盖新聊天。
    this.#refreshing = this.#refreshing.then(() => this.refresh(revision));
    return this.#refreshing;
  }

  private async refresh(revision: number): Promise<void> {
    if (!this.#active || revision !== this.#revision) return;
    if (!this.ports.readEnabled()) {
      this.unregister();
      return;
    }
    if (!this.#registered) {
      this.ports.registerMacro.register(AGENT_TABLES_DIGEST_MACRO, () => this.#snapshot.digestText);
      this.ports.registerMacro.register(
        AGENT_SYSTEM_DEFAULT_PROMPT_MACRO,
        () => this.#snapshot.defaultPromptText,
      );
      this.#registered = true;
    }
    const spaceId = this.#spaceId;
    if (spaceId === undefined) return;
    try {
      const digest = await buildMemorySpaceTableDigest(this.ports.reader, spaceId);
      if (!this.#active || revision !== this.#revision) return;
      this.#snapshot = {
        digestText: composeTableDigestSummary(digest),
        defaultPromptText: composeProposalAgentSystemPrompt(digest),
      };
    } catch (error) {
      if (!this.#active || revision !== this.#revision) return;
      this.#snapshot = EMPTY_SNAPSHOT;
      this.ports.log?.error(
        `Agent 预设宏快照重建失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private unregister(): void {
    if (!this.#registered) return;
    this.ports.registerMacro.unregister(AGENT_TABLES_DIGEST_MACRO);
    this.ports.registerMacro.unregister(AGENT_SYSTEM_DEFAULT_PROMPT_MACRO);
    this.#registered = false;
  }
}
