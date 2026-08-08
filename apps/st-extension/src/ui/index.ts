/** 面板 UI 出口：纯逻辑模型（可测）+ DOM 宿主（ST 侧薄层，不测） */
export { PANEL_TAB_LABELS, PANEL_TABS, PanelModel } from "./panel-model.ts";
export type { PanelState, PanelTab } from "./panel-model.ts";
export { FIELD_TYPE_LABELS, buildTableListViewModel } from "./table-list-model.ts";
export type { FieldItemViewModel, TableListItemViewModel } from "./table-list-model.ts";
export {
  SYNC_CONFIGURED_LABEL,
  SYNC_NOT_CONFIGURED_LABEL,
  buildSpaceInfo,
  runtimeStatusLabel,
  syncStatusLabel,
} from "./space-info.ts";
export type { SpaceInfoViewModel } from "./space-info.ts";
export { mountPanel } from "./st-panel-host.ts";
