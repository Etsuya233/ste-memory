import type { MemoryView } from "../macros/memory-views.ts";
import type { EntryPlacement, PluginSettings, SettingsStore } from "./plugin-settings.ts";

interface SettingsDependencies {
  readonly store: SettingsStore;
  readonly syncToCurrentChat: () => Promise<unknown>;
  readonly refreshMemoryMacros: () => Promise<void>;
  readonly refreshAgentMacros: () => Promise<void>;
  readonly refreshMirror: () => Promise<void>;
  readonly writeChatScopeMacros: (macros: readonly MemoryView[]) => void;
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
    );
    await Promise.all(changes);
  }

  async setMirrorEnabled(enabled: boolean): Promise<void> {
    const settings = this.read();
    this.save({ ...settings, mirror: { ...settings.mirror, enabled } });
    await this.dependencies.refreshMirror();
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
