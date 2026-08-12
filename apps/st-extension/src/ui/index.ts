/** 面板 UI 出口：纯逻辑模型（可测）+ React 组件层 + DOM 挂载（ST 侧薄层，不测） */
export { PANEL_TAB_LABELS, PANEL_TABS, PanelModel } from "./panel-model.ts";
export type { PanelState, PanelTab } from "./panel-model.ts";
export { FIELD_TYPE_LABELS, buildTableListViewModel } from "./table-list-model.ts";
export type { FieldItemViewModel, TableListItemViewModel } from "./table-list-model.ts";
export {
  SYNC_ERROR_PREFIX,
  SYNC_NOT_CONFIGURED_LABEL,
  SYNC_PENDING_LABEL,
  SYNC_SYNCING_LABEL,
  buildSpaceInfo,
  formatSyncTime,
  mirrorStatusSummary,
  runtimeStatusLabel,
  syncStatusDetail,
  syncStatusSummary,
} from "./space-info.ts";
export type { SpaceInfoViewModel } from "./space-info.ts";
export { PanelShell, ToolbarButton } from "./panel-shell.tsx";
export type { PanelRuntime } from "./panel-shell.tsx";
export { TasksTab } from "./tasks-tab.tsx";
export type { TasksTabRuntime } from "./tasks-tab.tsx";
export { LogTab } from "./log-tab.tsx";
export type { LogTabRuntime } from "./log-tab.tsx";
export {
  applyLogFilters,
  buildLogListViewModel,
  defaultLogFilters,
  LOG_LEVEL_LABELS,
  logEntrySummary,
  logQueryKind,
} from "./log-panel-model.ts";
export type { LogListItemViewModel, LogPanelFilters } from "./log-panel-model.ts";
export {
  buildCoverageViewModel,
  buildTasksTabViewModel,
  COVERAGE_STATUS_LABELS,
  taskStatusViewModel,
  unprocessedRanges,
  validateFloorRange,
} from "./task-panel-model.ts";
export type {
  CoverageRun,
  CoverageStatus,
  CoverageViewModel,
  FloorRange,
  FloorRangeValidation,
  TaskHistoryItemViewModel,
  TasksTabViewModel,
} from "./task-panel-model.ts";
export { mountPanel } from "./st-panel-host.tsx";
