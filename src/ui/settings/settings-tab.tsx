import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createBackupFile, serializeBackupFile } from "../../features/backup/index.ts";
import {
  backupFilename,
  buildSpaceExportUnit,
  executeFullBackupImport,
  planFullBackupImport,
  spaceExportFilename,
} from "../../features/backup/space-transfer.ts";
import { downloadTextFile, saveTextFile } from "../../infrastructure/browser/download.ts";
import type { MemorySpaceId, MemoryTableId } from "../../features/memory/index.ts";
import type { ChatMirrorStatus } from "../../features/chat-mirror/chat-metadata-mirror-sync.ts";
import type { EntryPlacement, PluginSettings } from "../../features/settings/plugin-settings.ts";
import type { SpaceContextStatus } from "../../features/chat-binding/chat-space-manager.ts";
import { executeSpaceImport, planSpaceImport } from "../../features/chat-binding/space-import.ts";
import type { MemoryView } from "../../features/macros/memory-views.ts";
import type { QueryChatStore } from "../../features/query-chat/query-chat-state.ts";
import {
  DEFAULT_ENTRY_PLAN,
  ENTRY_PLACEMENT_LABELS,
  ENTRY_PLACEMENT_OPTIONS,
  actualPlacementNote,
  entryGroupSummary,
  type EntryMountPlan,
} from "../shell/entry-placement.ts";
import { testAgentConnection } from "../../infrastructure/sillytavern/llm/st-backends-status.ts";
import {
  agentConnectionsSummary,
  agentPresetsSummary,
  cleaningSummary,
  isExpanded as isSettingsGroupExpanded,
  loadExpandedGroups,
  macroSummary,
  mirrorSummary,
  saveExpandedGroups,
  tablePresetsSummary,
  toggleGroup as toggleSettingsGroup,
  type SettingsGroupKey,
} from "../shell/settings-collapsed-model.ts";
import {
  DEFAULT_SAFE_AREA,
  SAFE_AREA_EDGE_LABELS,
  SAFE_AREA_EDGES,
  SAFE_AREA_PRESETS,
  clampSafeAreaValue,
  loadSafeArea,
  safeAreaSummary,
  saveSafeArea,
  type PanelSafeArea,
  type SafeAreaEdge,
} from "../shell/safe-area-model.ts";
import {
  activeStatus,
  reportError,
  reportInfo,
  reportSuccess,
  reportWarning,
} from "../shell/ui-helpers.tsx";
import { safeLocalStorage } from "../shell/panel-window.ts";
import { mirrorStatusSummary, runtimeStatusLabel } from "../shell/space-info.ts";
import { AgentPresetManager } from "./agent-preset-manager.tsx";
import { AgentConnectionManager } from "./agent-connection-manager.tsx";
import { CleaningRulesManager } from "./cleaning-rules-manager.tsx";
import { MemoryViewsManager } from "./memory-views-manager.tsx";
import { ChatScopeMacrosManager } from "./chat-scope-macros-manager.tsx";
import { BuiltinMacrosList } from "./builtin-macros-list.tsx";
import { TablePresetManager } from "./table-preset-manager.tsx";
import type { SettingsService } from "../../features/settings/settings-service.ts";
import type { MemoryFieldService, MemoryTableService } from "../../features/memory/index.ts";
import type { MemoryBackupRepository } from "../../features/backup/index.ts";
import type { ChatSpaceManager } from "../../features/chat-binding/chat-space-manager.ts";
import type { ChatMetadataMirrorSync } from "../../features/chat-mirror/chat-metadata-mirror-sync.ts";
import type { MemoryMacroService } from "../../features/macros/memory-macro-service.ts";
import type { SpaceMaintenanceService } from "../../features/space-maintenance/space-maintenance-service.ts";
import type { TablePresetApplyService } from "../../features/table-presets/table-preset-apply-service.ts";
import type {
  ResolvedTablePreset,
  TablePresetStructure,
} from "../../features/table-presets/preset-model.ts";
import { captureSpaceStructure } from "../../features/table-presets/space-structure-capture.ts";
import type { AgentPresetPreviewPorts } from "../../features/agent-presets/preset-preview-model.ts";
import type { MacroOverviewRow } from "../../features/macros/macro-overview-model.ts";
import type { EntryMountControllerPort } from "../shell/entry-placement.ts";
import type { StRegexEntry } from "../../infrastructure/sillytavern/chat-adapter.ts";
import type { FillSourceMessage } from "../../features/fill-tasks/fill-task.ts";

// ---- 设置 Tab ----

/** 记忆宏组内作用域分区：内置宏（只读）/ 全局宏 / 对话级宏 / 宏设置（全局设置） */
type MacroScopeTab = "builtin" | "global" | "chat" | "settings";

const MACRO_SCOPE_TABS: readonly { readonly key: MacroScopeTab; readonly label: string }[] = [
  { key: "builtin", label: "内置宏" },
  { key: "global", label: "全局宏" },
  { key: "chat", label: "对话级宏" },
  { key: "settings", label: "宏设置" },
];

/**
 * 宏设置分区（「记忆宏」组「宏设置」tab）：全局前缀 + 字符上限，记忆宏家族共用。
 * 纯展示：输入绑定 settings，变更经 onNameChange/onLimitChange 写库并 kick。
 */
