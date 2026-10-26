import { validateMemoryMacro, type MemoryMacro } from "../macros/macro-expression.ts";
import type { EntryPlacement, PluginSettings, SettingsStore } from "./plugin-settings.ts";
import { parseEmbeddingConnection, type EmbeddingConnection } from "./embedding-connection.ts";

interface SettingsDependencies {
  readonly store: SettingsStore;
  readonly syncToCurrentChat: () => Promise<unknown>;
  readonly refreshMemoryMacros: () => Promise<void>;
  readonly refreshAgentMacros: () => Promise<void>;
  readonly refreshMirror: () => Promise<void>;
  readonly writeChatScopeMacros: (macros: readonly MemoryMacro[]) => Promise<void> | void;
  readonly refreshVectorIndex: () => Promise<void>;
  readonly refreshAutoFill?: () => void;
  readonly validateMacros: (macros: readonly MemoryMacro[]) => Promise<void>;
  readonly getChatContext: () => string;
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
    this.save({ ...this.read(), macroName });
    await this.dependencies.refreshMemoryMacros();
  }

  async setMacroLimit(macroLimit: number): Promise<void> {
    this.save({ ...this.read(), macroLimit });
    await this.dependencies.refreshMemoryMacros();
  }

  async setMacros(macros: readonly MemoryMacro[]): Promise<void> {
    for (const macro of macros) validateMemoryMacro(macro);
    if (new Set(macros.map((macro) => macro.name)).size !== macros.length)
      throw new Error("宏名称重复");
    const previous = this.read().macros;
    await this.dependencies.validateMacros(
      macros.filter(
        (macro) =>
          !previous.some(
            (item) =>
              item.id === macro.id &&
              JSON.stringify(item.expression) === JSON.stringify(macro.expression),
          ),
      ),
    );
    this.save({ ...this.read(), macros });
    await this.dependencies.refreshMemoryMacros();
  }

  async setChatScopeMacros(macros: readonly MemoryMacro[]): Promise<void> {
    const context = this.dependencies.getChatContext();
    for (const macro of macros) validateMemoryMacro(macro);
    if (new Set(macros.map((macro) => macro.name)).size !== macros.length)
      throw new Error("宏名称重复");
    await this.dependencies.validateMacros(macros);
    if (context !== this.dependencies.getChatContext())
      throw new Error("对话已切换，未保存原对话的宏草稿");
    await this.dependencies.writeChatScopeMacros(macros);
    await this.dependencies.refreshMemoryMacros();
  }

  setEntryPlacement(entryPlacement: EntryPlacement): void {
    this.save({ ...this.read(), entryPlacement });
  }
}
