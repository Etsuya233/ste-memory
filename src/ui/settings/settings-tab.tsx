import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
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
import { AppearanceSettings } from "../shell/appearance-settings.tsx";
import { PageChrome } from "../shell/page-layout.tsx";
import { PanelBar, PanelBarAction } from "../shell/panel-bar.tsx";
import { Tabs } from "../shell/tabs.tsx";
import { EmbeddingConnectionEditor } from "./embedding-connection-editor.tsx";
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
  loadExpandedGroups,
  saveExpandedGroups,
  macroSummary,
  mirrorSummary,
  tablePresetsSummary,
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
import { MacroSettingsPage, MacroSettingsSummary } from "./macro-settings-page.tsx";
import { macroBudgetInfo, macroNameStatus } from "./macro-ui-model.ts";
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

/** 记忆宏组内作用域分区：全局宏 / 对话宏 / 内置宏（只读）；宏设置独立子页。 */
type MacroScopeTab = "global" | "chat" | "builtin";

const MACRO_SCOPE_TABS: readonly { readonly key: MacroScopeTab; readonly label: string }[] = [
  { key: "global", label: "全局宏" },
  { key: "chat", label: "对话宏" },
  { key: "builtin", label: "内置宏" },
];

export function SettingsTab(props: {
  readonly registerLeaveGuard?: (guard: (() => boolean) | null) => void;
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
  // 「记忆宏」组内作用域分区（全局/对话/内置）；默认全局
  const [macroScopeTab, setMacroScopeTab] = useState<MacroScopeTab>("global");
  // 宏设置独立子页（宏名/输出上限/预算/说明）
  const [macroSettingsOpen, setMacroSettingsOpen] = useState(false);
  const [dataOperation, setDataOperation] = useState<string | null>(null);
  async function runDataOperation(name: string, operation: () => Promise<void>) {
    setDataOperation(name);
    try {
      await operation();
    } finally {
      setDataOperation(null);
    }
  }
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
      active.space.prompt,
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

  function updateMacroLimit(value: number): void {
    if (!Number.isInteger(value) || value < 0) return;
    void changeSettings(() => props.settingsService.setMacroLimit(value));
  }

  /** 宏预览读取口（内置/全局/对话宏行共用）：完整宏名 → 预计算快照文本（未知 = 空串） */
  function readMacroPreview(name: string): string {
    return props.macroOverview().find((row) => row.name === name)?.text ?? "";
  }

  const [activeGroup, setActiveGroup] = useState<
    SettingsGroupKey | "embedding-connection" | "appearance" | null
  >(() => [...loadExpandedGroups(safeLocalStorage())][0] ?? null);
  const navigationRef = useRef<HTMLDivElement>(null);
  const categoryScroll = useRef(0);
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      navigationRef.current
        ?.closest(".stm-page-content")
        ?.scrollTo({ top: activeGroup === null ? categoryScroll.current : 0 });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeGroup]);
  const presetLeaveGuard = useRef<(() => boolean) | null>(null);
  const [editorOwnsHeader, setEditorOwnsHeader] = useState(false);
  const [macroCreateAction, setMacroCreateAction] = useState<{
    label: string;
    dataAction: string;
    disabled: boolean;
    onClick: () => void;
  } | null>(null);
  const registerPresetLeaveGuard = useCallback(
    (guard: (() => boolean) | null) => {
      presetLeaveGuard.current = guard;
      props.registerLeaveGuard?.(guard);
    },
    [props.registerLeaveGuard],
  );

  function toggleGroup(key: SettingsGroupKey | "embedding-connection" | "appearance" | null): void {
    if (key === activeGroup) return;
    if (presetLeaveGuard.current && !presetLeaveGuard.current()) return;
    if (activeGroup === null)
      categoryScroll.current = navigationRef.current!.closest(".stm-page-content")!.scrollTop;
    setActiveGroup(key);
    setMacroSettingsOpen(false);
    setMacroCreateAction(null);
    saveExpandedGroups(
      safeLocalStorage(),
      new Set(key && key !== "embedding-connection" && key !== "appearance" ? [key] : []),
    );
  }

  function changeMacroScopeTab(tab: MacroScopeTab): void {
    if (tab === macroScopeTab) return;
    setMacroCreateAction(null);
    setMacroScopeTab(tab);
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

  const categories = [
    {
      label: "记忆与提示词",
      items: [
        {
          key: "macro",
          title: "记忆宏",
          summary: macroSummary(props.settings, chatScopeMacros.length),
        },
        { key: "table-presets", title: "表格预设", summary: tablePresetsSummary(props.settings) },
        {
          key: "agent-presets",
          title: "Agent 提示词预设",
          summary: agentPresetsSummary(props.settings),
        },
        {
          key: "cleaning",
          title: "清洗规则",
          summary: cleaningSummary(props.settings, chatCleaningListId),
        },
      ],
    },
    {
      label: "模型连接",
      items: [
        {
          key: "agent-connections",
          title: "Agent 连接",
          summary: agentConnectionsSummary(props.settings),
        },
        {
          key: "embedding-connection",
          title: "向量连接",
          summary: props.settings.embeddingConnection?.model ?? "配置索引与检索服务",
        },
      ],
    },
    {
      label: "界面",
      items: [
        { key: "appearance", title: "外观", summary: "样式、主题与阅读体验" },
        {
          key: "entry",
          title: "面板入口",
          summary: entryGroupSummary(props.settings.entryPlacement, entryPlan),
        },
        { key: "safe-area", title: "面板安全区", summary: safeAreaSummary(safeArea) },
      ],
    },
    {
      label: "数据与运行",
      items: [
        { key: "backup", title: "数据备份", summary: "导出与导入记忆数据" },
        {
          key: "mirror",
          title: "对话文件镜像",
          summary: mirrorSummary(props.settings, props.mirrorStatus),
        },
        {
          key: "version",
          title: "版本与运行状态",
          summary: `v${props.version} · ${runtimeStatusLabel(props.status)}`,
        },
        { key: "danger", title: "危险操作", summary: "清除当前空间记录" },
      ],
    },
  ] as const;
  const groupTitle = categories
    .map((category) => category.items.find((item) => item.key === activeGroup))
    .find((item) => item !== undefined)?.title;
  // 记忆宏：合法注册名 + 预计算快照预算（只在宏页读取，避免其他设置页构建行）
  const macroStatus = macroNameStatus(props.settings.macroName);
  const macroPrefix = macroStatus.kind === "valid" ? macroStatus.registrationName : "";
  const macroBudget =
    activeGroup === "macro"
      ? macroBudgetInfo(props.macroOverview(), props.settings.macroName)
      : undefined;
  const macroSpaceId = props.status?.kind === "active" ? props.status.space.id : undefined;
  const macroHasActiveSpace = macroSpaceId !== undefined;

  return (
    <div
      ref={navigationRef}
      className="stm-settings-navigation"
      data-settings-page={activeGroup ?? "categories"}
    >
      {activeGroup &&
      activeGroup !== "embedding-connection" &&
      !editorOwnsHeader &&
      !macroSettingsOpen ? (
        <PageChrome
          header={
            <PanelBar
              title={groupTitle}
              trailing={
                activeGroup === "macro" && macroCreateAction ? (
                  <PanelBarAction
                    icon="fa-plus"
                    label={macroCreateAction.label}
                    data-action={macroCreateAction.dataAction}
                    disabled={macroCreateAction.disabled}
                    onClick={macroCreateAction.onClick}
                  />
                ) : undefined
              }
              leading={
                <PanelBarAction
                  icon="fa-arrow-left"
                  label="返回设置"
                  data-action="settings-back"
                  onClick={() => toggleGroup(null)}
                />
              }
            />
          }
        />
      ) : null}
      {/* 插件总开关：钉顶且默认展开（不参与折叠） */}
      <div className="stm-setting-group" data-group="plugin-toggle" hidden={activeGroup !== null}>
        <div className="stm-setting-row">
          <div className="stm-setting-label">
            <div className="stm-setting-name">插件总开关</div>
            <div className="stm-setting-hint">关闭后暂停绑定与同步</div>
          </div>
          <label className="stm-switch" data-bar-unframed>
            <input
              type="checkbox"
              data-action="toggle-plugin"
              aria-label="插件总开关"
              checked={props.settings.enabled}
              onChange={(event) => togglePlugin(event.target.checked)}
            />
            <span className="stm-switch-track" aria-hidden="true"></span>
          </label>
        </div>
      </div>
      {activeGroup === null &&
        categories.map((category) => (
          <section
            className="stm-settings-category"
            key={category.label}
            aria-label={category.label}
          >
            <div className="stm-section-label">{category.label}</div>
            <div className="stm-grouped-list">
              {category.items.map((item) => (
                <button
                  type="button"
                  className="stm-settings-category-row"
                  key={item.key}
                  data-action="toggle-settings-group"
                  data-group={item.key}
                  aria-expanded={false}
                  onClick={() => toggleGroup(item.key)}
                >
                  <span className="stm-setting-group-header-main">
                    <span className="stm-setting-name">{item.title}</span>
                    <span className="stm-setting-group-summary">{item.summary}</span>
                  </span>
                  <i className="fa-solid fa-chevron-right" aria-hidden="true" />
                </button>
              ))}
            </div>
          </section>
        ))}
      <div
        className="stm-setting-group"
        data-group="appearance"
        hidden={activeGroup !== "appearance"}
      >
        {activeGroup === "appearance" && (
          <div className="stm-setting-group-body">
            <AppearanceSettings />
          </div>
        )}
      </div>

      <div
        className="stm-setting-group"
        data-group="embedding-connection"
        hidden={activeGroup !== "embedding-connection"}
      >
        {activeGroup === "embedding-connection" && (
          <div className="stm-setting-group-body">
            <EmbeddingConnectionEditor
              onClose={() => toggleGroup(null)}
              registerLeaveGuard={registerPresetLeaveGuard}
              connection={props.settings.embeddingConnection}
              onSave={async (connection) => {
                try {
                  await props.settingsService.setEmbeddingConnection(connection);
                } finally {
                  props.onSettingsChange(props.settingsService.read());
                }
              }}
            />
          </div>
        )}
      </div>

      {/* 记忆宏：常用首位 */}
      <div
        className="stm-setting-group stm-setting-group--collapsible"
        data-group="macro"
        hidden={activeGroup !== "macro"}
      >
        {activeGroup === "macro" && (
          <div className="stm-setting-group-body stm-macro-page">
            {macroSettingsOpen ? (
              <MacroSettingsPage
                macroName={props.settings.macroName}
                macroLimit={props.settings.macroLimit}
                hasActiveSpace={macroHasActiveSpace}
                budget={macroBudget}
                onNameChange={updateMacroName}
                onLimitChange={updateMacroLimit}
                onBack={() => setMacroSettingsOpen(false)}
              />
            ) : (
              <>
                {/* 宏设置摘要条：宏前缀 + 默认快照体积/截断；进入独立设置页 */}
                {!editorOwnsHeader && (
                  <MacroSettingsSummary
                    macroName={props.settings.macroName}
                    macroLimit={props.settings.macroLimit}
                    hasActiveSpace={macroHasActiveSpace}
                    budget={macroBudget}
                    onOpen={() => setMacroSettingsOpen(true)}
                  />
                )}
                {/* 作用域分区：全局宏 / 对话宏 / 内置宏（只读） */}
                {!editorOwnsHeader && (
                  <Tabs
                    label="记忆宏作用域"
                    value={macroScopeTab}
                    options={MACRO_SCOPE_TABS.map((tab) => ({
                      value: tab.key,
                      label: tab.label,
                      panelId: `stm-macro-${tab.key}`,
                      dataAction: "macro-scope",
                      dataAttributes: { "data-macro-scope": tab.key },
                    }))}
                    onChange={changeMacroScopeTab}
                  />
                )}
                <div id={`stm-macro-${macroScopeTab}`} role="tabpanel">
                  {/* 内置宏：默认快照 / 完整数据 / Agent 预设宏（只读，带输出体积） */}
                  {macroScopeTab === "builtin" && (
                    <BuiltinMacrosList
                      prefix={macroPrefix}
                      spaceId={macroSpaceId}
                      readTables={(spaceId) => props.tables.list(spaceId as MemorySpaceId)}
                      readPreview={readMacroPreview}
                    />
                  )}

                  {/* 全局宏：列表 CRUD（宏名/上限在独立宏设置页） */}
                  {macroScopeTab === "global" && (
                    <MemoryViewsManager
                      onCreateActionChange={setMacroCreateAction}
                      onEditingChange={setEditorOwnsHeader}
                      registerLeaveGuard={registerPresetLeaveGuard}
                      prefix={macroPrefix}
                      spaceId={macroSpaceId}
                      readTables={(spaceId) => props.tables.list(spaceId as MemorySpaceId)}
                      readFields={(spaceId, tableId) =>
                        props.fields.list(spaceId as MemorySpaceId, tableId as MemoryTableId)
                      }
                      readPreview={readMacroPreview}
                      chatMacroNames={chatScopeMacros.map((macro) => macro.name)}
                      views={props.settings.memoryViews}
                      onChange={(views) => {
                        void changeSettings(() => props.settingsService.setMemoryViews(views));
                      }}
                    />
                  )}

                  {/* 对话宏：随对话文件走，同名优先于全局/内置宏 */}
                  {macroScopeTab === "chat" && (
                    <ChatScopeMacrosManager
                      chatIdentity={
                        props.status?.kind === "active" && props.status.binding.version === 2
                          ? props.status.binding.chatIdentity
                          : undefined
                      }
                      onCreateActionChange={setMacroCreateAction}
                      onEditingChange={setEditorOwnsHeader}
                      registerLeaveGuard={registerPresetLeaveGuard}
                      prefix={macroPrefix}
                      spaceId={macroSpaceId}
                      readTables={(spaceId) => props.tables.list(spaceId as MemorySpaceId)}
                      readFields={(spaceId, tableId) =>
                        props.fields.list(spaceId as MemorySpaceId, tableId as MemoryTableId)
                      }
                      readPreview={readMacroPreview}
                      globalMacroNames={props.settings.memoryViews.map((view) => view.name)}
                      macros={chatScopeMacros}
                      onChange={(macros) => {
                        void changeSettings(() => props.settingsService.setChatScopeMacros(macros));
                        setChatScopeMacros(macros);
                      }}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* 表格预设：新空间默认 / 当前空间应用 / 预设管理（spec table-presets） */}
      <div
        className="stm-setting-group stm-setting-group--collapsible"
        data-group="table-presets"
        hidden={activeGroup !== "table-presets"}
      >
        {activeGroup === "table-presets" && (
          <div className="stm-setting-group-body stm-setting-group-body--manager">
            <TablePresetManager
              onBack={() => toggleGroup(null)}
              onEditingChange={setEditorOwnsHeader}
              registerLeaveGuard={registerPresetLeaveGuard}
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
        hidden={activeGroup !== "agent-connections"}
      >
        {activeGroup === "agent-connections" && (
          <div className="stm-setting-group-body stm-setting-group-body--manager">
            <AgentConnectionManager
              onBack={() => toggleGroup(null)}
              onEditingChange={setEditorOwnsHeader}
              registerLeaveGuard={registerPresetLeaveGuard}
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
      <div
        className="stm-setting-group stm-setting-group--collapsible"
        data-group="agent-presets"
        hidden={activeGroup !== "agent-presets"}
      >
        {activeGroup === "agent-presets" && (
          <div className="stm-setting-group-body stm-setting-group-body--manager">
            <AgentPresetManager
              registerLeaveGuard={registerPresetLeaveGuard}
              onBack={() => toggleGroup(null)}
              onEditingChange={setEditorOwnsHeader}
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
      <div
        className="stm-setting-group stm-setting-group--collapsible"
        data-group="cleaning"
        hidden={activeGroup !== "cleaning"}
      >
        {activeGroup === "cleaning" && (
          <div className="stm-setting-group-body stm-setting-group-body--manager">
            <CleaningRulesManager
              onBack={() => toggleGroup(null)}
              onEditingChange={setEditorOwnsHeader}
              registerLeaveGuard={registerPresetLeaveGuard}
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
      <div
        className="stm-setting-group stm-setting-group--collapsible"
        data-group="backup"
        hidden={activeGroup !== "backup"}
      >
        {activeGroup === "backup" && (
          <div className="stm-setting-group-body">
            {dataOperation && (
              <div className="stm-setting-hint" role="status">
                {dataOperation.startsWith("import") ? "正在导入…" : "正在导出…"}
              </div>
            )}
            <div className="stm-section-label">全部记忆空间</div>
            <div className="stm-setting-actions">
              <button
                type="button"
                className="stm-button"
                data-action="export-backup"
                disabled={dataOperation !== null}
                onClick={() => void runDataOperation("export-backup", exportBackup)}
              >
                导出备份
              </button>
              <button
                type="button"
                className="stm-button"
                data-action="import-backup"
                disabled={dataOperation !== null}
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
                if (file) void runDataOperation("import-backup", () => importBackup(file));
                event.target.value = "";
              }}
            />
            <div className="stm-setting-hint">导入将整体替换当前数据</div>
            <div className="stm-setting-divider" />
            <div className="stm-section-label">当前对话空间</div>
            <div className="stm-setting-actions">
              <button
                type="button"
                className="stm-button"
                data-action="export-space-backup"
                disabled={!canExportSpace || dataOperation !== null}
                title={canExportSpace ? undefined : "当前对话未绑定记忆空间"}
                onClick={() => void runDataOperation("export-space-backup", exportSpaceBackup)}
              >
                导出当前空间
              </button>
              <button
                type="button"
                className="stm-button"
                data-action="import-space-backup"
                disabled={dataOperation !== null}
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
                if (file)
                  void runDataOperation("import-space-backup", () => importSpaceBackup(file));
                event.target.value = "";
              }}
            />
            <div className="stm-setting-hint">空间不匹配时创建副本，保留原空间</div>
          </div>
        )}
      </div>

      {/* 对话文件镜像 */}
      <div
        className="stm-setting-group stm-setting-group--collapsible"
        data-group="mirror"
        hidden={activeGroup !== "mirror"}
      >
        {activeGroup === "mirror" && (
          <div className="stm-setting-group-body">
            <div className="stm-setting-row">
              <div className="stm-setting-label">
                <div className="stm-setting-name">随对话文件同步记忆镜像</div>
                <div className="stm-setting-hint">换设备或清除本地数据后可从对话恢复</div>
              </div>
              <label className="stm-switch" data-bar-unframed>
                <input
                  type="checkbox"
                  data-action="toggle-mirror"
                  aria-label="随对话文件同步记忆镜像"
                  checked={props.settings.mirror.enabled}
                  onChange={(event) => toggleMirror(event.target.checked)}
                />
                <span className="stm-switch-track" aria-hidden="true"></span>
              </label>
            </div>
            <div className="stm-setting-row">
              <div className="stm-setting-label">
                <div className="stm-setting-name">镜像包含修订历史</div>
              </div>
              <label className="stm-switch" data-bar-unframed>
                <input
                  type="checkbox"
                  data-action="toggle-mirror-history"
                  aria-label="镜像包含修订历史"
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
      <div
        className="stm-setting-group stm-setting-group--collapsible"
        data-group="version"
        hidden={activeGroup !== "version"}
      >
        {activeGroup === "version" && (
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
      <div
        className="stm-setting-group stm-setting-group--collapsible"
        data-group="entry"
        hidden={activeGroup !== "entry"}
      >
        {activeGroup === "entry" && (
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
          </div>
        )}
      </div>

      {/* 面板安全区：本机显示偏好（localStorage），仅移动断点消费 */}
      <div
        className="stm-setting-group stm-setting-group--collapsible"
        data-group="safe-area"
        hidden={activeGroup !== "safe-area"}
      >
        {activeGroup === "safe-area" && (
          <div className="stm-setting-group-body">
            <div className="stm-safe-area-grid">
              <div className="stm-safe-area-preview" aria-hidden="true">
                <i className="fa-solid fa-mobile-screen" />
                <span>面板</span>
              </div>
              {SAFE_AREA_EDGES.map((edge) => (
                <label key={edge} className="stm-safe-area-cell" data-edge={edge}>
                  <span className="stm-setting-name">
                    {SAFE_AREA_EDGE_LABELS[edge]} <span className="stm-setting-unit">px</span>
                  </span>
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
                  aria-pressed={SAFE_AREA_EDGES.every(
                    (edge) => safeArea[edge] === preset.values[edge],
                  )}
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
            <div className="stm-setting-hint">单位 px，仅移动端生效</div>
          </div>
        )}
      </div>

      {/* 危险操作：钉底 */}
      <div
        className="stm-setting-group stm-setting-group--collapsible"
        data-group="danger"
        hidden={activeGroup !== "danger"}
      >
        {activeGroup === "danger" && (
          <div className="stm-setting-group-body">
            <div className="stm-setting-hint">
              将删除当前空间的全部记录、修订历史与证据，并同步清空对话文件镜像。操作不可恢复。
            </div>
            <div className="stm-setting-actions">
              <button
                type="button"
                className="stm-button stm-button--danger"
                data-action="clear-space-records"
                disabled={!canMaintainSpace || dataOperation !== null}
                onClick={() => void runDataOperation("clear-space-records", clearSpaceRecords)}
              >
                {dataOperation === "clear-space-records" ? "正在清除…" : "清除空间记录"}
              </button>
            </div>
            <div className="stm-setting-hint">保留表格结构与初始化来源。</div>
          </div>
        )}
      </div>
    </div>
  );
}