export function MacroSettingsFields(props: {
  readonly macroName: string;
  readonly macroLimit: number;
  readonly onNameChange: (value: string) => void;
  readonly onLimitChange: (value: string) => void;
}) {
  return (
    <div className="stm-setting-subgroup" data-stm-section="macro-settings">
      <input
        className="stm-input"
        type="text"
        data-stm-field="macro-name"
        value={props.macroName}
        placeholder="{{ste}}"
        onChange={(event) => props.onNameChange(event.target.value)}
      />
      <input
        className="stm-input"
        type="number"
        min="0"
        step="100"
        data-stm-field="macro-limit"
        value={props.macroLimit}
        onChange={(event) => props.onLimitChange(event.target.value)}
      />
      <div className="stm-setting-hint">
        前缀放入提示词预设（角色卡/系统提示/作者注释）或世界书条目内容后，生成时展开 当前记忆：
        {"{{前缀}}"} = 全部启用表分组快照；{"{{前缀::名字}}"} = 内置宏 （full / 表
        Key）、全局视图或对话级宏（同名优先级 对话 &gt; 全局 &gt; 内置）；
        超过上方字符上限从尾部截断并附「……（已截断）」标记；不填前缀则不注入
      </div>
    </div>
  );
}
export function SettingsTab(props: {
  readonly settingsService: SettingsService;
  readonly tables: Pick<MemoryTableService, "list">;
  readonly fields: Pick<MemoryFieldService, "list">;
  readonly manager: Pick<ChatSpaceManager, "getStatus" | "syncToCurrentChat" | "importSpace">;
  readonly backup: Pick<
    MemoryBackupRepository,
    "loadSnapshot" | "restoreSnapshot" | "restoreSpace"
  >;
  readonly mirror: Pick<ChatMetadataMirrorSync, "kick" | "flushRebuiltSpace">;
  readonly macro: Pick<MemoryMacroService, "kick">;
  readonly spaceMaintenance: Pick<SpaceMaintenanceService, "clearRecords">;
  /** 表格预设应用服务（spec table-presets）：停止写入 + 原子重建 + 来源更新 */
  readonly presetApply: Pick<
    TablePresetApplyService,
    "stopSpaceWrites" | "applyPreset" | "assertCurrentChat"
  >;
  readonly cleaning: {
    readonly readSelection: () => string | undefined;
    readonly writeSelection: (listId: string | undefined) => void;
    readonly readStRegexEntries: () => readonly StRegexEntry[];
    readonly readRecentMessages: (count: number) => readonly FillSourceMessage[];
    readonly readChatScopeMacros: () => readonly MemoryView[];
  };
  readonly presetPreview: AgentPresetPreviewPorts;
  readonly macroOverview: () => readonly MacroOverviewRow[];
  readonly entryMount?: EntryMountControllerPort;
  readonly version: string;
  readonly status: SpaceContextStatus | undefined;
  readonly settings: PluginSettings;
  /** 对话文件镜像状态（ticket 16：体积 + 上次写回时间） */
  readonly mirrorStatus: ChatMirrorStatus;
  /** 问答面板页面内存历史（spec reset-space：清除/重置后清空当前空间历史） */
  readonly queryChatStore: QueryChatStore;
  /** 面板元素引用（面板安全区 CSS 变量落在面板元素上；仅移动断点消费） */
  readonly panelElementRef: RefObject<HTMLElement | null>;
  readonly onSettingsChange: (settings: PluginSettings) => void;
  /** 整库数据变更（导入备份成功）后的通知：触发依赖数据的区块重取 */
  readonly onDataChanged: () => void;
}) {
  // 当前对话的清洗列表选择（ticket 22）：本地态 = chatMetadata 小指针的镜像，
  // 变更即写 chatMetadata（防抖持久化）；对话切换（status 变化）后重新读取。
  const [chatCleaningListId, setChatCleaningListId] = useState<string | undefined>(() =>
    props.cleaning.readSelection(),
  );
  useEffect(() => {
    setChatCleaningListId(props.cleaning.readSelection());
  }, [props.status, props.cleaning]);
  // 当前对话的聊天 Scope 宏（双 Scope 宏系统）：本地态 = chatMetadata 的镜像，
  // 变更即写 chatMetadata（防抖持久化）+ macro.kick()；对话切换（status 变化）后重新读取。
  const [chatScopeMacros, setChatScopeMacros] = useState<readonly MemoryView[]>(() =>
    props.cleaning.readChatScopeMacros(),
  );
  useEffect(() => {
    setChatScopeMacros(props.cleaning.readChatScopeMacros());
  }, [props.status, props.cleaning]);
  // 「记忆宏」组内作用域分区（内置/全局/对话级）；默认全局（原有行为）
  const [macroScopeTab, setMacroScopeTab] = useState<MacroScopeTab>("global");
  // 导入文件输入（按钮触发隐藏 input；重置 value 允许重复选择同一文件）
  const importInputRef = useRef<HTMLInputElement>(null);
  // 单空间导入文件输入
  const importSpaceInputRef = useRef<HTMLInputElement>(null);

  /** 设置服务同步保存新值，再等待联动；先刷新展示，失败由 UI 报告。 */
  async function changeSettings(change: () => Promise<void>): Promise<void> {
    try {
      const pending = change();
      props.onSettingsChange(props.settingsService.read());
      await pending;
    } catch (error) {
      reportError(error);
    }
  }

  function saveSettings(next: PluginSettings): void {
    props.settingsService.save(next);
    props.onSettingsChange(next);
  }

  function togglePlugin(enabled: boolean): void {
    void changeSettings(() => props.settingsService.setPluginEnabled(enabled));
  }

  function toggleMirror(enabled: boolean): void {
    void changeSettings(() => props.settingsService.setMirrorEnabled(enabled));
  }

  function toggleMirrorHistory(includeHistory: boolean): void {
    void changeSettings(() => props.settingsService.setMirrorHistoryIncluded(includeHistory));
  }

  async function exportBackup(): Promise<void> {
    try {
      const snapshot = await props.backup.loadSnapshot();
      const file = createBackupFile(snapshot, props.version, new Date().toISOString());
      downloadTextFile(serializeBackupFile(file), backupFilename(file.exportedAt));
      reportSuccess(`已导出 ${file.data.spaces.length} 个记忆空间`);
    } catch (error) {
      reportError(error);
    }
  }

  /** 全库导入：解析与编排在 features/backup，面板只做文件/确认/提示。 */
  async function importBackup(file: File): Promise<void> {
    let text: string;
    try {
      text = await file.text();
    } catch (error) {
      reportError(error);
      return;
    }
    const plan = planFullBackupImport(text);
    if (plan.kind === "error") {
      reportError(new Error(plan.message));
      return;
    }
    if (!window.confirm(plan.confirmMessage)) return;
    try {
      await executeFullBackupImport(plan, {
        backup: props.backup,
        syncToCurrentChat: () => props.manager.syncToCurrentChat(),
        kickMacros: () => void props.macro.kick().catch(reportError),
        onDataChanged: props.onDataChanged,
      });
      reportSuccess(`已从备份恢复 ${plan.spaceCount} 个记忆空间`);
    } catch (error) {
      reportError(error);
    }
  }

  /** 当前对话是否绑定了记忆空间（决定「导出当前空间」按钮是否可用，用户 story 6）。 */
  const canExportSpace = props.status?.kind === "active";

  /**
   * 导出当前空间（issue 26）：只序列化当前绑定空间的一个单元（单空间信封格式，
   * 与全库备份同构），按「包含修订历史」设置裁剪历史，下载为独立 JSON 文件。
   */
  async function exportSpaceBackup(): Promise<void> {
    const active = activeStatus(props.status);
    if (!active) return;
    const macros = props.cleaning.readChatScopeMacros();
    try {
      const text = await spaceBackupText(
        active.space.id,
        props.settings.mirror.includeHistory,
        macros,
      );
      downloadTextFile(text, spaceExportFilename(new Date().toISOString()));
      reportSuccess(`已导出记忆空间「${active.space.name}」`);
    } catch (error) {
      reportError(error);
    }
  }

  /**
   * 导入到当前空间（issue 26）：解析与动作判定在 features/chat-binding（plan），
   * 面板只做文件选择、确认与提示；执行成功后刷新面板 + 重建宏快照 + kick 镜像。
   */
  async function importSpaceBackup(file: File): Promise<void> {
    let text: string;
    try {
      text = await file.text();
    } catch (error) {
      reportError(error);
      return;
    }
    const plan = planSpaceImport(text, props.manager.getStatus());
    if (plan.kind === "error") {
      reportError(new Error(plan.message));
      return;
    }
    if (!window.confirm(plan.confirmMessage)) return;
    try {
      reportInfo("正在导入…");
      await executeSpaceImport(plan, {
        backup: props.backup,
        manager: props.manager,
        kickMacros: () => void props.macro.kick().catch(reportError),
        kickMirror: () => void props.mirror.kick().catch(reportError),
        onDataChanged: props.onDataChanged,
        // 文件携带对话级宏时写回当前对话（缺省 = 保持当前对话的宏）
        writeChatScopeMacros: (macros) => {
          void changeSettings(() => props.settingsService.setChatScopeMacros(macros));
          setChatScopeMacros(macros);
        },
      });
      reportSuccess(`已导入记忆空间「${plan.spaceName}」`);
    } catch (error) {
      reportError(error);
    }
  }

  /**
   * 空间维护操作：清除空间记录（spec reset-space）。仅当前对话绑定空间
   * （active 状态）且插件开启时可执行；原生 confirm 确认，文案写明删除范围与
   * 「对话文件镜像副本也会被清空」。执行成功后刷新面板数据、重建记忆宏快照、
   * kick 镜像写回、清空问答面板当前空间历史。
   */
  const canMaintainSpace = props.status?.kind === "active" && props.settings.enabled;

  async function clearSpaceRecords(): Promise<void> {
    const status = props.status;
    if (status?.kind !== "active") return;
    const space = status.space;
    const confirmed = window.confirm(
      `清除「${space.name}」的全部记录？将删除所有表格中的记录、历史与证据，表格结构保留；对话文件镜像中的副本也会被清空。`,
    );
    if (!confirmed) return;
    try {
      await props.spaceMaintenance.clearRecords(space.id);
      reportSuccess(`已清除「${space.name}」的全部记录`);
      afterSpaceDataChange(space.id);
    } catch (error) {
      reportError(error);
    }
  }

  async function spaceBackupText(
    spaceId: MemorySpaceId,
    includeHistory: boolean,
    macros: readonly MemoryView[],
  ): Promise<string> {
    const snapshot = await props.backup.loadSnapshot();
    const unit = buildSpaceExportUnit(snapshot, spaceId, includeHistory, macros);
    if (!unit) throw new Error("未找到目标记忆空间的数据，无法备份");
    return serializeBackupFile(
      createBackupFile({ spaces: [unit] }, props.version, new Date().toISOString()),
    );
  }

  /** 先打开文件保存器保留用户激活，保存句柄确认后才停止任务和构建完整备份。 */
  async function savePresetBackup(spaceId: MemorySpaceId, chatIdentity: string): Promise<boolean> {
    assertPresetTarget(spaceId, chatIdentity);
    return saveTextFile(async () => {
      assertPresetTarget(spaceId, chatIdentity);
      await props.presetApply.stopSpaceWrites(spaceId);
      assertPresetTarget(spaceId, chatIdentity);
      const macros = props.cleaning.readChatScopeMacros();
      // 重建会删除全部历史，安全备份必须独立于镜像的体积裁剪设置。
      return spaceBackupText(spaceId, true, macros);
    }, spaceExportFilename(new Date().toISOString()));
  }

  function assertPresetTarget(spaceId: MemorySpaceId, chatIdentity: string): void {
    props.presetApply.assertCurrentChat(chatIdentity);
    const status = props.manager.getStatus();
    if (status?.kind !== "active" || status.space.id !== spaceId) {
      throw new Error("记忆空间绑定已变化，请重新确认目标空间");
    }
  }

  /** 读取当前活动空间的表结构（另存为预设 / 用当前结构覆盖预设）。 */
  async function readSpaceStructure(): Promise<TablePresetStructure> {
    const active = activeStatus(props.status);
    if (!active) throw new Error("当前对话没有活动的记忆空间");
    return captureSpaceStructure(
      {
        listTables: (spaceId) => props.tables.list(spaceId),
        listFields: (spaceId, tableId) => props.fields.list(spaceId, tableId),
      },
      active.space.id,
    );
  }

  /**
   * 应用预设（spec 6.2/6.4）：只作用传入的空间；成功后清空该空间页面内存的
   * 问答历史、刷新面板数据与空间展示（重新同步空间上下文：初始化来源随之更新），
   * 宏与镜像同步由应用服务在重建提交后执行并回报。
   */
  async function applyPresetToSpace(
    spaceId: MemorySpaceId,
    preset: ResolvedTablePreset,
    chatIdentity: string,
  ) {
    assertPresetTarget(spaceId, chatIdentity);
    const outcome = await props.presetApply.applyPreset(spaceId, preset, {
      chatIdentity,
      refreshMacros: () => props.macro.kick(),
      syncMirror: () => props.mirror.flushRebuiltSpace(spaceId, chatIdentity),
    });
    // 页面内存问答历史按空间清理（不落库、不随备份）
    props.queryChatStore.clearSpaceHistory(spaceId);
    // 重建已提交：立即重同步空间上下文，让初始化来源与空间展示更新
    try {
      await props.manager.syncToCurrentChat();
    } catch (error) {
      reportWarning(
        `空间已重建，但空间展示刷新失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return outcome;
  }

  /** 空间内容已变更（清除记录/应用预设）后的面板侧收尾。 */
  function afterSpaceDataChange(spaceId: MemorySpaceId): void {
    props.onDataChanged();
    void props.macro.kick().catch(reportError);
    void props.mirror.kick().catch(reportError);
    props.queryChatStore.clearSpaceHistory(spaceId);
  }

  function updateMacroName(value: string): void {
    void changeSettings(() => props.settingsService.setMacroName(value));
  }

  function updateMacroLimit(value: string): void {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    void changeSettings(() => props.settingsService.setMacroLimit(parsed));
  }

  /** 宏预览读取口（内置/全局/对话级行共用）：完整宏名 → 预计算快照文本（未知 = 空串） */
  function readMacroPreview(name: string): string {
    return props.macroOverview().find((row) => row.name === name)?.text ?? "";
  }

  // ---- 折叠状态（纯展示偏好，持久化到 localStorage，不进 PluginSettings） ----
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<SettingsGroupKey>>(() => {
    try {
      return loadExpandedGroups(safeLocalStorage());
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    saveExpandedGroups(safeLocalStorage(), expandedGroups);
  }, [expandedGroups]);
  function toggleGroup(key: SettingsGroupKey): void {
    setExpandedGroups((prev) => toggleSettingsGroup(prev, key));
  }

  // ---- 面板安全区（本机显示偏好，localStorage；仅移动断点消费，桌面惰性） ----
  const [safeArea, setSafeArea] = useState<PanelSafeArea>(() => {
    try {
      return loadSafeArea(safeLocalStorage());
    } catch {
      return DEFAULT_SAFE_AREA;
    }
  });
  useEffect(() => {
    saveSafeArea(safeLocalStorage(), safeArea);
  }, [safeArea]);
  // 落到面板元素 CSS 变量（移动媒体查询消费为四边内缩；桌面查询显式覆盖 left/top/right/height，惰性）
  useEffect(() => {
    const style = props.panelElementRef.current?.style;
    if (!style) return;
    for (const edge of SAFE_AREA_EDGES) {
      style.setProperty(`--stm-safe-${edge}`, `${safeArea[edge]}px`);
    }
  }, [safeArea, props.panelElementRef]);
  /** 单边输入：非法不落库，合法值钳制到 [0, 120] 整数（与宏上限输入同模式） */
  function updateSafeAreaEdge(edge: SafeAreaEdge, raw: string): void {
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) return;
    const value = clampSafeAreaValue(parsed);
    setSafeArea((prev) => (prev[edge] === value ? prev : { ...prev, [edge]: value }));
  }

  // ---- 面板入口（全局设置，存插件设置；切换即时生效——replan 热切换挂载点） ----
  const entryPlan: EntryMountPlan = useSyncExternalStore(
    (listener) => props.entryMount?.onPlanChange(listener) ?? (() => {}),
    () => props.entryMount?.getPlan() ?? DEFAULT_ENTRY_PLAN,
    () => props.entryMount?.getPlan() ?? DEFAULT_ENTRY_PLAN,
  );
  /** 改入口位置：写设置 + 通知挂载控制器重解析（顶部/魔法棒/两者即时换挂载点） */
  function updateEntryPlacement(placement: EntryPlacement): void {
    if (props.settings.entryPlacement === placement) return;
    props.settingsService.setEntryPlacement(placement);
    props.onSettingsChange(props.settingsService.read());
    props.entryMount?.replan();
  }

  return (
    <>
      {/* 插件总开关：钉顶且默认展开（不参与折叠） */}
      <div className="stm-setting-group" data-group="plugin-toggle">
        <div className="stm-setting-row">
          <div className="stm-setting-label">
            <div className="stm-setting-name">插件总开关</div>
            <div className="stm-setting-hint">关闭后暂停空间绑定与同步；面板仍可打开重新启用</div>
          </div>
          <label className="stm-switch">
            <input
              type="checkbox"
              data-action="toggle-plugin"
              checked={props.settings.enabled}
              onChange={(event) => togglePlugin(event.target.checked)}
            />
            <span className="stm-switch-track" aria-hidden="true"></span>
          </label>
        </div>
      </div>

      {/* 记忆宏：常用首位 */}
      <div className="stm-setting-group stm-setting-group--collapsible" data-group="macro">
        <button
          type="button"
          className="stm-setting-group-header"
          data-action="toggle-settings-group"
          data-group="macro"
          aria-expanded={isSettingsGroupExpanded(expandedGroups, "macro")}
          onClick={() => toggleGroup("macro")}
        >
          <div className="stm-setting-group-header-main">
            <div className="stm-setting-group-title stm-setting-group-title--collapsible">
              记忆宏
            </div>
            <div className="stm-setting-group-summary">
              {macroSummary(props.settings, chatScopeMacros.length)}
            </div>
          </div>
          <i
            className={`fa-solid ${isSettingsGroupExpanded(expandedGroups, "macro") ? "fa-chevron-up" : "fa-chevron-down"}`}
            aria-hidden="true"
          />
        </button>
        {isSettingsGroupExpanded(expandedGroups, "macro") && (
          <div className="stm-setting-group-body">
            {/* 作用域分区：内置宏（只读）/ 全局宏 / 对话级宏 */}
            <div className="stm-macro-scope-tabs" role="tablist" aria-label="记忆宏作用域">
              {MACRO_SCOPE_TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  className="stm-macro-scope-tab"
                  role="tab"
                  data-action="macro-scope"
                  data-macro-scope={tab.key}
                  aria-selected={macroScopeTab === tab.key}
                  onClick={() => setMacroScopeTab(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* 内置宏：系统宏只读列表（默认快照 + {{前缀::full}} + {{前缀::表Key}}；
                Agent 预设宏 {{tablesDigest}}/{{systemDefaultPrompt}}，每行右侧预览按钮 */}
            {macroScopeTab === "builtin" && (
              <BuiltinMacrosList
                prefix={props.settings.macroName.replace(/[{}]/g, "")}
                spaceId={props.status?.kind === "active" ? props.status.space.id : undefined}
                readTables={(spaceId) => props.tables.list(spaceId as MemorySpaceId)}
                readPreview={readMacroPreview}
              />
            )}

            {/* 全局宏：视图 CRUD（前缀/上限设置在「宏设置」分区） */}
            {macroScopeTab === "global" && (
              <>
                <MemoryViewsManager
                  prefix={props.settings.macroName.replace(/[{}]/g, "")}
                  spaceId={props.status?.kind === "active" ? props.status.space.id : undefined}
                  readTables={(spaceId) => props.tables.list(spaceId as MemorySpaceId)}
                  readFields={(spaceId, tableId) =>
                    props.fields.list(spaceId as MemorySpaceId, tableId as MemoryTableId)
                  }
                  readPreview={readMacroPreview}
                  views={props.settings.memoryViews}
                  onChange={(views) => {
                    void changeSettings(() => props.settingsService.setMemoryViews(views));
                  }}
                />
              </>
            )}

            {/* 对话级宏：聊天 Scope 宏 CRUD（随对话文件走） */}
            {macroScopeTab === "chat" && (
              <ChatScopeMacrosManager
                prefix={props.settings.macroName.replace(/[{}]/g, "")}
                spaceId={props.status?.kind === "active" ? props.status.space.id : undefined}
                readTables={(spaceId) => props.tables.list(spaceId as MemorySpaceId)}
                readFields={(spaceId, tableId) =>
                  props.fields.list(spaceId as MemorySpaceId, tableId as MemoryTableId)
                }
                readPreview={readMacroPreview}
                macros={chatScopeMacros}
                onChange={(macros) => {
                  void changeSettings(() => props.settingsService.setChatScopeMacros(macros));
                  setChatScopeMacros(macros);
                }}
              />
            )}

            {/* 宏设置：全局前缀 + 字符上限（记忆宏家族共用） */}
            {macroScopeTab === "settings" && (
              <MacroSettingsFields
                macroName={props.settings.macroName}
                macroLimit={props.settings.macroLimit}
                onNameChange={updateMacroName}
                onLimitChange={updateMacroLimit}
              />
            )}
          </div>
        )}
      </div>

      {/* 表格预设：新空间默认 / 当前空间应用 / 预设管理（spec table-presets） */}
      <div className="stm-setting-group stm-setting-group--collapsible" data-group="table-presets">
        <button
          type="button"
          className="stm-setting-group-header"
          data-action="toggle-settings-group"
          data-group="table-presets"
          aria-expanded={isSettingsGroupExpanded(expandedGroups, "table-presets")}
          onClick={() => toggleGroup("table-presets")}
        >
          <div className="stm-setting-group-header-main">
            <div className="stm-setting-group-title stm-setting-group-title--collapsible">
              表格预设
            </div>
            <div className="stm-setting-group-summary">{tablePresetsSummary(props.settings)}</div>
          </div>
          <i
            className={`fa-solid ${isSettingsGroupExpanded(expandedGroups, "table-presets") ? "fa-chevron-up" : "fa-chevron-down"}`}
            aria-hidden="true"
          />
        </button>
        {isSettingsGroupExpanded(expandedGroups, "table-presets") && (
          <div className="stm-setting-group-body stm-setting-group-body--manager">
            <TablePresetManager
              presets={props.settings.tablePresets}
              status={props.status}
              pluginEnabled={props.settings.enabled}
              onPresetsChange={(presets) => {
                saveSettings({ ...props.settings, tablePresets: presets });
              }}
              readSpaceStructure={readSpaceStructure}
              onPrepareApply={(spaceId, chatIdentity) => {
                assertPresetTarget(spaceId, chatIdentity);
                return props.presetApply.stopSpaceWrites(spaceId);
              }}
              onApplyPreset={applyPresetToSpace}
              onBackupSpace={savePresetBackup}
              onDataChanged={props.onDataChanged}
            />
          </div>
        )}
      </div>

      {/* Agent 连接 */}
      <div
        className="stm-setting-group stm-setting-group--collapsible"
        data-group="agent-connections"
      >
        <button
          type="button"
          className="stm-setting-group-header"
          data-action="toggle-settings-group"
          data-group="agent-connections"
          aria-expanded={isSettingsGroupExpanded(expandedGroups, "agent-connections")}
          onClick={() => toggleGroup("agent-connections")}
        >
          <div className="stm-setting-group-header-main">
            <div className="stm-setting-group-title stm-setting-group-title--collapsible">
              Agent 连接
            </div>
            <div className="stm-setting-group-summary">
              {agentConnectionsSummary(props.settings)}
            </div>
          </div>
          <i
            className={`fa-solid ${isSettingsGroupExpanded(expandedGroups, "agent-connections") ? "fa-chevron-up" : "fa-chevron-down"}`}
            aria-hidden="true"
          />
        </button>
        {isSettingsGroupExpanded(expandedGroups, "agent-connections") && (
          <div className="stm-setting-group-body stm-setting-group-body--manager">
            <AgentConnectionManager
              settings={props.settings}
              onChange={(next) => {
                saveSettings(next);
              }}
              onTestConnection={(connection) => testAgentConnection(connection)}
            />
          </div>
        )}
      </div>

      {/* Agent 提示词预设 */}
      <div className="stm-setting-group stm-setting-group--collapsible" data-group="agent-presets">
        <button
          type="button"
          className="stm-setting-group-header"
          data-action="toggle-settings-group"
          data-group="agent-presets"
          aria-expanded={isSettingsGroupExpanded(expandedGroups, "agent-presets")}
          onClick={() => toggleGroup("agent-presets")}
        >
          <div className="stm-setting-group-header-main">
            <div className="stm-setting-group-title stm-setting-group-title--collapsible">
              Agent 提示词预设
            </div>
            <div className="stm-setting-group-summary">{agentPresetsSummary(props.settings)}</div>
          </div>
          <i
            className={`fa-solid ${isSettingsGroupExpanded(expandedGroups, "agent-presets") ? "fa-chevron-up" : "fa-chevron-down"}`}
            aria-hidden="true"
          />
        </button>
        {isSettingsGroupExpanded(expandedGroups, "agent-presets") && (
          <div className="stm-setting-group-body stm-setting-group-body--manager">
            <AgentPresetManager
              settings={props.settings}
              presetPreview={props.presetPreview}
              onChange={(next) => {
                saveSettings(next);
              }}
            />
          </div>
        )}
      </div>

      {/* 清洗规则 */}
      <div className="stm-setting-group stm-setting-group--collapsible" data-group="cleaning">
        <button
          type="button"
          className="stm-setting-group-header"
          data-action="toggle-settings-group"
          data-group="cleaning"
          aria-expanded={isSettingsGroupExpanded(expandedGroups, "cleaning")}
          onClick={() => toggleGroup("cleaning")}
        >
          <div className="stm-setting-group-header-main">
            <div className="stm-setting-group-title stm-setting-group-title--collapsible">
              清洗规则
            </div>
            <div className="stm-setting-group-summary">
              {cleaningSummary(props.settings, chatCleaningListId)}
            </div>
          </div>
          <i
            className={`fa-solid ${isSettingsGroupExpanded(expandedGroups, "cleaning") ? "fa-chevron-up" : "fa-chevron-down"}`}
            aria-hidden="true"
          />
        </button>
        {isSettingsGroupExpanded(expandedGroups, "cleaning") && (
          <div className="stm-setting-group-body stm-setting-group-body--manager">
            <CleaningRulesManager
              settings={props.settings}
              selectedListId={chatCleaningListId}
              onSelectList={(listId) => {
                props.cleaning.writeSelection(listId);
                setChatCleaningListId(listId);
              }}
              onChange={(next) => {
                saveSettings(next);
              }}
              readStRegexEntries={props.cleaning.readStRegexEntries}
              readRecentMessages={props.cleaning.readRecentMessages}
            />
          </div>
        )}
      </div>

      {/* 数据备份 */}
      <div className="stm-setting-group stm-setting-group--collapsible" data-group="backup">
        <button
          type="button"
          className="stm-setting-group-header"
          data-action="toggle-settings-group"
          data-group="backup"
          aria-expanded={isSettingsGroupExpanded(expandedGroups, "backup")}
          onClick={() => toggleGroup("backup")}
        >
          <div className="stm-setting-group-header-main">
            <div className="stm-setting-group-title stm-setting-group-title--collapsible">
              数据备份
            </div>
            <div className="stm-setting-group-summary">导出/导入全库</div>
          </div>
          <i
            className={`fa-solid ${isSettingsGroupExpanded(expandedGroups, "backup") ? "fa-chevron-up" : "fa-chevron-down"}`}
            aria-hidden="true"
          />
        </button>
        {isSettingsGroupExpanded(expandedGroups, "backup") && (
          <div className="stm-setting-group-body">
            <div className="stm-setting-actions">
              <button
                type="button"
                className="stm-button"
                data-action="export-backup"
                onClick={() => void exportBackup()}
              >
                导出备份
              </button>
              <button
                type="button"
                className="stm-button"
                data-action="import-backup"
                onClick={() => importInputRef.current?.click()}
              >
                导入备份
              </button>
            </div>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              data-stm-field="import-backup-file"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importBackup(file);
                event.target.value = "";
              }}
            />
            <div className="stm-setting-hint">
              导出下载全库 JSON 备份文件；导入前校验文件并整体替换当前数据
            </div>
            <div className="stm-setting-divider" />
            <div className="stm-setting-actions">
              <button
                type="button"
                className="stm-button"
                data-action="export-space-backup"
                disabled={!canExportSpace}
                title={canExportSpace ? undefined : "当前对话未绑定记忆空间"}
                onClick={() => void exportSpaceBackup()}
              >
                导出当前空间
              </button>
              <button
                type="button"
                className="stm-button"
                data-action="import-space-backup"
                onClick={() => importSpaceInputRef.current?.click()}
              >
                导入到当前空间
              </button>
            </div>
            <input
              ref={importSpaceInputRef}
              type="file"
              accept="application/json,.json"
              data-stm-field="import-space-backup-file"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importSpaceBackup(file);
                event.target.value = "";
              }}
            />
            <div className="stm-setting-hint">
              仅备份/恢复当前对话的记忆空间；spaceId
              不匹配或当前对话无绑定时克隆新空间（原空间保留）
            </div>
          </div>
        )}
      </div>

      {/* 对话文件镜像 */}
      <div className="stm-setting-group stm-setting-group--collapsible" data-group="mirror">
        <button
          type="button"
          className="stm-setting-group-header"
          data-action="toggle-settings-group"
          data-group="mirror"
          aria-expanded={isSettingsGroupExpanded(expandedGroups, "mirror")}
          onClick={() => toggleGroup("mirror")}
        >
          <div className="stm-setting-group-header-main">
            <div className="stm-setting-group-title stm-setting-group-title--collapsible">
              对话文件镜像
            </div>
            <div className="stm-setting-group-summary">
              {mirrorSummary(props.settings, props.mirrorStatus)}
            </div>
          </div>
          <i
            className={`fa-solid ${isSettingsGroupExpanded(expandedGroups, "mirror") ? "fa-chevron-up" : "fa-chevron-down"}`}
            aria-hidden="true"
          />
        </button>
        {isSettingsGroupExpanded(expandedGroups, "mirror") && (
          <div className="stm-setting-group-body">
            <div className="stm-setting-row">
              <div className="stm-setting-label">
                <div className="stm-setting-name">随对话文件同步记忆镜像</div>
                <div className="stm-setting-hint">
                  记忆快照写入聊天文件随对话走；换设备或本地库被清时自动恢复
                </div>
              </div>
              <label className="stm-switch">
                <input
                  type="checkbox"
                  data-action="toggle-mirror"
                  checked={props.settings.mirror.enabled}
                  onChange={(event) => toggleMirror(event.target.checked)}
                />
                <span className="stm-switch-track" aria-hidden="true"></span>
              </label>
            </div>
            <div className="stm-setting-row">
              <div className="stm-setting-label">
                <div className="stm-setting-name">镜像包含修订历史</div>
                <div className="stm-setting-hint">关闭后镜像不含修订记录，体积更小</div>
              </div>
              <label className="stm-switch">
                <input
                  type="checkbox"
                  data-action="toggle-mirror-history"
                  checked={props.settings.mirror.includeHistory}
                  onChange={(event) => toggleMirrorHistory(event.target.checked)}
                />
                <span className="stm-switch-track" aria-hidden="true"></span>
              </label>
            </div>
            <div className="stm-setting-row">
              <div className="stm-setting-name">镜像状态</div>
              <div className="stm-setting-value" data-stm-field="mirror-status">
                {mirrorStatusSummary(props.mirrorStatus)}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 版本与运行状态 */}
      <div className="stm-setting-group stm-setting-group--collapsible" data-group="version">
        <button
          type="button"
          className="stm-setting-group-header"
          data-action="toggle-settings-group"
          data-group="version"
          aria-expanded={isSettingsGroupExpanded(expandedGroups, "version")}
          onClick={() => toggleGroup("version")}
        >
          <div className="stm-setting-group-header-main">
            <div className="stm-setting-group-title stm-setting-group-title--collapsible">
              版本与运行状态
            </div>
            <div className="stm-setting-group-summary">{`v${props.version} · ${runtimeStatusLabel(props.status)}`}</div>
          </div>
          <i
            className={`fa-solid ${isSettingsGroupExpanded(expandedGroups, "version") ? "fa-chevron-up" : "fa-chevron-down"}`}
            aria-hidden="true"
          />
        </button>
        {isSettingsGroupExpanded(expandedGroups, "version") && (
          <div className="stm-setting-group-body">
            <div className="stm-setting-row">
              <div className="stm-setting-name">版本</div>
              <div className="stm-setting-value stm-mono">{`v${props.version}`}</div>
            </div>
            <div className="stm-setting-row">
              <div className="stm-setting-name">运行状态</div>
              <div className="stm-setting-value">{runtimeStatusLabel(props.status)}</div>
            </div>
          </div>
        )}
      </div>

      {/* 面板入口：呼出/收起记忆面板的按钮所在表面（全局设置，切换即时生效） */}
      <div className="stm-setting-group stm-setting-group--collapsible" data-group="entry">
        <button
          type="button"
          className="stm-setting-group-header"
          data-action="toggle-settings-group"
          data-group="entry"
          aria-expanded={isSettingsGroupExpanded(expandedGroups, "entry")}
          onClick={() => toggleGroup("entry")}
        >
          <div className="stm-setting-group-header-main">
            <div className="stm-setting-group-title stm-setting-group-title--collapsible">
              面板入口
            </div>
            <div className="stm-setting-group-summary">
              {entryGroupSummary(props.settings.entryPlacement, entryPlan)}
            </div>
          </div>
          <i
            className={`fa-solid ${isSettingsGroupExpanded(expandedGroups, "entry") ? "fa-chevron-up" : "fa-chevron-down"}`}
            aria-hidden="true"
          />
        </button>
        {isSettingsGroupExpanded(expandedGroups, "entry") && (
          <div className="stm-setting-group-body">
            <div className="stm-setting-row">
              {ENTRY_PLACEMENT_OPTIONS.map((placement) => (
                <button
                  key={placement}
                  type="button"
                  className={`stm-entry-option ${props.settings.entryPlacement === placement ? "stm-entry-option--active" : ""}`}
                  data-action="set-entry-placement"
                  data-placement={placement}
                  aria-pressed={props.settings.entryPlacement === placement}
                  onClick={() => updateEntryPlacement(placement)}
                >
                  {ENTRY_PLACEMENT_LABELS[placement]}
                </button>
              ))}
            </div>
            {actualPlacementNote(entryPlan) && (
              <div className="stm-setting-hint">{actualPlacementNote(entryPlan)}</div>
            )}
            <div className="stm-setting-hint">
              选魔法棒或两者时，底部魔法棒菜单会出现「记忆面板」入口；切换即时生效。
            </div>
          </div>
        )}
      </div>

      {/* 面板安全区：本机显示偏好（localStorage），仅移动断点消费 */}
      <div className="stm-setting-group stm-setting-group--collapsible" data-group="safe-area">
        <button
          type="button"
          className="stm-setting-group-header"
          data-action="toggle-settings-group"
          data-group="safe-area"
          aria-expanded={isSettingsGroupExpanded(expandedGroups, "safe-area")}
          onClick={() => toggleGroup("safe-area")}
        >
          <div className="stm-setting-group-header-main">
            <div className="stm-setting-group-title stm-setting-group-title--collapsible">
              面板安全区
            </div>
            <div className="stm-setting-group-summary">{safeAreaSummary(safeArea)}</div>
          </div>
          <i
            className={`fa-solid ${isSettingsGroupExpanded(expandedGroups, "safe-area") ? "fa-chevron-up" : "fa-chevron-down"}`}
            aria-hidden="true"
          />
        </button>
        {isSettingsGroupExpanded(expandedGroups, "safe-area") && (
          <div className="stm-setting-group-body">
            <div className="stm-safe-area-grid">
              {SAFE_AREA_EDGES.map((edge) => (
                <label key={edge} className="stm-safe-area-cell">
                  <span className="stm-setting-name">{SAFE_AREA_EDGE_LABELS[edge]}</span>
                  <input
                    className="stm-input"
                    type="number"
                    min="0"
                    max="120"
                    step="1"
                    data-stm-field={`safe-area-${edge}`}
                    value={safeArea[edge]}
                    onChange={(event) => updateSafeAreaEdge(edge, event.target.value)}
                  />
                </label>
              ))}
            </div>
            <div className="stm-setting-row">
              {SAFE_AREA_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="stm-button"
                  data-action="apply-safe-area-preset"
                  data-preset={preset.id}
                  onClick={() => setSafeArea({ ...preset.values })}
                >
                  {preset.label}
                </button>
              ))}
              <button
                type="button"
                className="stm-button"
                data-action="clear-safe-area"
                onClick={() => setSafeArea({ ...DEFAULT_SAFE_AREA })}
              >
                清空
              </button>
            </div>
            <div className="stm-setting-hint">
              TauriTavern 等宿主不向页面报告系统安全区时，全屏抽屉会顶进灵动岛/手势条区域；
              按设备实际遮挡调整四边留空（仅移动端生效，桌面浮动窗口不受影响）。
            </div>
          </div>
        )}
      </div>

      {/* 危险操作：钉底 */}
      <div className="stm-setting-group stm-setting-group--collapsible" data-group="danger">
        <button
          type="button"
          className="stm-setting-group-header"
          data-action="toggle-settings-group"
          data-group="danger"
          aria-expanded={isSettingsGroupExpanded(expandedGroups, "danger")}
          onClick={() => toggleGroup("danger")}
        >
          <div className="stm-setting-group-header-main">
            <div className="stm-setting-group-title stm-setting-group-title--collapsible">
              危险操作
            </div>
            <div className="stm-setting-group-summary">操作不可恢复</div>
          </div>
          <i
            className={`fa-solid ${isSettingsGroupExpanded(expandedGroups, "danger") ? "fa-chevron-up" : "fa-chevron-down"}`}
            aria-hidden="true"
          />
        </button>
        {isSettingsGroupExpanded(expandedGroups, "danger") && (
          <div className="stm-setting-group-body">
            <div className="stm-setting-hint">
              以下操作会清空当前对话记忆空间的内容，且对话文件镜像中的副本也会随之清空，操作不可恢复；按预设重建请使用上方「表格预设」分组。
            </div>
            <div className="stm-setting-actions">
              <button
                type="button"
                className="stm-button stm-button--danger"
                data-action="clear-space-records"
                disabled={!canMaintainSpace}
                onClick={() => void clearSpaceRecords()}
              >
                清除空间记录
              </button>
            </div>
            <div className="stm-setting-hint">
              清除记录保留当前表结构与初始化来源，不套用预设；表格结构重建走「表格预设」的应用流程。
            </div>
          </div>
        )}
      </div>
    </>
  );
}
