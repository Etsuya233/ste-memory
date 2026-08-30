/**
 * 面板 React 组件层（ADR 0005：UI 渲染层采用 React，随 esbuild 打进单文件 bundle）。
 *
 * 纯逻辑 seam 不变：状态机/视图模型/文案仍在 panel-model / table-list-model /
 * space-info（有测试兜底），组件只做「状态 → DOM」投影与事件接线。ST DOM 不测的
 * 测试决策不变，组件层用 react-dom/server renderToString 冒烟（无 jsdom）。
 *
 * DOM 结构与类名是验收脚本（docs/playwright-st-extension/verify-ui-shell.mjs）的
 * 契约：改动必须同步改脚本。data-action / data-stm-field 属性保留（脚本按它们
 * 定位元素），行为全部走 React 事件。
 */
import type {
  MemoryField,
  MemoryFieldId,
  MemoryRecord,
  MemoryRecordPayload,
  MemorySpaceId,
  MemoryTable,
  MemoryTableDisplayStrategy,
  MemoryTableId,
} from "@ste-memory/core/memory";
import {
  createBackupFile,
  parseBackupFile,
  serializeBackupFile,
} from "@ste-memory/core/memory/export";
import type {
  MemoryBackupFile,
  MemoryBackupSnapshot,
  MemorySpaceBackup,
} from "@ste-memory/core/memory/export";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { PLUGIN_DISPLAY_NAME } from "../constants.ts";
import {
  DESKTOP_MEDIA_QUERY,
  clampGeometry,
  loadGeometry,
  safeLocalStorage,
  saveGeometry,
  type PanelGeometry,
  type ViewportSize,
} from "./panel-window.ts";
import type { CloudSyncStatus } from "../cloud/sync-coordinator.ts";
import type { ChatMirrorStatus } from "../chat-mirror/chat-metadata-mirror-sync.ts";
import type { SteMemoryRuntime } from "../runtime.ts";
import {
  isR2Configured,
  type PluginSettings,
  type R2Settings,
  type SettingsStore,
} from "../settings/plugin-settings.ts";
import {
  agentConnectionsSummary,
  agentPresetsSummary,
  cleaningSummary,
  isExpanded as isSettingsGroupExpanded,
  loadExpandedGroups,
  macroSummary,
  mirrorSummary,
  r2Summary,
  saveExpandedGroups,
  toggleGroup as toggleSettingsGroup,
  type SettingsGroupKey,
} from "./settings-collapsed-model.ts";
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
} from "./safe-area-model.ts";
import type { SpaceContextStatus } from "../space-binding/chat-space-manager.ts";
import { BINDING_UNRECOGNIZED_MESSAGE } from "../space-binding/chat-space-manager.ts";
import { resolveImportAction } from "../space-binding/import-action.ts";

import type { StRegexEntry } from "../st/st-chat-adapter.ts";
import type { FillTaskService } from "../fill-tasks/fill-task-service.ts";
import type { QueryChatService } from "../query-chat/query-chat-service.ts";
import type { SpaceMaintenanceService } from "../space-maintenance/space-maintenance-service.ts";
import { QueryChatStore } from "../query-chat/query-chat-state.ts";
import { PANEL_TAB_LABELS, PANEL_TABS, type PanelModel } from "./panel-model.ts";
import {
  activeStatus,
  Placeholder,
  reportError,
  reportInfo,
  reportSuccess,
  reportWarning,
} from "./ui-helpers.tsx";
import {
  buildSpaceInfo,
  formatSyncTime,
  mirrorStatusSummary,
  runtimeStatusLabel,
  syncStatusSummary,
} from "./space-info.ts";
import { buildTableListViewModel, type TableListItemViewModel } from "./table-list-model.ts";
import { FieldEditorForm, TableEditorForm } from "./table-editor.tsx";
import { EMPTY_TABLE_DRAFT, type TableDraft } from "./table-editor-model.ts";
import {
  displayStrategyDependentFieldIds,
  displayStrategySummary,
  emptyDisplayStrategyDraft,
} from "./display-strategy-model.ts";
import { DisplayStrategyEditor } from "./display-strategy-editor.tsx";
import { RecordsTab, type LeaveGuard } from "./record-view.tsx";
import { TasksTab } from "./tasks-tab.tsx";
import { QueryChatTab } from "./query-chat-tab.tsx";
import { LogTab } from "./log-tab.tsx";
import { AgentPresetManager } from "./agent-preset-manager.tsx";
import { AgentConnectionManager } from "./agent-connection-manager.tsx";
import { CleaningRulesManager } from "./cleaning-rules-manager.tsx";
import { MemoryViewsManager } from "./memory-views-manager.tsx";
import { ChatScopeMacrosManager } from "./chat-scope-macros-manager.tsx";
import { testAgentConnection } from "../llm/st-backends-status.ts";
import {
  emptyFieldDraft,
  fieldDraftFromField,
  fieldTypeNeedsOptions,
  parseOptionsText,
  swapAdjacentFieldPositions,
  type FieldDraft,
} from "./field-editor-model.ts";

/** ST 全局 toastr 声明见 ui-helpers.ts（ticket 11 抽取共享工具避免循环依赖）。 */

/**
 * 面板组件端口：组件只依赖运行时子集（测试注入 fake 用），完整 SteMemoryRuntime
 * 结构满足该端口，组合根直接传入。
 */
export interface PanelRuntime {
  readonly manager: Pick<
    SteMemoryRuntime["manager"],
    "getStatus" | "onStatusChange" | "syncToCurrentChat" | "resolveBranch" | "importSpace"
  >;
  readonly tables: Pick<SteMemoryRuntime["tables"], "list" | "update" | "create" | "delete">;
  readonly fields: Pick<
    SteMemoryRuntime["fields"],
    "list" | "update" | "create" | "delete" | "setDisplayStrategy"
  >;
  /** 记忆记录（ticket 10 显示策略预览；ticket 11 记录视图/CRUD） */
  readonly records: Pick<
    SteMemoryRuntime["records"],
    "list" | "previewDisplayText" | "create" | "update" | "delete" | "find" | "listHistory"
  >;
  /** ST 适配器子集（ticket 11 证据楼层 chip：跳转 + 原文摘录；ticket 13 任务触发需要消息数） */
  readonly st: Pick<
    SteMemoryRuntime["adapter"],
    "scrollToFloor" | "getMessageAt" | "chatMessageCount"
  >;
  /** 全库备份（导出读快照 / 导入整体还原，ticket 07）；restoreSpace 单空间替换、
   *  cloneSpaceFromUnit 从备份单元克隆新空间（均用于 issue 26 单空间导入） */
  readonly backup: Pick<
    SteMemoryRuntime["backup"],
    "loadSnapshot" | "restoreSnapshot" | "restoreSpace" | "cloneSpaceFromUnit"
  >;
  /** Dexie 备份仓库（扩展方法：cloneSpace 用于分支对话分离） */
  readonly backupRepo?: Pick<SteMemoryRuntime["backupRepo"], "cloneSpace">;
  /** ST 适配器（分支检测需要访问 getChatSnapshot 和 bindingStore） */
  readonly adapter?: Pick<SteMemoryRuntime["adapter"], "getChatSnapshot" | "bindingStore">;
  /** 云同步（ticket 08）：状态订阅 + 立即同步 + 设置变化重新评估 */
  readonly sync: Pick<
    SteMemoryRuntime["sync"],
    "getStatus" | "onStatusChange" | "syncNow" | "kick"
  >;
  /** 对话文件镜像（ticket 16）：状态订阅 + 设置变化重新评估 */
  readonly mirror: Pick<SteMemoryRuntime["mirror"], "getStatus" | "onStatusChange" | "kick">;
  /** 通用日志（ADR 0008）：日志 Tab 浏览/搜索/清空 */
  readonly logs: Pick<SteMemoryRuntime["logs"], "byKey" | "bySpace" | "recent" | "clearAll">;
  /** 记忆宏（ticket 15）：宏名/上限/开关变化即时生效（kick 立即评估） */
  readonly macro: Pick<SteMemoryRuntime["macro"], "kick">;
  /** Agent 预设宏（ticket 17）：插件开关变化即时生效（kick 立即评估） */
  readonly agentMacro: Pick<SteMemoryRuntime["agentMacro"], "kick">;
  /** 填表任务（ticket 13 触发/取消 + ticket 14 重试/历史/覆盖）：手动楼层范围触发 + 取消 + 重试 + 状态/进度/历史 */
  readonly tasks: Pick<
    FillTaskService,
    | "submit"
    | "submitInit"
    | "cancel"
    | "retry"
    | "activeTask"
    | "recentTasks"
    | "ledgerStatuses"
    | "markFloorStatuses"
  >;
  /** 空间维护（spec reset-space）：清除空间记录 / 重置空间（设置 Tab 危险操作区） */
  readonly spaceMaintenance: Pick<SpaceMaintenanceService, "clearRecords" | "reset">;
  /** 问答面板（ticket 20 / ADR 0009）：查询/填写双模式 run 编排（事件 → 状态增量） */
  readonly queryChat: Pick<QueryChatService, "run">;
  /** 清洗规则（ticket 22 / ADR 0011）：当前对话列表选择读写 + ST 正则条目 */
  readonly cleaning: {
    readonly readSelection: () => string | undefined;
    readonly writeSelection: (listId: string | undefined) => void;
    readonly readStRegexEntries: () => readonly StRegexEntry[];
    readonly readChatScopeMacros: () => readonly import("../settings/memory-views.ts").MemoryView[];
    readonly writeChatScopeMacros: (macros: readonly import("../settings/memory-views.ts").MemoryView[]) => void;
  };
  readonly settings: SettingsStore;
  readonly version: string;
  /** 弹窗 API（分支检测等需要用户交互的场景） */
  readonly popup?: {
    show(
      content: string,
      options?: {
        type?: number;
        okButton?: string;
        cancelButton?: string;
        wide?: boolean;
      },
    ): Promise<number | string | boolean | null | undefined>;
  };
}

