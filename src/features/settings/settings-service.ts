import { resolveMacroRegistrationName } from "../macros/macro-name.ts";
import type { MemoryView } from "../macros/memory-views.ts";
import type { EntryPlacement, PluginSettings, SettingsStore } from "./plugin-settings.ts";
import { parseEmbeddingConnection, type EmbeddingConnection } from "./embedding-connection.ts";

interface SettingsDependencies {
  readonly store: SettingsStore;
  readonly syncToCurrentChat: () => Promise<unknown>;
  readonly refreshMemoryMacros: () => Promise<void>;
  readonly refreshAgentMacros: () => Promise<void>;
  readonly refreshMirror: () => Promise<void>;
  readonly writeChatScopeMacros: (macros: readonly MemoryView[]) => void;
  readonly refreshVectorIndex: () => Promise<void>;
  readonly refreshAutoFill?: () => void;
}

export class SettingsService {
  private readonly dependencies: SettingsDependencies;

  constructor(dependencies: SettingsDependencies) {
    this.dependencies = dependencies;
  }

  read(): PluginSettings {
    return this.dependencies.store.read();
  }

  save(settings: PluginSettings): void {
    this.dependencies.store.write(settings);
    this.dependencies.refreshAutoFill?.();
  }

  async setPluginEnabled(enabled: boolean): Promise<void> {
    this.save({ ...this.read(), enabled });
    // 设置先保存，各服务随后读取同一份新值；停用也立即注销宏并停止镜像。
    const changes: Promise<unknown>[] = [];
    if (enabled) changes.push(this.dependencies.syncToCurrentChat());
    changes.push(
      this.dependencies.refreshMemoryMacros(),
      this.dependencies.refreshAgentMacros(),
      this.dependencies.refreshMirror(),
      this.dependencies.refreshVectorIndex(),
    );
    await Promise.all(changes);
  }

  async setMirrorEnabled(enabled: boolean): Promise<void> {
    const settings = this.read();
    this.save({ ...settings, mirror: { ...settings.mirror, enabled } });
    await this.dependencies.refreshMirror();
  }

  async setEmbeddingConnection(connection: EmbeddingConnection | undefined): Promise<void> {
    this.save({ ...this.read(), embeddingConnection: parseEmbeddingConnection(connection) });
    await this.dependencies.refreshVectorIndex();
  }

  async setMirrorHistoryIncluded(includeHistory: boolean): Promise<void> {
    const settings = this.read();
    this.save({ ...settings, mirror: { ...settings.mirror, includeHistory } });
    await this.dependencies.refreshMirror();
  }

  async setMacroName(macroName: string): Promise<void> {
    if (resolveMacroRegistrationName(macroName)?.toLowerCase() === "memoryrecall")
      throw new Error("memoryRecall 为自动召回保留宏名");
    this.save({ ...this.read(), macroName });
    await this.dependencies.refreshMemoryMacros();
  }

  async setMacroLimit(macroLimit: number): Promise<void> {
    this.save({ ...this.read(), macroLimit });
    await this.dependencies.refreshMemoryMacros();
  }

  async setMemoryViews(memoryViews: readonly MemoryView[]): Promise<void> {
    this.save({ ...this.read(), memoryViews });
    await this.dependencies.refreshMemoryMacros();
  }

  async setChatScopeMacros(macros: readonly MemoryView[]): Promise<void> {
    this.dependencies.writeChatScopeMacros(macros);
    await this.dependencies.refreshMemoryMacros();
  }

  setEntryPlacement(entryPlacement: EntryPlacement): void {
    this.save({ ...this.read(), entryPlacement });
  }
}
