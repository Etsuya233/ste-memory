/**
 * 面板外壳（ADR 0005：UI 渲染层采用 React，随 esbuild 打进单文件 bundle）。
 *
 * 职责：窗口/安全区/入口几何、Tab 导航、公共上下文（状态订阅、设置、数据版本、
 * 分支检测弹窗）。表格/记录/任务/问答/日志/设置各自在自己的 Tab 模块里实现，
 * 本组件只负责装配与切换。
 *
 * DOM 结构与类名是验收脚本（docs/playwright-st-extension/verify-ui-shell.mjs）的
 * 契约：改动必须同步改脚本。data-action / data-stm-field 属性保留（脚本按它们
 * 定位元素），行为全部走 React 事件。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SteMemoryRuntime } from "../../runtime.ts";
import { PLUGIN_DISPLAY_NAME } from "../../constants.ts";
import {
  DESKTOP_MEDIA_QUERY,
  clampGeometry,
  loadGeometry,
  safeLocalStorage,
  saveGeometry,
  type PanelGeometry,
  type ViewportSize,
} from "./panel-window.ts";
import type { PluginSettings, SettingsStore } from "../../features/settings/plugin-settings.ts";
import type { EntryMountControllerPort } from "./entry-placement.ts";
import type { StRegexEntry } from "../../infrastructure/sillytavern/chat-adapter.ts";
import type { FillTaskService } from "../../features/fill-tasks/fill-task-service.ts";
import type { FillSourceMessage } from "../../features/fill-tasks/fill-task.ts";
import type { QueryChatService } from "../../features/query-chat/query-chat-service.ts";
import type { SpaceMaintenanceService } from "../../features/space-maintenance/space-maintenance-service.ts";
import { QueryChatStore } from "../../features/query-chat/query-chat-state.ts";
import { PANEL_TAB_LABELS, PANEL_TABS, type PanelModel } from "./panel-model.ts";
import { buildSpaceInfo } from "./space-info.ts";
import { RecordsTab, type LeaveGuard } from "../memory/record-view.tsx";
import { TablesTab } from "../memory/tables-tab.tsx";
import { TasksTab } from "../tasks/tasks-tab.tsx";
import { QueryChatTab } from "../query-chat/query-chat-tab.tsx";
import { LogTab } from "../logs/log-tab.tsx";
import { SettingsTab } from "../settings/settings-tab.tsx";
import type { MemoryView } from "../../features/macros/memory-views.ts";
import type { AgentPresetPreviewPorts } from "../../features/agent-presets/preset-preview-model.ts";
import type { MacroOverviewRow } from "../../features/macros/macro-overview-model.ts";

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
  /** 对话文件镜像（ticket 16）：状态订阅 + 设置变化重新评估 */
  readonly mirror: Pick<SteMemoryRuntime["mirror"], "getStatus" | "onStatusChange" | "kick">;
  /** 通用日志（独立数据库，ADR 0015）：日志 Tab 查询（按 Key/最近）+ 清空 */
  readonly logs: Pick<SteMemoryRuntime["logs"], "byKey" | "recent" | "clearAll">;
  /** 记忆宏（ticket 15）：宏名/上限/开关变化即时生效（kick 立即评估） */
  readonly macro: Pick<SteMemoryRuntime["macro"], "kick">;
  /** Agent 预设宏（ticket 17）：插件开关变化即时生效（kick 立即评估） */
  readonly agentMacro: Pick<SteMemoryRuntime["agentMacro"], "kick">;
  /**
   * Agent 预设预览（issue 01）：展开数据点击时即时构建（ST 上下文/digest/世界书扫描）；
   * 预览构建的纯逻辑在 preset-preview-model，组件只接线。
   */
  readonly presetPreview: AgentPresetPreviewPorts;
  /** 宏内容一览（issue 01）：聚合两宏服务预计算快照为展示行（同步读；读时即最新） */
  readonly macroOverview: () => readonly MacroOverviewRow[];
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
    /** 最近 N 条对话消息（ticket 27 清洗测试「从当前对话载入」数据源） */
    readonly readRecentMessages: (count: number) => readonly FillSourceMessage[];
    readonly readChatScopeMacros: () => readonly MemoryView[];
    readonly writeChatScopeMacros: (macros: readonly MemoryView[]) => void;
  };
  readonly settings: SettingsStore;
  /**
   * 面板入口挂载控制器端口（面板入口）：设置分组读当前计划（回退标记）
   * 并在写入入口位置后 replan 热切换。缺省（测试/旧运行时）用默认计划。
   */
  readonly entryMount?: EntryMountControllerPort;
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

/**
 * 魔法棒入口项（底部魔法棒菜单）：镜像 ST 内置工具行结构
 * （div.list-group-item.flex-container.flexGap5 + icon + span，先例：gallery 的
 * addGalleryWandButton），样式随 ST 菜单原生走；挂载/卸载由 st-panel-host 控制器负责。
 */
export function WandEntry(props: {
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
    <div
      className="list-group-item flex-container flexGap5 stm-wand-entry"
      role="button"
      tabIndex={0}
      aria-label={`${PLUGIN_DISPLAY_NAME} 记忆面板`}
      aria-pressed={state.open}
      data-action="toggle-panel"
      onClick={() => {
        if (state.open) {
          const guard = props.leaveGuardRef?.current;
          if (guard && !guard()) return;
        }
        props.model.toggle();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (state.open) {
            const guard = props.leaveGuardRef?.current;
            if (guard && !guard()) return;
          }
          props.model.toggle();
        }
      }}
    >
      <div className="fa-solid fa-book-open extensionsMenuExtensionButton" aria-hidden="true"></div>
      <span>记忆面板</span>
    </div>
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
  const mirrorStatus = useSyncExternalStore(
    (listener) => props.runtime.mirror.onStatusChange(listener),
    () => props.runtime.mirror.getStatus(),
    () => props.runtime.mirror.getStatus(),
  );
  // 设置只经本面板的开关写入（唯一写入口），组件本地 state 即最新值
  const [settings, setSettings] = useState<PluginSettings>(() => props.runtime.settings.read());
  // 日志定位（ADR 0015）：任务面板「日志」跳转到日志 Tab 时携带的目标 runId
  const [logFocusRunId, setLogFocusRunId] = useState<string | null>(null);
  // 问答聊天历史/run 状态的页面内存存储（ticket 20）：挂在面板壳上，跨 Tab 切换存活；
  // 刷新页面即失（决策 4/9：不落 Dexie、不进通用日志）
  const [queryChatStore] = useState(() => new QueryChatStore());

  const info = buildSpaceInfo(status, settings);
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