/** 活动空间状态（表格列表只在该状态下渲染） */

// ---- 工具 ----

/** 下载文本文件（导出备份）：Blob + 临时 object URL，触发后即释放。 */
function downloadTextFile(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** 备份文件名：ste-memory-backup-<导出日期>.json（日期取信封 exportedAt）。 */
function backupFilename(exportedAt: string): string {
  return `ste-memory-backup-${exportedAt.slice(0, 10)}.json`;
}

/** 单空间导出文件名：ste-memory-space-export-<导出日期>.json（用户 story 4）。 */
function spaceExportFilename(exportedAt: string): string {
  return `ste-memory-space-export-${exportedAt.slice(0, 10)}.json`;
}

/**
 * 从全库快照提取当前空间的单单元导出（issue 26 纯函数 seam）：只含当前空间单元，
 * 按 includeHistory 裁剪修订历史。找不到当前空间返回 null（导出前校验）。
 */
export function buildSpaceExportUnit(
  snapshot: MemoryBackupSnapshot,
  spaceId: MemorySpaceId,
  includeHistory: boolean,
): MemorySpaceBackup | null {
  const unit = snapshot.spaces.find((item) => item.space.id === spaceId);
  if (!unit) return null;
  return includeHistory ? unit : { ...unit, history: [] };
}

// ---- 顶部工具栏按钮 ----

export function ToolbarButton(props: {
  readonly model: PanelModel;
  /** 与面板共享的离开守卫槽（可选；缺省不拦截） */
  readonly leaveGuardRef?: { current: LeaveGuard | null };
}) {
  const state = useSyncExternalStore(
    (listener) => props.model.onStateChange(listener),
    () => props.model.getState(),
    () => props.model.getState(),
  );
  return (
    <button
      type="button"
      className="stm-toolbar-button"
      aria-label={`${PLUGIN_DISPLAY_NAME} 记忆面板`}
      aria-pressed={state.open}
      onClick={() => {
        // 收起面板时同样过离开守卫（记录 Tab 有未保存修改 → 确认）
        if (state.open) {
          const guard = props.leaveGuardRef?.current;
          if (guard && !guard()) return;
        }
        props.model.toggle();
      }}
    >
      <i className="fa-solid fa-book-open" aria-hidden="true"></i>
    </button>
  );
}

// ---- 桌面浮动窗口几何（顶栏拖拽移动 + 右下角缩放；移动端不启用） ----

/** 当前视口尺寸（拖拽/缩放钳制基准） */
function viewportSize(): ViewportSize {
  return { width: window.innerWidth, height: window.innerHeight };
}

// ---- 面板骨架 ----

export function PanelShell(props: {
  readonly runtime: PanelRuntime;
  readonly model: PanelModel;
  /** 与顶部按钮共享的离开守卫槽（可选；缺省用内部 ref，测试友好） */
  readonly leaveGuardRef?: { current: LeaveGuard | null };
}) {
  const state = useSyncExternalStore(
    (listener) => props.model.onStateChange(listener),
    () => props.model.getState(),
    () => props.model.getState(),
  );
  const status = useSyncExternalStore(
    (listener) => props.runtime.manager.onStatusChange(listener),
    () => props.runtime.manager.getStatus(),
    () => props.runtime.manager.getStatus(),
  );
  const syncStatus = useSyncExternalStore(
    (listener) => props.runtime.sync.onStatusChange(listener),
    () => props.runtime.sync.getStatus(),
    () => props.runtime.sync.getStatus(),
  );
  const mirrorStatus = useSyncExternalStore(
    (listener) => props.runtime.mirror.onStatusChange(listener),
    () => props.runtime.mirror.getStatus(),
    () => props.runtime.mirror.getStatus(),
  );
  // 设置只经本面板的开关写入（唯一写入口），组件本地 state 即最新值
  const [settings, setSettings] = useState<PluginSettings>(() => props.runtime.settings.read());
  // 日志定位（ADR 0008）：任务面板「查看日志」跳转到日志 Tab 时携带的目标 runId
  const [logFocusRunId, setLogFocusRunId] = useState<string | null>(null);
  // 问答聊天历史/run 状态的页面内存存储（ticket 20）：挂在面板壳上，跨 Tab 切换存活；
  // 刷新页面即失（决策 4/9：不落 Dexie、不进通用日志）
  const [queryChatStore] = useState(() => new QueryChatStore());

  const info = buildSpaceInfo(status, settings, syncStatus);
  // 数据版本：导入备份等整库变更后自增，驱动表格列表等依赖数据的区块重取
  const [dataVersion, setDataVersion] = useState(0);

  // ---- 分支检测弹窗 ----
  const branchHandledRef = useRef(false);
  useEffect(() => {
    if (status?.kind !== "branch-detected" || branchHandledRef.current) return;
    branchHandledRef.current = true;
    const binding = status.binding;
    const space = status.space;

    const handleBranch = async () => {
      try {
        const result = await props.runtime.popup?.show(
          `检测到分支对话！\n\n当前对话继承了记忆空间「${space.name}」（${space.id}），但该空间属于另一个对话。\n\n请选择如何处理：`,
          {
            type: 2, // CONFIRM
            okButton: "创建新空间",
            cancelButton: `复制「${space.name}」`,
            wide: true,
          },
        );

        // result = 1 (AFFIRMATIVE) = 创建新空间
        // result = 0 (NEGATIVE) = 复制空间
        if (result === 1) {
          await props.runtime.manager.resolveBranch({ action: "create" });
        } else if (result === 0) {
          await props.runtime.manager.resolveBranch({
            action: "clone",
            sourceSpaceId: binding.spaceId,
          });
        }
        // result = null/undefined = 用户关闭弹窗，不做处理
      } catch (error) {
        console.error("[STE Memory] 分支处理失败", error);
      } finally {
        branchHandledRef.current = false;
      }
    };

    void handleBranch();
  }, [status, props.runtime]);

  // ---- 桌面浮动窗口：几何（CSS 变量）由本组件直接写面板元素，不经过 React state ----
  const panelRef = useRef<HTMLElement | null>(null);

  // 记录 Tab 的离开守卫（未保存修改确认；RecordsTab 挂载时注册、卸载时注销）
  const internalGuardRef = useRef<LeaveGuard | null>(null);
  const guardRef = props.leaveGuardRef ?? internalGuardRef;
  const registerLeaveGuard = useCallback(
    (guard: LeaveGuard | null) => {
      guardRef.current = guard;
    },
    [guardRef],
  );
  function confirmLeaveRecordsTab(): boolean {
    if (state.tab !== "records") return true;
    const guard = guardRef.current;
    return guard ? guard() : true;
  }
  const geometryRef = useRef<PanelGeometry | null>(null);

  /** 读取当前几何；首次交互时以实际盒子尺寸为基准（尺寸用像素固化，之后不再回退 CSS 默认） */
  function currentGeometry(): PanelGeometry {
    const existing = geometryRef.current;
    if (existing) return existing;
    const rect = panelRef.current?.getBoundingClientRect();
    const geometry: PanelGeometry = {
      x: null,
      y: null,
      width: Math.round(rect?.width ?? 720),
      height: Math.round(rect?.height ?? 680),
    };
    geometryRef.current = geometry;
    return geometry;
  }

  /** 把几何写到面板元素的 CSS 变量（仅桌面媒体查询消费；居中态移除位置变量回退默认） */
  function applyGeometry(geometry: PanelGeometry): void {
    const style = panelRef.current?.style;
    if (!style) return;
    if (geometry.x === null) {
      style.removeProperty("--stm-x");
      style.removeProperty("--stm-tx");
    } else {
      style.setProperty("--stm-x", `${geometry.x}px`);
      style.setProperty("--stm-tx", "0px");
    }
    if (geometry.y === null) {
      style.removeProperty("--stm-y");
      style.removeProperty("--stm-ty");
    } else {
      style.setProperty("--stm-y", `${geometry.y}px`);
      style.setProperty("--stm-ty", "0px");
    }
    style.setProperty("--stm-w", `${geometry.width}px`);
    style.setProperty("--stm-h", `${geometry.height}px`);
  }

  // 恢复持久化几何：挂载时 + 每次跨入桌面断点时（移动端几何变量惰性，恢复对移动端无影响）
  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia(DESKTOP_MEDIA_QUERY);
    const applySaved = (): void => {
      if (!media.matches || !panelRef.current) return;
      const saved = loadGeometry(safeLocalStorage());
      if (!saved) return;
      const geometry = clampGeometry(saved, viewportSize());
      geometryRef.current = geometry;
      applyGeometry(geometry);
    };
    applySaved();
    media.addEventListener("change", applySaved);
    return () => media.removeEventListener("change", applySaved);
  }, []);

  /** 拖拽/缩放收尾：摘监听 + 持久化几何（localStorage，UI 窗口状态） */
  function endWindowGesture(panel: HTMLElement): void {
    panel.classList.remove("stm-panel--dragging");
    saveGeometry(safeLocalStorage(), currentGeometry());
  }

  /** 顶栏拖拽移动：排除交互元素（按钮/输入等保持点按目标），捕获指针后随移动写几何 */
  function beginHeaderDrag(event: React.PointerEvent<HTMLElement>): void {
    if (event.button !== 0) return;
    if (!window.matchMedia(DESKTOP_MEDIA_QUERY).matches) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, select, a, label, textarea")) return;
    const panel = panelRef.current;
    if (!panel) return;
    event.preventDefault();
    const geometry = currentGeometry();
    const rect = panel.getBoundingClientRect();
    const grabOffsetX = event.clientX - rect.left;
    const grabOffsetY = event.clientY - rect.top;
    panel.classList.add("stm-panel--dragging");
    panel.setPointerCapture(event.pointerId);
    const onMove = (move: PointerEvent): void => {
      const next = clampGeometry(
        {
          x: move.clientX - grabOffsetX,
          y: move.clientY - grabOffsetY,
          width: geometry.width,
          height: geometry.height,
        },
        viewportSize(),
      );
      geometryRef.current = next;
      applyGeometry(next);
    };
    const onEnd = (): void => {
      panel.removeEventListener("pointermove", onMove);
      panel.removeEventListener("pointerup", onEnd);
      panel.removeEventListener("pointercancel", onEnd);
      endWindowGesture(panel);
    };
    panel.addEventListener("pointermove", onMove);
    panel.addEventListener("pointerup", onEnd);
    panel.addEventListener("pointercancel", onEnd);
  }

  /** 右下角缩放：从按下时的尺寸增量计算，钳制在最小尺寸与视口内；位置保持不变 */
  function beginPanelResize(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    if (!window.matchMedia(DESKTOP_MEDIA_QUERY).matches) return;
    const panel = panelRef.current;
    if (!panel) return;
    event.preventDefault();
    const geometry = currentGeometry();
    const startX = event.clientX;
    const startY = event.clientY;
    panel.classList.add("stm-panel--dragging");
    panel.setPointerCapture(event.pointerId);
    const onMove = (move: PointerEvent): void => {
      const next = clampGeometry(
        {
          x: geometry.x,
          y: geometry.y,
          width: geometry.width + (move.clientX - startX),
          height: geometry.height + (move.clientY - startY),
        },
        viewportSize(),
      );
      geometryRef.current = next;
      applyGeometry(next);
    };
    const onEnd = (): void => {
      panel.removeEventListener("pointermove", onMove);
      panel.removeEventListener("pointerup", onEnd);
      panel.removeEventListener("pointercancel", onEnd);
      endWindowGesture(panel);
    };
    panel.addEventListener("pointermove", onMove);
    panel.addEventListener("pointerup", onEnd);
    panel.addEventListener("pointercancel", onEnd);
  }

  return (
    <aside
      id="stm-panel"
      ref={panelRef}
      className={state.open ? "stm-panel stm-panel--open" : "stm-panel"}
      aria-hidden={!state.open}
    >
      <header className="stm-panel-header" data-action="drag-panel" onPointerDown={beginHeaderDrag}>
        <div className="stm-space-info">
          <div className="stm-space-title">{info.title}</div>
          {info.detail ? <div className="stm-space-status">{info.detail}</div> : null}
        </div>
        <button
          type="button"
          className="stm-panel-close"
          data-action="close-panel"
          aria-label="收起面板"
          onClick={() => {
            if (!confirmLeaveRecordsTab()) return;
            props.model.close();
          }}
        >
          <i className="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </header>
      <nav className="stm-tabbar" role="tablist" aria-label={`${PLUGIN_DISPLAY_NAME} 面板`}>
        {PANEL_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            className="stm-tab"
            role="tab"
            data-tab={tab}
            data-action="tab"
            aria-selected={tab === state.tab}
            onClick={() => {
              if (!confirmLeaveRecordsTab()) return;
              props.model.setTab(tab);
            }}
          >
            {PANEL_TAB_LABELS[tab]}
          </button>
        ))}
      </nav>
      <main className="stm-panel-body">
        {state.tab === "tables" && (
          <section className="stm-tab-section" data-stm-section="tables" role="tabpanel">
            <TablesTab
              runtime={props.runtime}
              status={status}
              settings={settings}
              dataVersion={dataVersion}
            />
          </section>
        )}
        {state.tab === "records" && (
          <section className="stm-tab-section" data-stm-section="records" role="tabpanel">
            <RecordsTab
              runtime={props.runtime}
              status={status}
              settings={settings}
              dataVersion={dataVersion}
              registerLeaveGuard={registerLeaveGuard}
            />
          </section>
        )}
        {state.tab === "tasks" && (
          <section className="stm-tab-section" data-stm-section="tasks" role="tabpanel">
            <TasksTab
              runtime={props.runtime}
              status={status}
              settings={settings}
              onSettingsChange={setSettings}
              onViewLogs={(runId) => {
                setLogFocusRunId(runId);
                props.model.setTab("logs");
              }}
            />
          </section>
        )}
        {state.tab === "query" && (
          <section className="stm-tab-section" data-stm-section="query" role="tabpanel">
            <QueryChatTab
              runtime={props.runtime}
              status={status}
              settings={settings}
              store={queryChatStore}
              onDataChanged={() => setDataVersion((version) => version + 1)}
            />
          </section>
        )}
        {state.tab === "logs" && (
          <section className="stm-tab-section" data-stm-section="logs" role="tabpanel">
            <LogTab
              runtime={props.runtime}
              status={status}
              settings={settings}
              focusRunId={logFocusRunId}
              onFocusConsumed={() => setLogFocusRunId(null)}
            />
          </section>
        )}
        {state.tab === "settings" && (
          <section className="stm-tab-section" data-stm-section="settings" role="tabpanel">
            <SettingsTab
              runtime={props.runtime}
              status={status}
              settings={settings}
              syncStatus={syncStatus}
              mirrorStatus={mirrorStatus}
              queryChatStore={queryChatStore}
              panelElementRef={panelRef}
              onSettingsChange={setSettings}
              onDataChanged={() => setDataVersion((version) => version + 1)}
            />
          </section>
        )}
      </main>
      {/* 桌面浮动窗口：右下角缩放手柄（移动端隐藏；data-action 为验收脚本契约） */}
      <div
        className="stm-panel-resize"
        data-action="resize-panel"
        aria-hidden="true"
        onPointerDown={beginPanelResize}
      />
    </aside>
  );
}

