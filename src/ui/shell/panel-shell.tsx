import { Tabs } from "./tabs.tsx";
import { PageHeaderActions, PageLayout } from "./page-layout.tsx";
import { PanelBar, PanelBarAction } from "./panel-bar.tsx";
import { useAppearance } from "./appearance-settings.tsx";
import { presentAppearance } from "./appearance-model.ts";
import { MemoryRecallPanel } from "../retrieval/memory-recall-panel.tsx";
import { RetrievalTab } from "../retrieval/retrieval-tab.tsx";
import { SqlPanel } from "../retrieval/sql-panel.tsx";
import type { MemoryTableId, MemoryRecordId } from "../../features/memory/index.ts";
import type { VectorRetrievalService } from "../../features/vector-retrieval/vector-retrieval-service.ts";
import { chatIdentityKey } from "../../features/chat-binding/chat-space-manager.ts";
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
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import type { SteMemoryRuntime } from "../../runtime.ts";
import type { SettingsService } from "../../features/settings/settings-service.ts";
import { PLUGIN_DISPLAY_NAME } from "../../constants.ts";
import {
  DESKTOP_MEDIA_QUERY,
  clampGeometry,
  loadGeometry,
  shouldDockNavigation,
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
import type { TablePresetApplyService } from "../../features/table-presets/table-preset-apply-service.ts";
import { QueryChatStore } from "../../features/query-chat/query-chat-state.ts";
import { PANEL_TAB_LABELS, type PanelModel } from "./panel-model.ts";
import { buildSpaceInfo } from "./space-info.ts";
import { RecordsTab, type LeaveGuard } from "../memory/record-view.tsx";
import { TablesTab } from "../memory/tables-tab.tsx";
import { TasksTab } from "../tasks/tasks-tab.tsx";
import { VectorTasks } from "../tasks/vector-tasks.tsx";
import type { VectorIndexService } from "../../features/vector-index/vector-index-service.ts";
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
  readonly sqlConsole: SteMemoryRuntime["sqlConsole"];
  readonly memoryRecall?: SteMemoryRuntime["memoryRecall"];
  readonly vector: VectorIndexService;
  readonly retrieval: Pick<
    VectorRetrievalService,
    "getState" | "subscribe" | "ranges" | "search" | "cancel"
  >;
  readonly spaces: Pick<SteMemoryRuntime["spaces"], "list">;
  readonly autoFill?: SteMemoryRuntime["autoFill"];
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
  readonly mirror: Pick<
    SteMemoryRuntime["mirror"],
    "getStatus" | "onStatusChange" | "kick" | "flushRebuiltSpace"
  >;
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
    | "retryStates"
    | "submit"
    | "submitInit"
    | "cancel"
    | "retry"
    | "activeTask"
    | "pendingTasks"
    | "recentTasks"
    | "ledgerStatuses"
    | "markFloorStatuses"
  >;
  /** 空间维护（spec reset-space）：清除空间记录（设置 Tab 危险操作区） */
  readonly spaceMaintenance: Pick<SpaceMaintenanceService, "clearRecords">;
  /** 表格预设应用（spec table-presets）：停止写入 + 当前空间应用预设（原子重建） */
  readonly presetApply: Pick<
    TablePresetApplyService,
    "stopSpaceWrites" | "applyPreset" | "assertCurrentChat"
  >;
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
  readonly settingsService: SettingsService;
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

/** 媒体查询订阅（SSR 首屏按窄屏处理，浏览器挂载后立即校正）。 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(query).matches === true,
  );
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
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
  // 提醒点击后预填范围；聊天切换后清除，避免带入其他对话。
  const [autoFillFocus, setAutoFillFocus] = useState<{ from: number; to: number; key: number }>();
  useEffect(() => {
    setAutoFillFocus(undefined);
  }, [status]);
  // 日志定位（ADR 0015）：任务面板「日志」跳转到日志 Tab 时携带的目标 runId
  const [logFocusRunId, setLogFocusRunId] = useState<string | null>(null);
  // 问答聊天历史/run 状态的页面内存存储（ticket 20）：挂在面板壳上，跨 Tab 切换存活；
  // 刷新页面即失（决策 4/9：不落 Dexie、不进通用日志）
  const [recordFocus, setRecordFocus] = useState<{
    tableId: MemoryTableId;
    recordId: MemoryRecordId;
  } | null>(null);
  useEffect(() => {
    setRecordFocus(null);
  }, [status?.kind === "active" ? status.space.id : null]);
  const [queryChatStore] = useState(() => new QueryChatStore());

  const appearance = useAppearance();
  const presentation = presentAppearance(appearance);
  // 视口断点仅用于「面板尚未显示、还量不到自身宽度」时的初值。
  const isDesktopViewport = useMediaQuery(DESKTOP_MEDIA_QUERY);
  const [panelWide, setPanelWide] = useState<boolean | null>(() => {
    if (typeof window === "undefined") return null;
    const savedWidth = loadGeometry(safeLocalStorage())?.width;
    return savedWidth === undefined ? null : shouldDockNavigation(savedWidth);
  });
  // 宽面板：导航固定在左侧；窄面板：收起为覆盖内容的抽屉。
  const [navDocked, setNavDocked] = useState(true);
  const [navOpen, setNavOpen] = useState(false);
  const isWidePanel = panelWide ?? isDesktopViewport;
  const navVisible = isWidePanel ? navDocked : navOpen;
  const [taskKind, setTaskKind] = useState<"fill" | "vector">("fill");
  const [retrievalMode, setRetrievalMode] = useState<"vector" | "sql">("vector");
  const navRef = useRef<HTMLElement | null>(null);
  const navTriggerRef = useRef<HTMLButtonElement | null>(null);
  const navWasOpen = useRef(false);
  useEffect(() => {
    // 常驻导航不抢占焦点；只有窄面板的覆盖式抽屉需要把焦点送入第一个 Tab。
    if (navOpen && !isWidePanel)
      navRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    else if (navWasOpen.current) navTriggerRef.current?.focus();
    navWasOpen.current = navOpen && !isWidePanel;
  }, [navOpen, isWidePanel]);
  useEffect(() => {
    // 从抽屉宽度拉宽成常驻布局时，关闭遗留的 drawer 状态，避免再拉窄时意外弹开。
    if (isWidePanel) setNavOpen(false);
  }, [isWidePanel]);
  function closeNavigation(): void {
    if (isWidePanel) setNavDocked(false);
    else setNavOpen(false);
  }
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

  // 导航是否常驻跟随面板自身宽度（桌面窗口可被缩到手机大小）；窗口隐藏时忽略 0 宽读数。
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") return;
    const measure = (): void => {
      const width = panel.getBoundingClientRect().width;
      if (width <= 0) return;
      const next = shouldDockNavigation(width);
      setPanelWide((current) => (current === next ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  // ST 的 html 带 transform；顶层浮层让 fixed 几何始终以视口为准。
  // manual 保留点击外部不收起的行为，开关仍由 PanelModel 管理。
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.togglePopover(state.open);
    return () => panel.hidePopover();
  }, [state.open]);

  // 当前 Tab 的离开守卫（页面编辑器注册、卸载时注销）
  const internalGuardRef = useRef<LeaveGuard | null>(null);
  const guardRef = props.leaveGuardRef ?? internalGuardRef;
  const registerLeaveGuard = useCallback(
    (guard: LeaveGuard | null) => {
      guardRef.current = guard;
    },
    [guardRef],
  );
  function confirmLeaveTab(): boolean {
    if (state.tab !== "records" && state.tab !== "settings" && state.tab !== "tables") return true;
    const guard = guardRef.current;
    return guard ? guard() : true;
  }
  useEffect(() => {
    const handler = (event: Event) => {
      const notice = (event as CustomEvent<{ identity: string; kind: string }>).detail;
      if (
        !props.runtime.adapter ||
        chatIdentityKey(props.runtime.adapter.getChatSnapshot()) !== notice.identity
      ) {
        reportError(new Error("请回到通知所属对话查看任务"));
        return;
      }
      if (!confirmLeaveTab()) return;
      setTaskKind("fill");
      props.model.setTab("tasks");
      props.model.open();
      if (notice.kind === "reminder")
        void props.runtime.autoFill
          ?.range()
          .then((range) => {
            if (
              range &&
              props.runtime.adapter &&
              chatIdentityKey(props.runtime.adapter.getChatSnapshot()) === notice.identity
            )
              setAutoFillFocus({ ...range, key: Date.now() });
          })
          .catch(reportError);
    };
    document.addEventListener("ste-memory:open-tasks", handler);
    return () => document.removeEventListener("ste-memory:open-tasks", handler);
  }, [props.runtime, props.model, state.tab]);
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

  // 挂载、视口缩放与跨入桌面断点时，将保存的窗口几何限制在当前视口内。
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
    window.addEventListener("resize", applySaved);
    return () => {
      media.removeEventListener("change", applySaved);
      window.removeEventListener("resize", applySaved);
    };
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
      data-style={appearance.style}
      data-tone={presentation.tone}
      data-theme={appearance.theme}
      data-accent={appearance.accent}
      data-font={appearance.font}
      data-size={appearance.size}
      data-nav-docked={isWidePanel ? navDocked : undefined}
      data-nav-open={navOpen}
      style={presentation.variables as CSSProperties}
      onKeyDown={(event) => {
        if (!navVisible) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeNavigation();
        }
        if (event.key === "Tab" && navOpen && !isWidePanel) {
          const buttons = navRef.current!.querySelectorAll<HTMLButtonElement>("button");
          const first = buttons[0]!;
          const last = buttons[buttons.length - 1]!;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }}
      ref={panelRef}
      popover="manual"
      className={state.open ? "stm-panel stm-panel--open" : "stm-panel"}
      aria-hidden={!state.open}
    >
      {navOpen && !isWidePanel && (
        <button
          type="button"
          className="stm-drawer-scrim"
          aria-label="关闭导航"
          tabIndex={-1}
          onClick={closeNavigation}
        />
      )}
      <nav
        id="stm-navigation"
        ref={navRef}
        className="stm-navigation"
        data-open={navVisible}
        inert={!navVisible}
        aria-hidden={!navVisible}
        aria-label="记忆面板导航"
      >
        <div className="stm-navigation-heading">
          <span>{PLUGIN_DISPLAY_NAME}</span>
          <button
            type="button"
            className="stm-header-nav"
            aria-label="收起导航"
            onClick={closeNavigation}
          >
            <i className="fa-solid fa-xmark" aria-hidden="true" />
          </button>
        </div>
        <div className="stm-navigation-context">
          <strong>{info.title}</strong>
          {info.detail && <span>{info.detail}</span>}
        </div>
        {[
          { label: "日常使用", tabs: ["records", "retrieval", "query", "tasks"] as const },
          { label: "管理", tabs: ["tables", "settings", "logs"] as const },
        ].map((group) => (
          <div className="stm-navigation-group" key={group.label}>
            <div className="stm-section-label">{group.label}</div>
            <div role="tablist" aria-label={group.label}>
              {group.tabs.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  className="stm-tab"
                  role="tab"
                  data-tab={tab}
                  data-action="tab"
                  aria-selected={tab === state.tab}
                  onClick={() => {
                    if (tab !== state.tab && !confirmLeaveTab()) return;
                    props.model.setTab(tab);
                    if (!isWidePanel) setNavOpen(false);
                  }}
                >
                  <i
                    className={
                      "fa-solid " +
                      {
                        records: "fa-book-open",
                        retrieval: "fa-magnifying-glass",
                        query: "fa-comment",
                        tasks: "fa-list-check",
                        tables: "fa-table",
                        settings: "fa-sliders",
                        logs: "fa-clock-rotate-left",
                      }[tab]
                    }
                    aria-hidden="true"
                  />
                  <span>{PANEL_TAB_LABELS[tab]}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <PageLayout
        header={
          <PanelBar
            dataAction="drag-panel"
            onPointerDown={beginHeaderDrag}
            inert={navOpen && !isWidePanel}
            title={PANEL_TAB_LABELS[state.tab]}
            subtitle={
              <span
                className="stm-space-title"
                title={[info.title, info.detail].filter(Boolean).join(" · ")}
              >
                {info.title}
              </span>
            }
            leading={
              <PanelBarAction
                icon="fa-bars"
                label={navVisible ? "收起导航" : "显示导航"}
                ref={navTriggerRef}
                aria-expanded={navVisible}
                aria-controls="stm-navigation"
                data-action="open-navigation"
                data-active={navVisible ? "true" : undefined}
                onClick={() => {
                  if (isWidePanel) setNavDocked((docked) => !docked);
                  else setNavOpen((open) => !open);
                }}
              />
            }
            trailing={
              <>
                <PageHeaderActions />
                <PanelBarAction
                  icon="fa-xmark"
                  label="收起面板"
                  data-action="close-panel"
                  onClick={() => {
                    if (!confirmLeaveTab()) return;
                    props.model.close();
                  }}
                />
              </>
            }
          />
        }
        contentClassName="stm-panel-body"
        contentAs="main"
        inert={navOpen && !isWidePanel}
      >
        {info.tone === "warning" && (
          <div className="stm-context-warning" role="status">
            {info.detail || info.title}
          </div>
        )}
        {state.tab === "tables" && (
          <section className="stm-tab-section" data-stm-section="tables" role="tabpanel">
            <TablesTab
              registerLeaveGuard={registerLeaveGuard}
              vector={props.runtime.vector}
              tables={props.runtime.tables}
              fields={props.runtime.fields}
              records={props.runtime.records}
              macro={props.runtime.macro}
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
              focusRecord={recordFocus}
              onFocusConsumed={() => setRecordFocus(null)}
              status={status}
              settings={settings}
              dataVersion={dataVersion}
              registerLeaveGuard={registerLeaveGuard}
            />
          </section>
        )}
        {state.tab === "tasks" && (
          <section className="stm-tab-section" data-stm-section="tasks" role="tabpanel">
            <Tabs
              label="任务类型"
              className="stm-task-kind"
              value={taskKind}
              options={[
                {
                  value: "fill",
                  label: "填表任务",
                  panelId: "stm-fill-tasks",
                  dataAction: "task-kind-fill",
                },
                {
                  value: "vector",
                  label: "向量任务",
                  panelId: "stm-vector-tasks",
                  dataAction: "task-kind-vector",
                },
              ]}
              onChange={(kind) => {
                setTaskKind(kind);
                panelRef.current!.querySelector(".stm-panel-body")!.scrollTop = 0;
              }}
            />
            <div
              id="stm-fill-tasks"
              role="tabpanel"
              aria-label="填表任务"
              hidden={taskKind !== "fill"}
            >
              <TasksTab
                autoFillFocus={autoFillFocus}
                active={taskKind === "fill"}
                runtime={props.runtime}
                status={status}
                settings={settings}
                onSettingsChange={setSettings}
                onViewLogs={(runId) => {
                  setLogFocusRunId(runId);
                  props.model.setTab("logs");
                }}
              />
            </div>
            <div
              id="stm-vector-tasks"
              role="tabpanel"
              aria-label="向量任务"
              hidden={taskKind !== "vector"}
            >
              <VectorTasks
                active={taskKind === "vector"}
                vector={props.runtime.vector}
                spaces={props.runtime.spaces}
                tables={props.runtime.tables}
                currentSpaceId={status?.kind === "active" ? status.space.id : undefined}
              />
            </div>
          </section>
        )}
        <section
          hidden={state.tab !== "retrieval"}
          className="stm-tab-section"
          data-stm-section="retrieval"
          role="tabpanel"
        >
          <Tabs
            label="检索方式"
            value={retrievalMode}
            onChange={setRetrievalMode}
            options={[
              { value: "vector", label: "向量", panelId: "stm-retrieval-vector" },
              { value: "sql", label: "SQL", panelId: "stm-retrieval-sql" },
            ]}
          />
          <div
            id="stm-retrieval-vector"
            role="tabpanel"
            aria-label="向量"
            hidden={retrievalMode !== "vector"}
          >
            <RetrievalTab
              active={state.tab === "retrieval" && retrievalMode === "vector"}
              key={props.runtime.retrieval.getState().epoch}
              service={props.runtime.retrieval}
              connection={settings.embeddingConnection}
              spaceId={status?.kind === "active" ? status.space.id : null}
              onRecord={(tableId, recordId) => {
                setRecordFocus({ tableId, recordId });
                props.model.setTab("records");
              }}
              onIndex={() => props.model.setTab("tables")}
              onSettings={() => props.model.setTab("settings")}
            />

            {props.runtime.memoryRecall && (
              <MemoryRecallPanel
                service={props.runtime.memoryRecall}
                onRecord={(tableId, recordId) => {
                  setRecordFocus({ tableId, recordId });
                  props.model.setTab("records");
                }}
              />
            )}
          </div>
          <div
            id="stm-retrieval-sql"
            role="tabpanel"
            aria-label="SQL"
            hidden={retrievalMode !== "sql"}
          >
            <SqlPanel
              key={props.runtime.retrieval.getState().epoch}
              console={props.runtime.sqlConsole}
              active={state.tab === "retrieval" && retrievalMode === "sql"}
              spaceId={status?.kind === "active" ? status.space.id : null}
              dataVersion={dataVersion}
              onExecuted={() => setDataVersion((version) => version + 1)}
            />
          </div>
        </section>
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
              registerLeaveGuard={registerLeaveGuard}
              settingsService={props.runtime.settingsService}
              tables={props.runtime.tables}
              fields={props.runtime.fields}
              manager={props.runtime.manager}
              backup={props.runtime.backup}
              mirror={props.runtime.mirror}
              macro={props.runtime.macro}
              spaceMaintenance={props.runtime.spaceMaintenance}
              presetApply={props.runtime.presetApply}
              cleaning={props.runtime.cleaning}
              presetPreview={props.runtime.presetPreview}
              macroOverview={props.runtime.macroOverview}
              entryMount={props.runtime.entryMount}
              version={props.runtime.version}
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
      </PageLayout>
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
