import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createBackupFile, serializeBackupFile } from "../../features/backup/index.ts";
import {
  backupFilename,
  buildSpaceExportUnit,
  executeFullBackupImport,
  planFullBackupImport,
  spaceExportFilename,
} from "../../features/backup/space-transfer.ts";
import { downloadTextFile } from "../../infrastructure/browser/download.ts";
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
import { activeStatus, reportError, reportInfo, reportSuccess } from "../shell/ui-helpers.tsx";
import { safeLocalStorage } from "../shell/panel-window.ts";
import { mirrorStatusSummary, runtimeStatusLabel } from "../shell/space-info.ts";
import { AgentPresetManager } from "./agent-preset-manager.tsx";
import { AgentConnectionManager } from "./agent-connection-manager.tsx";
import { CleaningRulesManager } from "./cleaning-rules-manager.tsx";
import { MemoryViewsManager } from "./memory-views-manager.tsx";
import { ChatScopeMacrosManager } from "./chat-scope-macros-manager.tsx";
import { BuiltinMacrosList } from "./builtin-macros-list.tsx";
import type { PanelRuntime } from "../shell/panel-shell.tsx";

// ---- 设置 Tab ----

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
  readonly runtime: PanelRuntime;
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
    props.runtime.cleaning.readSelection(),
  );
  useEffect(() => {
    setChatCleaningListId(props.runtime.cleaning.readSelection());
  }, [props.status, props.runtime]);
  // 当前对话的聊天 Scope 宏（双 Scope 宏系统）：本地态 = chatMetadata 的镜像，
  // 变更即写 chatMetadata（防抖持久化）+ macro.kick()；对话切换（status 变化）后重新读取。
  const [chatScopeMacros, setChatScopeMacros] = useState<readonly MemoryView[]>(() =>
    props.runtime.cleaning.readChatScopeMacros(),
  );
  useEffect(() => {
    setChatScopeMacros(props.runtime.cleaning.readChatScopeMacros());
  }, [props.status, props.runtime]);
  // 「记忆宏」组内作用域分区（内置/全局/对话级）；默认全局（原有行为）
  const [macroScopeTab, setMacroScopeTab] = useState<MacroScopeTab>("global");
  // 导入文件输入（按钮触发隐藏 input；重置 value 允许重复选择同一文件）
  const importInputRef = useRef<HTMLInputElement>(null);
  // 单空间导入文件输入
  const importSpaceInputRef = useRef<HTMLInputElement>(null);

  function togglePlugin(enabled: boolean): void {
    const next = { ...props.settings, enabled };
    props.runtime.settings.write(next);
    props.onSettingsChange(next);
    if (enabled) {
      // 重新启用立即恢复空间同步（关闭期间 CHAT_CHANGED 被门控跳过）
      void props.runtime.manager.syncToCurrentChat().catch(reportError);
      // 记忆宏/Agent 预设宏同样重新评估：停用期间已注销 + 停止轮询，不 kick 则宏不恢复注册
      void props.runtime.macro.kick().catch(reportError);
      void props.runtime.agentMacro.kick().catch(reportError);
    } else {
      // 停用立即注销两个宏服务（轮询也会收敛，但注销要即时生效）
      void props.runtime.agentMacro.kick().catch(reportError);
    }
  }

  /** 镜像开关切换：写设置 + kick（开关即时生效） */
  function toggleMirror(enabled: boolean): void {
    const next = { ...props.settings, mirror: { ...props.settings.mirror, enabled } };
    props.runtime.settings.write(next);
    props.onSettingsChange(next);
    void props.runtime.mirror.kick().catch(reportError);
  }

  /** 镜像包含修订历史开关切换：写设置 + kick（后续写回按新内容裁剪） */
  function toggleMirrorHistory(includeHistory: boolean): void {
    const next = { ...props.settings, mirror: { ...props.settings.mirror, includeHistory } };
    props.runtime.settings.write(next);
    props.onSettingsChange(next);
    void props.runtime.mirror.kick().catch(reportError);
  }

  async function exportBackup(): Promise<void> {
    try {
      const snapshot = await props.runtime.backup.loadSnapshot();
      const file = createBackupFile(snapshot, props.runtime.version, new Date().toISOString());
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
        backup: props.runtime.backup,
        syncToCurrentChat: () => props.runtime.manager.syncToCurrentChat(),
        kickMacros: () => void props.runtime.macro.kick().catch(reportError),
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
    const spaceId = active.space.id;
    const spaceName = active.space.name;
    try {
      const snapshot = await props.runtime.backup.loadSnapshot();
      // 提取当前空间单单元 + 按「包含修订历史」设置裁剪历史（用户 story 5）
      const includeHistory = props.settings.mirror.includeHistory;
      const unit = buildSpaceExportUnit(snapshot, spaceId, includeHistory);
      if (!unit) {
        reportError(new Error("未找到当前记忆空间的数据，无法导出"));
        return;
      }
      const file = createBackupFile(
        { spaces: [unit] },
        props.runtime.version,
        new Date().toISOString(),
      );
      downloadTextFile(serializeBackupFile(file), spaceExportFilename(file.exportedAt));
      reportSuccess(`已导出记忆空间「${spaceName}」`);
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
    const plan = planSpaceImport(text, props.runtime.manager.getStatus());
    if (plan.kind === "error") {
      reportError(new Error(plan.message));
      return;
    }
    if (!window.confirm(plan.confirmMessage)) return;
    try {
      reportInfo("正在导入…");
      await executeSpaceImport(plan, {
        backup: props.runtime.backup,
        manager: props.runtime.manager,
        kickMacros: () => void props.runtime.macro.kick().catch(reportError),
        kickMirror: () => void props.runtime.mirror.kick().catch(reportError),
        onDataChanged: props.onDataChanged,
      });
      reportSuccess(`已导入记忆空间「${plan.spaceName}」`);
    } catch (error) {
      reportError(error);
    }
  }

  /**
   * 空间维护操作（spec reset-space）：清除空间记录 / 重置空间。
   * 仅当前对话绑定空间（active 状态）且插件开启时可执行；原生 confirm 确认，
   * 文案写明删除范围与「对话文件镜像副本也会被清空」。执行成功后刷新
   * 面板数据、重建记忆宏快照、kick 镜像写回、清空问答面板当前空间历史。
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
      await props.runtime.spaceMaintenance.clearRecords(space.id);
      reportSuccess(`已清除「${space.name}」的全部记录`);
      afterSpaceReset(space.id);
    } catch (error) {
      reportError(error);
    }
  }

  async function resetSpace(): Promise<void> {
    const status = props.status;
    if (status?.kind !== "active") return;
    const space = status.space;
    const confirmed = window.confirm(
      `重置「${space.name}」？将删除所有表格并恢复为系统默认的 8 张表（自定义表与修改过的表定义将被移除）；对话文件镜像中的副本也会被清空。`,
    );
    if (!confirmed) return;
    try {
      await props.runtime.spaceMaintenance.reset(space.id);
      reportSuccess(`已重置「${space.name}」`);
      afterSpaceReset(space.id);
    } catch (error) {
      reportError(error);
    }
  }

  /** 空间内容已变更（清除/重置成功）后的面板侧收尾。 */
  function afterSpaceReset(spaceId: MemorySpaceId): void {
    props.onDataChanged();
    // 记忆宏快照立即重建（不等轮询）；镜像按既有机制传播空单元
    void props.runtime.macro.kick().catch(reportError);
    void props.runtime.mirror.kick().catch(reportError);
    // 问答面板历史按（空间 × 模式）存页面内存：旧问答会误导，清空当前空间全部历史
    props.queryChatStore.clearSpaceHistory(spaceId);
  }

  /** 记忆宏名变化：写设置 + 立即重新注册/重建（宏名不合法时注销 = 无注入） */
  function updateMacroName(value: string): void {
    const next = { ...props.settings, macroName: value };
    props.runtime.settings.write(next);
    props.onSettingsChange(next);
    void props.runtime.macro.kick().catch(reportError);
  }

  /** 记忆宏上限变化：写设置 + 立即按新上限重建快照 */
  function updateMacroLimit(value: string): void {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return; // 非法输入不落库
    const next = { ...props.settings, macroLimit: parsed };
    props.runtime.settings.write(next);
    props.onSettingsChange(next);
    void props.runtime.macro.kick().catch(reportError);
  }

  /** 宏预览读取口（内置/全局/对话级行共用）：完整宏名 → 预计算快照文本（未知 = 空串） */
  function readMacroPreview(name: string): string {
    return props.runtime.macroOverview().find((row) => row.name === name)?.text ?? "";
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
    (listener) => props.runtime.entryMount?.onPlanChange(listener) ?? (() => {}),
    () => props.runtime.entryMount?.getPlan() ?? DEFAULT_ENTRY_PLAN,
    () => props.runtime.entryMount?.getPlan() ?? DEFAULT_ENTRY_PLAN,
  );
  /** 改入口位置：写设置 + 通知挂载控制器重解析（顶部/魔法棒/两者即时换挂载点） */
  function updateEntryPlacement(placement: EntryPlacement): void {
    if (props.settings.entryPlacement === placement) return;
    const next = { ...props.settings, entryPlacement: placement };
    props.runtime.settings.write(next);
    props.onSettingsChange(next);
    props.runtime.entryMount?.replan();
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
                readTables={(spaceId) => props.runtime.tables.list(spaceId as MemorySpaceId)}
                readPreview={readMacroPreview}
              />
            )}

            {/* 全局宏：视图 CRUD（前缀/上限设置在「宏设置」分区） */}
            {macroScopeTab === "global" && (
              <>
                <MemoryViewsManager
                  prefix={props.settings.macroName.replace(/[{}]/g, "")}
                  spaceId={props.status?.kind === "active" ? props.status.space.id : undefined}
                  readTables={(spaceId) => props.runtime.tables.list(spaceId as MemorySpaceId)}
                  readFields={(spaceId, tableId) =>
                    props.runtime.fields.list(spaceId as MemorySpaceId, tableId as MemoryTableId)
                  }
                  readPreview={readMacroPreview}
                  views={props.settings.memoryViews}
                  onChange={(views) => {
                    const next = { ...props.settings, memoryViews: views };
                    props.runtime.settings.write(next);
                    props.onSettingsChange(next);
                    void props.runtime.macro.kick().catch(reportError);
                  }}
                />
              </>
            )}

            {/* 对话级宏：聊天 Scope 宏 CRUD（随对话文件走） */}
            {macroScopeTab === "chat" && (
              <ChatScopeMacrosManager
                prefix={props.settings.macroName.replace(/[{}]/g, "")}
                spaceId={props.status?.kind === "active" ? props.status.space.id : undefined}
                readTables={(spaceId) => props.runtime.tables.list(spaceId as MemorySpaceId)}
                readFields={(spaceId, tableId) =>
                  props.runtime.fields.list(spaceId as MemorySpaceId, tableId as MemoryTableId)
                }
                readPreview={readMacroPreview}
                macros={chatScopeMacros}
                onChange={(macros) => {
                  props.runtime.cleaning.writeChatScopeMacros?.(macros);
                  setChatScopeMacros(macros);
                  void props.runtime.macro.kick().catch(reportError);
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
                props.runtime.settings.write(next);
                props.onSettingsChange(next);
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
              presetPreview={props.runtime.presetPreview}
              onChange={(next) => {
                props.runtime.settings.write(next);
                props.onSettingsChange(next);
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
                props.runtime.cleaning.writeSelection(listId);
                setChatCleaningListId(listId);
              }}
              onChange={(next) => {
                props.runtime.settings.write(next);
                props.onSettingsChange(next);
              }}
              readStRegexEntries={props.runtime.cleaning.readStRegexEntries}
              readRecentMessages={props.runtime.cleaning.readRecentMessages}
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
            <div className="stm-setting-group-summary">{`v${props.runtime.version} · ${runtimeStatusLabel(props.status)}`}</div>
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
              <div className="stm-setting-value stm-mono">{`v${props.runtime.version}`}</div>
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
              以下操作会清空当前对话记忆空间的内容，且对话文件镜像中的副本也会随之清空，操作不可恢复
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
              <button
                type="button"
                className="stm-button stm-button--danger"
                data-action="reset-space"
                disabled={!canMaintainSpace}
                onClick={() => void resetSpace()}
              >
                重置空间
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