// ---- 表格列表 Tab（ticket 09：建表 + 表格编辑/删除 + 字段定义编辑器） ----

type FieldEditorState =
  | { readonly mode: "create"; readonly tableId: MemoryTableId }
  | {
      readonly mode: "edit";
      readonly tableId: MemoryTableId;
      readonly fieldId: MemoryFieldId;
    }
  | null;

function TablesTab(props: {
  readonly runtime: PanelRuntime;
  readonly status: SpaceContextStatus | undefined;
  readonly settings: PluginSettings;
  /** 整库数据版本（导入备份后自增，驱动重取） */
  readonly dataVersion: number;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<MemoryTableId>>(new Set());
  const [tables, setTables] = useState<readonly TableListItemViewModel[] | undefined>(undefined);
  // 原始表/字段数据（编辑器需要 prompt、position、options 等视图模型未携带的字段）
  const [rawTables, setRawTables] = useState<readonly MemoryTable[] | undefined>(undefined);
  const [fieldsByTable, setFieldsByTable] = useState<
    ReadonlyMap<MemoryTableId, readonly MemoryField[]>
  >(new Map());
  // 变更后重新拉取（Dexie 是事实源；重渲染永远基于最新数据）
  const [reloadKey, setReloadKey] = useState(0);
  // 首个表格只自动展开一次（跨空间不重复展开）
  const autoExpandedRef = useRef(false);
  // 编辑器状态：建表 / 编辑表 / 字段管理模式 / 字段编辑器
  const [creatingTable, setCreatingTable] = useState(false);
  const [editingTableId, setEditingTableId] = useState<MemoryTableId | null>(null);
  const [fieldEditMode, setFieldEditMode] = useState<ReadonlySet<MemoryTableId>>(new Set());
  const [fieldEditor, setFieldEditor] = useState<FieldEditorState>(null);
  // 显示策略编辑器状态（ticket 10）：打开的表格 + 预览记录/加载错误/保存中
  const [strategyEditorTableId, setStrategyEditorTableId] = useState<MemoryTableId | null>(null);
  const [strategyPreviewRecords, setStrategyPreviewRecords] = useState<readonly MemoryRecord[]>([]);
  const [strategyPreviewError, setStrategyPreviewError] = useState<string | null>(null);
  const [strategySaving, setStrategySaving] = useState(false);
  // 打开中的策略编辑器表格（异步加载预览记录的竞态守卫：快速切换/关闭后丢弃过期结果）
  const strategyEditorTableRef = useRef<MemoryTableId | null>(null);

  const active = activeStatus(props.status);
  const spaceId = active?.space.id;

  // 显示策略预览计算：core previewDisplayText 绑定当前空间/表（只读，不落库）
  const computePreview = useCallback(
    (strategy: MemoryTableDisplayStrategy, payload: MemoryRecordPayload) => {
      if (!spaceId || !strategyEditorTableId) return Promise.resolve("");
      return props.runtime.records.previewDisplayText(
        spaceId,
        strategyEditorTableId,
        strategy,
        payload,
      );
    },
    [props.runtime, spaceId, strategyEditorTableId],
  );

  useEffect(() => {
    if (!spaceId) {
      setTables(undefined);
      setRawTables(undefined);
      setFieldsByTable(new Map());
      strategyEditorTableRef.current = null;
      setStrategyEditorTableId(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = await props.runtime.tables.list(spaceId);
        const fieldLists = await Promise.all(
          list.map((table) => props.runtime.fields.list(spaceId, table.id)),
        );
        if (cancelled) return;
        const fieldsByTable = new Map(list.map((table, index) => [table.id, fieldLists[index]!]));
        const viewModel = buildTableListViewModel(list, fieldsByTable);
        // 切空间后旧表格 id 失效；首个表格只自动展开一次
        const validIds = new Set(viewModel.map((table) => table.id));
        setExpanded((prev) => {
          const next = new Set([...prev].filter((id) => validIds.has(id)));
          if (!autoExpandedRef.current && viewModel.length > 0) next.add(viewModel[0]!.id);
          return next;
        });
        autoExpandedRef.current = true;
        setRawTables(list);
        setFieldsByTable(fieldsByTable);
        setTables(viewModel);
        // 编辑器指向的表/字段可能已被删除：失效即关闭
        setFieldEditor((prev) => {
          if (!prev || !validIds.has(prev.tableId)) return null;
          if (
            prev.mode === "edit" &&
            !(fieldsByTable.get(prev.tableId) ?? []).some((field) => field.id === prev.fieldId)
          ) {
            return null;
          }
          return prev;
        });
        setEditingTableId((prev) => (prev && validIds.has(prev) ? prev : null));
        setStrategyEditorTableId((prev) => {
          if (prev && !validIds.has(prev)) {
            strategyEditorTableRef.current = null;
            return null;
          }
          return prev;
        });
      } catch (error) {
        if (!cancelled) reportError(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.runtime, spaceId, reloadKey, props.dataVersion]);

  if (!props.settings.enabled) {
    return <Placeholder title="插件已停用" hint="在设置中重新启用后恢复表格展示与同步" />;
  }
  if (!active) {
    return (
      <Placeholder
        title={
          props.status && props.status.kind !== "active" && props.status.kind !== "branch-detected"
            ? props.status.humanMsg
            : "正在加载…"
        }
        hint="切换到已保存的对话后自动恢复"
      />
    );
  }
  // 守卫后的窄化常量：闭包内不依赖 TS 对联合类型收窄的保留
  const currentSpaceId = active.space.id;
  if (tables === undefined || rawTables === undefined) {
    return null; // 首载完成前不渲染（与旧版内联渲染时机一致）
  }

  /**
   * 数据变更收尾：刷新列表 + 立即重建记忆宏快照（消除指纹轮询陈旧窗口——
   * 面板操作后马上生成也要展开最新记忆）。所有表格/字段/记录写操作统一走这里。
   */
  function bumpData(): void {
    setReloadKey((key) => key + 1);
    void props.runtime.macro.kick().catch(reportError);
  }

  async function toggleTable(tableId: MemoryTableId, enabled: boolean): Promise<void> {
    try {
      await props.runtime.tables.update(currentSpaceId, tableId, { enabled });
    } catch (error) {
      reportError(error);
    }
    bumpData();
  }

  async function toggleField(
    tableId: MemoryTableId,
    fieldId: MemoryFieldId,
    enabled: boolean,
  ): Promise<void> {
    try {
      const result = await props.runtime.fields.update(currentSpaceId, tableId, fieldId, {
        enabled,
      });
      if (result && result.warnings.length > 0) {
        reportWarning(result.warnings.join("；"));
      }
    } catch (error) {
      reportError(error);
    }
    bumpData();
  }

  function toggleExpand(tableId: MemoryTableId): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(tableId)) {
        next.delete(tableId);
      } else {
        next.add(tableId);
      }
      return next;
    });
  }

  /** 打开字段编辑器时确保卡片展开（新建/编辑入口都可见） */
  function openFieldEditor(state: Exclude<FieldEditorState, null>): void {
    setExpanded((prev) => new Set(prev).add(state.tableId));
    setFieldEditor(state);
  }

  async function createTable(draft: TableDraft): Promise<void> {
    try {
      await props.runtime.tables.create(currentSpaceId, {
        key: draft.key,
        kind: "custom",
        name: draft.name,
        description: draft.description,
        prompt: draft.prompt,
      });
      setCreatingTable(false);
    } catch (error) {
      reportError(error);
    }
    bumpData();
  }

  async function saveTableEdit(tableId: MemoryTableId, draft: TableDraft): Promise<void> {
    try {
      await props.runtime.tables.update(currentSpaceId, tableId, {
        key: draft.key,
        name: draft.name,
        description: draft.description,
        prompt: draft.prompt,
      });
      setEditingTableId(null);
    } catch (error) {
      reportError(error);
    }
    bumpData();
  }

  async function deleteTable(tableId: MemoryTableId, tableName: string): Promise<void> {
    if (
      !window.confirm(`确定删除表格「${tableName}」吗？将同时删除其中的字段与记录，且不可恢复。`)
    ) {
      return;
    }
    try {
      await props.runtime.tables.delete(currentSpaceId, tableId);
    } catch (error) {
      reportError(error);
    }
    setFieldEditor(null);
    setEditingTableId(null);
    bumpData();
  }

  async function createField(tableId: MemoryTableId, draft: FieldDraft): Promise<void> {
    const fields = fieldsByTable.get(tableId) ?? [];
    const position = fields.length === 0 ? 0 : fields[fields.length - 1]!.position + 1;
    try {
      await props.runtime.fields.create(currentSpaceId, tableId, {
        key: draft.key,
        name: draft.name,
        type: draft.type,
        required: draft.required,
        prompt: draft.prompt,
        enabled: draft.enabled,
        position,
        options: fieldTypeNeedsOptions(draft.type) ? parseOptionsText(draft.optionsText) : [],
        referenceTableId:
          draft.referenceTableId === "" ? null : (draft.referenceTableId as MemoryTableId),
      });
      setFieldEditor(null);
    } catch (error) {
      reportError(error);
    }
    bumpData();
  }

  async function saveFieldEdit(
    tableId: MemoryTableId,
    fieldId: MemoryFieldId,
    draft: FieldDraft,
  ): Promise<void> {
    try {
      const result = await props.runtime.fields.update(currentSpaceId, tableId, fieldId, {
        key: draft.key,
        name: draft.name,
        required: draft.required,
        prompt: draft.prompt,
        enabled: draft.enabled,
        options: fieldTypeNeedsOptions(draft.type)
          ? parseOptionsText(draft.optionsText)
          : undefined,
        referenceTableId:
          draft.referenceTableId === "" ? null : (draft.referenceTableId as MemoryTableId),
      });
      if (result) {
        if (result.warnings.length > 0) {
          reportWarning(result.warnings.join("；"));
        }
        setFieldEditor(null);
      } else {
        reportError(new Error("字段已不存在，请刷新后重试"));
      }
    } catch (error) {
      reportError(error);
    }
    bumpData();
  }

  async function deleteField(
    tableId: MemoryTableId,
    fieldId: MemoryFieldId,
    fieldName: string,
  ): Promise<void> {
    if (!window.confirm(`确定删除字段「${fieldName}」吗？记录中已填的旧值将保留但不再显示。`)) {
      return;
    }
    try {
      await props.runtime.fields.delete(currentSpaceId, tableId, fieldId);
    } catch (error) {
      reportError(error);
    }
    setFieldEditor(null);
    bumpData();
  }

  async function moveField(
    tableId: MemoryTableId,
    fieldId: MemoryFieldId,
    direction: -1 | 1,
  ): Promise<void> {
    const fields = fieldsByTable.get(tableId) ?? [];
    const index = fields.findIndex((field) => field.id === fieldId);
    const changes = swapAdjacentFieldPositions(fields, index, direction);
    try {
      for (const change of changes) {
        await props.runtime.fields.update(currentSpaceId, tableId, change.id, {
          position: change.position,
        });
      }
    } catch (error) {
      reportError(error);
    }
    bumpData();
  }

  function toggleFieldEditMode(tableId: MemoryTableId): void {
    setFieldEditMode((prev) => {
      const next = new Set(prev);
      if (next.has(tableId)) {
        next.delete(tableId);
      } else {
        next.add(tableId);
      }
      return next;
    });
  }

  /** 打开显示策略编辑器：展开卡片 + 加载该表现有记录（最多 5 条）供预览 */
  async function openStrategyEditor(tableId: MemoryTableId): Promise<void> {
    setExpanded((prev) => new Set(prev).add(tableId));
    strategyEditorTableRef.current = tableId;
    setStrategyEditorTableId(tableId);
    setStrategyPreviewRecords([]);
    setStrategyPreviewError(null);
    try {
      const page = await props.runtime.records.list(currentSpaceId, tableId, {
        page: 1,
        pageSize: 5,
      });
      // 期间已切换/关闭编辑器：丢弃过期结果
      if (strategyEditorTableRef.current !== tableId) return;
      setStrategyPreviewRecords(page?.records ?? []);
    } catch {
      // 记录含已删除字段的孤儿值等场景 core 校验会拒绝列表读取：预览降级为提示
      if (strategyEditorTableRef.current !== tableId) return;
      setStrategyPreviewError("无法加载现有记录用于预览");
    }
  }

  async function saveDisplayStrategy(
    tableId: MemoryTableId,
    strategy: MemoryTableDisplayStrategy,
  ): Promise<void> {
    setStrategySaving(true);
    try {
      await props.runtime.fields.setDisplayStrategy(currentSpaceId, tableId, strategy);
      reportSuccess("显示策略已保存");
      strategyEditorTableRef.current = null;
      setStrategyEditorTableId(null);
    } catch (error) {
      reportError(error);
    } finally {
      setStrategySaving(false);
    }
    bumpData();
  }

  function closeStrategyEditor(): void {
    strategyEditorTableRef.current = null;
    setStrategyEditorTableId(null);
  }

  return (
    <>
      <div className="stm-table-actions stm-table-actions--top">
        <button
          type="button"
          className="stm-button stm-button--primary"
          data-action="create-table"
          onClick={() => setCreatingTable(true)}
        >
          新建表格
        </button>
        {creatingTable && (
          <TableEditorForm
            title="新建表格"
            initial={EMPTY_TABLE_DRAFT}
            submitLabel="创建表格"
            onSave={(draft) => void createTable(draft)}
            onCancel={() => setCreatingTable(false)}
          />
        )}
      </div>
      {tables.length === 0 ? (
        <Placeholder title="还没有记忆表格" hint="点击上方「新建表格」开始记录" />
      ) : null}
      <ul className="stm-table-list">
        {tables.map((table) => {
          const isExpanded = expanded.has(table.id);
          const isCustom = table.kind === "custom";
          const isManagingFields = fieldEditMode.has(table.id);
          const kindLabel = table.kind === "system" ? "系统表" : "自定义";
          const fieldCountText =
            table.fields.length === 0
              ? "无字段"
              : `${table.enabledFieldCount}/${table.fields.length} 字段启用`;
          const rawTable = rawTables.find((item) => item.id === table.id);
          const tableFields = fieldsByTable.get(table.id) ?? [];
          const dependentFieldIds = displayStrategyDependentFieldIds(
            rawTable?.displayStrategy ?? null,
          );
          return (
            <li key={table.id} className="stm-table-card">
              {/* 整行可点击展开/收起（点开关除外；展开按钮 stopPropagation 避免双触发） */}
              <div
                className="stm-table-row"
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest(".stm-switch")) return;
                  toggleExpand(table.id);
                }}
              >
                <button
                  type="button"
                  className="stm-expand"
                  data-action="expand-table"
                  data-table-id={table.id}
                  aria-expanded={isExpanded}
                  aria-label={isExpanded ? "收起字段" : "展开字段"}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleExpand(table.id);
                  }}
                >
                  <i
                    className={`fa-solid ${isExpanded ? "fa-chevron-up" : "fa-chevron-down"}`}
                    aria-hidden="true"
                  />
                </button>
                <div className="stm-table-row-main">
                  <div className="stm-table-name">
                    {table.name}
                    <span className="stm-table-kind">{kindLabel}</span>
                  </div>
                  <div className="stm-table-meta">
                    {table.key} · {fieldCountText} ·{" "}
                    {displayStrategySummary(rawTable?.displayStrategy ?? null, tableFields)}
                  </div>
                </div>
                <label className="stm-switch">
                  <input
                    type="checkbox"
                    data-action="toggle-table"
                    data-table-id={table.id}
                    checked={table.enabled}
                    onChange={(event) => void toggleTable(table.id, event.target.checked)}
                  />
                  <span className="stm-switch-track" aria-hidden="true"></span>
                </label>
              </div>
              {/* 自定义表：编辑/新增字段/删除；系统表只读 */}
              {isCustom ? (
                <div className="stm-table-actions">
                  <button
                    type="button"
                    className="stm-table-action"
                    data-action="edit-table"
                    data-table-id={table.id}
                    aria-pressed={editingTableId === table.id}
                    onClick={() => setEditingTableId(editingTableId === table.id ? null : table.id)}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="stm-table-action"
                    data-action="add-field"
                    data-table-id={table.id}
                    onClick={() => openFieldEditor({ mode: "create", tableId: table.id })}
                  >
                    新增字段
                  </button>
                  <button
                    type="button"
                    className="stm-table-action"
                    data-action="edit-display-strategy"
                    data-table-id={table.id}
                    aria-pressed={strategyEditorTableId === table.id}
                    onClick={() => {
                      if (strategyEditorTableId === table.id) {
                        closeStrategyEditor();
                      } else {
                        void openStrategyEditor(table.id);
                      }
                    }}
                  >
                    显示策略
                  </button>
                  <button
                    type="button"
                    className="stm-table-action stm-table-action--danger"
                    data-action="delete-table"
                    data-table-id={table.id}
                    onClick={() => void deleteTable(table.id, table.name)}
                  >
                    删除
                  </button>
                </div>
              ) : (
                <div className="stm-table-actions">
                  <span className="stm-table-action stm-table-action--hint">系统表只读</span>
                </div>
              )}
              {isCustom && editingTableId === table.id && rawTable && (
                <TableEditorForm
                  title="编辑表格"
                  initial={{
                    key: rawTable.key,
                    name: rawTable.name,
                    description: rawTable.description,
                    prompt: rawTable.prompt,
                  }}
                  submitLabel="保存"
                  onSave={(draft) => void saveTableEdit(table.id, draft)}
                  onCancel={() => setEditingTableId(null)}
                />
              )}
              {/* 显示策略编辑器（ticket 10）：自定义表可配置；系统表策略预置只读 */}
              {isCustom && strategyEditorTableId === table.id && rawTable && (
                <DisplayStrategyEditor
                  title="显示策略"
                  initial={emptyDisplayStrategyDraft(rawTable.displayStrategy)}
                  fields={tableFields}
                  previewRecords={strategyPreviewRecords}
                  previewError={strategyPreviewError}
                  computePreview={computePreview}
                  saving={strategySaving}
                  onSave={(strategy) => void saveDisplayStrategy(table.id, strategy)}
                  onCancel={closeStrategyEditor}
                />
              )}
              {isExpanded && (
                <>
                  {isCustom && (
                    <div className="stm-field-edit-toggle">
                      <button
                        type="button"
                        className="stm-table-action"
                        data-action="toggle-field-edit"
                        data-table-id={table.id}
                        aria-pressed={isManagingFields}
                        onClick={() => toggleFieldEditMode(table.id)}
                      >
                        {isManagingFields ? "完成字段管理" : "管理字段"}
                      </button>
                    </div>
                  )}
                  {table.fields.length > 0 && (
                    <ul className="stm-field-list">
                      {table.fields.map((field, fieldIndex) => {
                        const isDependent = dependentFieldIds.has(field.id);
                        return (
                          <li key={field.id} className="stm-field-row">
                            <div className="stm-field-info">
                              <div className="stm-field-name">
                                {field.name}
                                {field.required ? (
                                  <span className="stm-field-required" title="必填">
                                    *
                                  </span>
                                ) : null}
                                {isDependent ? (
                                  <span
                                    className="stm-field-dep"
                                    title="该字段被显示策略依赖，请先修改显示策略"
                                  >
                                    显示策略依赖
                                  </span>
                                ) : null}
                              </div>
                              <div className="stm-field-tag">
                                {field.key} · {field.typeLabel}
                              </div>
                            </div>
                            <label
                              className="stm-switch"
                              title={isDependent ? "该字段被显示策略依赖，不能停用" : undefined}
                            >
                              <input
                                type="checkbox"
                                data-action="toggle-field"
                                data-table-id={table.id}
                                data-field-id={field.id}
                                checked={field.enabled}
                                disabled={isDependent}
                                onChange={(event) =>
                                  void toggleField(table.id, field.id, event.target.checked)
                                }
                              />
                              <span className="stm-switch-track" aria-hidden="true"></span>
                            </label>
                            {isCustom && isManagingFields && (
                              <div className="stm-field-edit-row">
                                <button
                                  type="button"
                                  className="stm-field-action"
                                  data-action="move-field-up"
                                  data-table-id={table.id}
                                  data-field-id={field.id}
                                  disabled={fieldIndex === 0}
                                  aria-label={`上移字段 ${field.name}`}
                                  onClick={() => void moveField(table.id, field.id, -1)}
                                >
                                  <i className="fa-solid fa-arrow-up" aria-hidden="true"></i>
                                </button>
                                <button
                                  type="button"
                                  className="stm-field-action"
                                  data-action="move-field-down"
                                  data-table-id={table.id}
                                  data-field-id={field.id}
                                  disabled={fieldIndex === table.fields.length - 1}
                                  aria-label={`下移字段 ${field.name}`}
                                  onClick={() => void moveField(table.id, field.id, 1)}
                                >
                                  <i className="fa-solid fa-arrow-down" aria-hidden="true"></i>
                                </button>
                                <button
                                  type="button"
                                  className="stm-field-action"
                                  data-action="edit-field"
                                  data-table-id={table.id}
                                  data-field-id={field.id}
                                  aria-label={`编辑字段 ${field.name}`}
                                  onClick={() =>
                                    openFieldEditor({
                                      mode: "edit",
                                      tableId: table.id,
                                      fieldId: field.id,
                                    })
                                  }
                                >
                                  <i className="fa-solid fa-pen" aria-hidden="true"></i>
                                </button>
                                <button
                                  type="button"
                                  className="stm-field-action stm-field-action--danger"
                                  data-action="delete-field"
                                  data-table-id={table.id}
                                  data-field-id={field.id}
                                  disabled={isDependent}
                                  title={isDependent ? "该字段被显示策略依赖，不能删除" : undefined}
                                  aria-label={`删除字段 ${field.name}`}
                                  onClick={() => void deleteField(table.id, field.id, field.name)}
                                >
                                  <i className="fa-solid fa-trash" aria-hidden="true"></i>
                                </button>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </>
              )}
              {/* 字段编辑器（打开即显示，不依赖卡片展开） */}
              {isCustom && fieldEditor?.tableId === table.id && (
                <FieldEditorForm
                  key={fieldEditor.mode === "create" ? "create" : fieldEditor.fieldId}
                  title={fieldEditor.mode === "create" ? "新增字段" : "编辑字段"}
                  initial={
                    fieldEditor.mode === "create"
                      ? emptyFieldDraft("short_text")
                      : (() => {
                          const field = tableFields.find((item) => item.id === fieldEditor.fieldId);
                          // 重载间隙字段可能已不存在：退化为空草稿，由 reload 后的
                          // 失效清理（effect）关闭编辑器，不在此处抛错
                          return field ? fieldDraftFromField(field) : emptyFieldDraft("short_text");
                        })()
                  }
                  existingKeys={
                    fieldEditor.mode === "edit"
                      ? tableFields
                          .filter((field) => field.id !== fieldEditor.fieldId)
                          .map((field) => field.key)
                      : tableFields.map((field) => field.key)
                  }
                  referenceTables={rawTables}
                  typeLocked={fieldEditor.mode === "edit"}
                  submitLabel={fieldEditor.mode === "create" ? "创建字段" : "保存字段"}
                  onSave={
                    fieldEditor.mode === "create"
                      ? (draft) => void createField(table.id, draft)
                      : (draft) => void saveFieldEdit(table.id, fieldEditor.fieldId, draft)
                  }
                  onCancel={() => setFieldEditor(null)}
                />
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ---- 设置 Tab ----

function SettingsTab(props: {
  readonly runtime: PanelRuntime;
  readonly status: SpaceContextStatus | undefined;
  readonly settings: PluginSettings;
  /** 云同步状态（ticket 08：最近同步时间、失败提示可见） */
  readonly syncStatus: CloudSyncStatus;
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
  const r2 = props.settings.r2;
  const configured = isR2Configured(props.settings);
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

  /** 更新单个 R2 配置字段并持久化；配置变化即时生效（协调器 kick 重新评估） */
  function updateR2Field(field: keyof R2Settings, value: string): void {
    const next = { ...props.settings, r2: { ...props.settings.r2, [field]: value } };
    props.runtime.settings.write(next);
    props.onSettingsChange(next);
    void props.runtime.sync.kick().catch(reportError);
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

  async function syncNow(): Promise<void> {
    try {
      await props.runtime.sync.syncNow();
    } catch (error) {
      reportError(error);
    }
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

  async function importBackup(file: File): Promise<void> {
    let text: string;
    try {
      text = await file.text();
    } catch (error) {
      reportError(error);
      return;
    }
    // 导入前校验（信封/结构/完整性）：失败报错且不触碰数据库
    let decoded: MemoryBackupFile;
    try {
      decoded = parseBackupFile(text);
    } catch (error) {
      reportError(error);
      return;
    }
    const spaceCount = decoded.data.spaces.length;
    if (!window.confirm(`导入将替换当前全部记忆数据（共 ${spaceCount} 个记忆空间），确定继续？`)) {
      return;
    }
    try {
      // 整体替换原子执行：任一步失败整体回滚，绝不产生半导入状态
      await props.runtime.backup.restoreSnapshot(decoded.data);
      reportSuccess(`已从备份恢复 ${spaceCount} 个记忆空间`);
      props.onDataChanged();
      // 导入即整库数据变更：立即重建记忆宏快照（不等轮询）
      void props.runtime.macro.kick().catch(reportError);
      // 恢复后立即重同步当前对话的空间绑定
      await props.runtime.manager.syncToCurrentChat().catch(reportError);
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
   * 导入到当前空间（issue 26）：解析校验 → 解析导入动作 → 按动作执行：
   * - restore：spaceId 匹配，整体替换当前空间（restoreSpace）；
   * - clone-and-rebind / create-and-bind：克隆文件空间为新空间 + 重建/建立绑定
   *   （原空间保留，ADR 0012）。
   * 全库文件与单空间文件同构（都是 data.spaces[]），自动提取匹配单元；不匹配时
   * 报错（用户 story 12）。导入后刷新面板 + 重建宏快照 + kick 镜像写回。
   */
  async function importSpaceBackup(file: File): Promise<void> {
    let text: string;
    try {
      text = await file.text();
    } catch (error) {
      reportError(error);
      return;
    }
    // 导入前校验（信封/结构/完整性）：失败报错且不触碰数据库（复用 issue 07）
    let decoded: MemoryBackupFile;
    try {
      decoded = parseBackupFile(text);
    } catch (error) {
      reportError(error);
      return;
    }
    // 读取当前绑定：从空间上下文状态取（active / branch-detected 含 binding；
    // binding-unrecognized 绝不能当作无绑定去新建覆盖，故报错）；其余视作无绑定。
    const currentStatus = props.runtime.manager.getStatus();
    if (currentStatus?.kind === "binding-unrecognized") {
      reportError(new Error(BINDING_UNRECOGNIZED_MESSAGE));
      return;
    }
    // active / branch-detected / space-missing 都持有有效绑定；space-missing 时若文件
    // 含该 spaceId 则 restore 直接恢复（符合「空间缺失从备份恢复」），不覆盖绑定。
    const currentBinding =
      currentStatus?.kind === "active" ||
      currentStatus?.kind === "branch-detected" ||
      currentStatus?.kind === "space-missing"
        ? currentStatus.binding
        : null;
    const action = resolveImportAction(decoded, currentBinding);
    if (action.kind === "no-match") {
      reportError(new Error("文件中不包含当前记忆空间的数据"));
      return;
    }
    // 匹配：一行简短确认；不匹配/无绑定：详细说明（cloneSpace 行为 + 原空间保留）
    const confirmed = window.confirm(
      action.kind === "restore"
        ? `将用文件中的数据替换当前记忆空间「${action.unit.space.name}」的全部记录。此操作不可撤销。确认？`
        : "将创建新的记忆空间并绑定到当前对话，原空间数据保留。确认？",
    );
    if (!confirmed) return;
    try {
      reportInfo("正在导入…");
      if (action.kind === "restore") {
        await props.runtime.backup.restoreSpace(action.unit);
        // 绑定不变、空间仍在：重同步收敛（与 issue 07 一致）
        await props.runtime.manager.syncToCurrentChat().catch(reportError);
      } else {
        // clone-and-rebind / create-and-bind 共用：克隆新空间 + 重建/建立绑定
        await props.runtime.manager.importSpace(action.unit);
      }
      reportSuccess(`已导入记忆空间「${action.unit.space.name}」`);
      // 导入后副作用（用户 story 22-24）：刷新面板 + 重建宏快照 + kick 镜像写回
      props.onDataChanged();
      void props.runtime.macro.kick().catch(reportError);
      void props.runtime.mirror.kick().catch(reportError);
    } catch (error) {
      reportError(error);
    }
  }

  /**
   * 空间维护操作（spec reset-space）：清除空间记录 / 重置空间。
   * 仅当前对话绑定空间（active 状态）且插件开启时可执行；原生 confirm 确认，
   * 文案写明删除范围与「云同步/对话文件镜像副本也会被清空」。执行成功后刷新
   * 面板数据、重建记忆宏快照、kick 云同步与镜像、清空问答面板当前空间历史。
   */
  const canMaintainSpace = props.status?.kind === "active" && props.settings.enabled;

  async function clearSpaceRecords(): Promise<void> {
    const status = props.status;
    if (status?.kind !== "active") return;
    const space = status.space;
    const confirmed = window.confirm(
      `清除「${space.name}」的全部记录？将删除所有表格中的记录、历史与证据，表格结构保留；云同步与对话文件镜像中的副本也会被清空。`,
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
      `重置「${space.name}」？将删除所有表格并恢复为系统默认的 8 张表（自定义表与修改过的表定义将被移除）；云同步与对话文件镜像中的副本也会被清空。`,
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
    // 记忆宏快照立即重建（不等轮询）；云同步与镜像按既有机制传播空单元
    void props.runtime.macro.kick().catch(reportError);
    void props.runtime.sync.kick().catch(reportError);
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
            <div className="stm-setting-group-summary">{macroSummary(props.settings)}</div>
          </div>
          <i
            className={`fa-solid ${isSettingsGroupExpanded(expandedGroups, "macro") ? "fa-chevron-up" : "fa-chevron-down"}`}
            aria-hidden="true"
          />
        </button>
        {isSettingsGroupExpanded(expandedGroups, "macro") && (
          <div className="stm-setting-group-body">
            <input
              className="stm-input"
              type="text"
              data-stm-field="macro-name"
              value={props.settings.macroName}
              placeholder="{{memoryContext}}"
              onChange={(event) => updateMacroName(event.target.value)}
            />
            <input
              className="stm-input"
              type="number"
              min="0"
              step="100"
              data-stm-field="macro-limit"
              value={props.settings.macroLimit}
              onChange={(event) => updateMacroLimit(event.target.value)}
            />
            <div className="stm-setting-hint">
              宏名放入提示词预设（角色卡/系统提示/作者注释）或世界书条目内容后，生成时展开
              当前记忆：无参 = 全部启用表分组快照；{"{{宏名::视图名}}"} = 对应视图快照；
              超过上方字符上限从尾部截断并附「……（已截断）」标记；不填宏名则不注入
            </div>
            <MemoryViewsManager
              spaceId={props.status?.kind === "active" ? props.status.space.id : undefined}
              readTables={(spaceId) => props.runtime.tables.list(spaceId as MemorySpaceId)}
              readFields={(spaceId, tableId) =>
                props.runtime.fields.list(spaceId as MemorySpaceId, tableId as MemoryTableId)
              }
              views={props.settings.memoryViews}
              onChange={(views) => {
                const next = { ...props.settings, memoryViews: views };
                props.runtime.settings.write(next);
                props.onSettingsChange(next);
                void props.runtime.macro.kick().catch(reportError);
              }}
            />
          </div>
        )}
      </div>

      {/* 对话级宏（双 Scope 宏系统） */}
      <div className="stm-setting-group stm-setting-group--collapsible" data-group="chat-scope-macros">
        <button
          type="button"
          className="stm-setting-group-header"
          data-action="toggle-settings-group"
          data-group="chat-scope-macros"
          aria-expanded={isSettingsGroupExpanded(expandedGroups, "chat-scope-macros")}
          onClick={() => toggleGroup("chat-scope-macros")}
        >
          <div className="stm-setting-group-header-main">
            <div className="stm-setting-group-title stm-setting-group-title--collapsible">
              对话级宏
            </div>
            <div className="stm-setting-group-summary">
              {props.status?.kind === "active" ? "当前对话" : "未绑定对话"}
            </div>
          </div>
          <i
            className={`fa-solid ${isSettingsGroupExpanded(expandedGroups, "chat-scope-macros") ? "fa-chevron-up" : "fa-chevron-down"}`}
            aria-hidden="true"
          />
        </button>
        {isSettingsGroupExpanded(expandedGroups, "chat-scope-macros") && (
          <div className="stm-setting-group-body stm-setting-group-body--manager">
            <ChatScopeMacrosManager
              spaceId={props.status?.kind === "active" ? props.status.space.id : undefined}
              readTables={(spaceId) => props.runtime.tables.list(spaceId as MemorySpaceId)}
              readFields={(spaceId, tableId) =>
                props.runtime.fields.list(spaceId as MemorySpaceId, tableId as MemoryTableId)
              }
              globalMacroNames={[props.settings.macroName.replace(/[{}]/g, "")]}
              macros={props.runtime.cleaning.readChatScopeMacros?.() ?? []}
              onChange={(macros) => {
                props.runtime.cleaning.writeChatScopeMacros?.(macros);
                void props.runtime.macro.kick().catch(reportError);
              }}
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
              仅备份/恢复当前对话的记忆空间；spaceId 不匹配或当前对话无绑定时克隆新空间（原空间保留）
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

      {/* 云同步（合并配置+状态） */}
      <div className="stm-setting-group stm-setting-group--collapsible" data-group="r2">
        <button
          type="button"
          className="stm-setting-group-header"
          data-action="toggle-settings-group"
          data-group="r2"
          aria-expanded={isSettingsGroupExpanded(expandedGroups, "r2")}
          onClick={() => toggleGroup("r2")}
        >
          <div className="stm-setting-group-header-main">
            <div className="stm-setting-group-title stm-setting-group-title--collapsible">
              云同步（Cloudflare R2）
            </div>
            <div className="stm-setting-group-summary">
              {r2Summary(props.settings, props.syncStatus)}
            </div>
          </div>
          <i
            className={`fa-solid ${isSettingsGroupExpanded(expandedGroups, "r2") ? "fa-chevron-up" : "fa-chevron-down"}`}
            aria-hidden="true"
          />
        </button>
        {isSettingsGroupExpanded(expandedGroups, "r2") && (
          <div className="stm-setting-group-body">
            <input
              className="stm-input"
              type="text"
              data-stm-field="r2-account-id"
              placeholder="Account ID"
              value={r2.accountId}
              onChange={(event) => updateR2Field("accountId", event.target.value)}
            />
            <input
              className="stm-input"
              type="text"
              data-stm-field="r2-access-key-id"
              placeholder="Access Key ID"
              value={r2.accessKeyId}
              onChange={(event) => updateR2Field("accessKeyId", event.target.value)}
            />
            <input
              className="stm-input"
              type="password"
              data-stm-field="r2-secret-access-key"
              placeholder="Secret Access Key"
              value={r2.secretAccessKey}
              onChange={(event) => updateR2Field("secretAccessKey", event.target.value)}
            />
            <input
              className="stm-input"
              type="text"
              data-stm-field="r2-bucket"
              placeholder="Bucket"
              value={r2.bucket}
              onChange={(event) => updateR2Field("bucket", event.target.value)}
            />
            <div className="stm-setting-hint">
              四项填齐即自动启用：数据变更防抖推送、空库启动自动拉取、较新版本胜出；Bucket 需配置
              CORS（详见插件文档 R2 云同步配置）
            </div>
            <div className="stm-setting-row">
              <div className="stm-setting-name">状态</div>
              <div className="stm-setting-value" data-stm-field="cloud-sync-status">
                {syncStatusSummary(props.syncStatus)}
              </div>
            </div>
            <div className="stm-setting-row">
              <div className="stm-setting-name">最近同步</div>
              <div className="stm-setting-value stm-mono" data-stm-field="cloud-sync-last">
                {(props.syncStatus.kind === "idle" || props.syncStatus.kind === "error") &&
                props.syncStatus.lastSyncAt
                  ? formatSyncTime(props.syncStatus.lastSyncAt)
                  : "尚未同步"}
              </div>
            </div>
            {props.syncStatus.kind === "error" ? (
              <div className="stm-setting-row">
                <div className="stm-setting-name">失败提示</div>
                <div className="stm-setting-value stm-sync-error" data-stm-field="cloud-sync-error">
                  {props.syncStatus.message}
                </div>
              </div>
            ) : null}
            <div className="stm-setting-actions">
              <button
                type="button"
                className="stm-button"
                data-action="sync-now"
                disabled={!configured}
                onClick={() => void syncNow()}
              >
                立即同步
              </button>
            </div>
            <div className="stm-setting-hint">
              断网或配置错误时这里显示失败提示，插件会按退避自动重试
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
              以下操作会清空当前对话记忆空间的内容，且云同步与对话文件镜像中的副本也会随之清空，操作不可恢复
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
