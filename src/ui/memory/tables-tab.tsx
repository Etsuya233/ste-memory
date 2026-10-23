import { EditorDialog } from "../shell/editor-dialog.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MemoryField,
  MemoryFieldId,
  MemoryRecord,
  MemoryRecordPayload,
  MemoryTable,
  MemoryTableDisplayStrategy,
  MemoryTableId,
} from "../../features/memory/index.ts";
import type { SpaceContextStatus } from "../../features/chat-binding/chat-space-manager.ts";
import type { PluginSettings } from "../../features/settings/plugin-settings.ts";
import {
  Placeholder,
  activeStatus,
  reportError,
  reportSuccess,
  reportWarning,
} from "../shell/ui-helpers.tsx";
import { buildTableListViewModel, type TableListItemViewModel } from "./table-list-model.ts";
import { FieldEditorForm, TableEditorForm } from "./table-editor.tsx";
import { EMPTY_TABLE_DRAFT, type TableDraft } from "./table-editor-model.ts";
import {
  displayStrategyDependentFieldIds,
  displayStrategySummary,
  emptyDisplayStrategyDraft,
} from "./display-strategy-model.ts";
import { DisplayStrategyEditor } from "./display-strategy-editor.tsx";
import { VectorIndexEditor } from "./vector-index-editor.tsx";
import { TableVectorActions } from "./table-vector-actions.tsx";
import type { VectorIndexService } from "../../features/vector-index/vector-index-service.ts";
import { listTablePresets } from "../../features/table-presets/preset-model.ts";
import { SYSTEM_TABLE_PRESET } from "../../features/table-presets/system-preset.ts";
import type { VectorIndexConfiguration } from "../../features/memory/index.ts";
import { PanelBar, PanelBarAction } from "../shell/panel-bar.tsx";
import {
  emptyFieldDraft,
  fieldDraftFromField,
  fieldTypeNeedsOptions,
  parseOptionsText,
  swapAdjacentFieldPositions,
  type FieldDraft,
} from "./field-editor-model.ts";
import type {
  MemoryFieldService,
  MemoryRecordService,
  MemoryTableService,
} from "../../features/memory/index.ts";
import type { MemoryMacroService } from "../../features/macros/memory-macro-service.ts";

// ---- 表格列表 Tab（ticket 09：建表 + 表格编辑/删除 + 字段定义编辑器） ----

type FieldEditorState =
  | { readonly mode: "create"; readonly tableId: MemoryTableId }
  | {
      readonly mode: "edit";
      readonly tableId: MemoryTableId;
      readonly fieldId: MemoryFieldId;
    }
  | null;

export function TablesTab(props: {
  readonly vector: VectorIndexService;
  readonly tables: Pick<MemoryTableService, "list" | "update" | "create" | "delete">;
  readonly fields: Pick<
    MemoryFieldService,
    "list" | "update" | "create" | "delete" | "setDisplayStrategy"
  >;
  readonly records: Pick<MemoryRecordService, "list" | "previewDisplayText">;
  readonly macro: Pick<MemoryMacroService, "kick">;
  readonly status: SpaceContextStatus | undefined;
  readonly settings: PluginSettings;
  /** 整库数据版本（导入备份后自增，驱动重取） */
  readonly dataVersion: number;
  /** 手机表格详情打开时通知面板壳隐藏一级顶栏 */
  readonly onDetailOpenChange?: (open: boolean) => void;
}) {
  const [selectedTableId, setSelectedTableId] = useState<MemoryTableId | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const [detailTab, setDetailTab] = useState<"fields" | "info" | "strategy" | "vector">("fields");
  const [sortingTableId, setSortingTableId] = useState<MemoryTableId | null>(null);
  const [search, setSearch] = useState("");
  const [tables, setTables] = useState<readonly TableListItemViewModel[] | undefined>(undefined);
  // 原始表/字段数据（编辑器需要 prompt、position、options 等视图模型未携带的字段）
  const [rawTables, setRawTables] = useState<readonly MemoryTable[] | undefined>(undefined);
  const [fieldsByTable, setFieldsByTable] = useState<
    ReadonlyMap<MemoryTableId, readonly MemoryField[]>
  >(new Map());
  // 变更后重新拉取（Dexie 是事实源；重渲染永远基于最新数据）
  const [reloadKey, setReloadKey] = useState(0);
  // 编辑器状态：建表 / 字段编辑器
  const [creatingTable, setCreatingTable] = useState(false);
  const [fieldEditor, setFieldEditor] = useState<FieldEditorState>(null);
  // 显示策略预览（ticket 10）：预览记录/加载错误/保存中
  const [strategyPreviewRecords, setStrategyPreviewRecords] = useState<readonly MemoryRecord[]>([]);
  const [strategyPreviewError, setStrategyPreviewError] = useState<string | null>(null);
  const [strategySaving, setStrategySaving] = useState(false);
  const [vectorSaving, setVectorSaving] = useState(false);
  // 打开中的策略预览表（异步加载预览记录的竞态守卫：快速切换/关闭后丢弃过期结果）
  const strategyEditorTableRef = useRef<MemoryTableId | null>(null);

  const active = activeStatus(props.status);
  const spaceId = active?.space.id;

  // 显示策略预览计算：Memory previewDisplayText 绑定当前空间/表（只读，不落库）
  const computePreview = useCallback(
    (strategy: MemoryTableDisplayStrategy, payload: MemoryRecordPayload) => {
      if (!spaceId || !selectedTableId) return Promise.resolve("");
      return props.records.previewDisplayText(spaceId, selectedTableId, strategy, payload);
    },
    [props.records, spaceId, selectedTableId],
  );

  useEffect(() => {
    if (!spaceId) {
      setTables(undefined);
      setRawTables(undefined);
      setFieldsByTable(new Map());
      setSelectedTableId(null);
      setMobileView("list");
      setDetailTab("fields");
      strategyEditorTableRef.current = null;
      setStrategyPreviewRecords([]);
      setStrategyPreviewError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = await props.tables.list(spaceId);
        const fieldLists = await Promise.all(
          list.map((table) => props.fields.list(spaceId, table.id)),
        );
        if (cancelled) return;
        const fieldsByTable = new Map(list.map((table, index) => [table.id, fieldLists[index]!]));
        const viewModel = buildTableListViewModel(list, fieldsByTable);
        // 切空间后旧表格 id 失效，回退到第一张表
        const validIds = new Set(viewModel.map((table) => table.id));
        setRawTables(list);
        setFieldsByTable(fieldsByTable);
        setTables(viewModel);
        setSelectedTableId((prev) =>
          prev && validIds.has(prev) ? prev : (viewModel[0]?.id ?? null),
        );
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
      } catch (error) {
        if (!cancelled) reportError(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.tables, props.fields, spaceId, reloadKey, props.dataVersion]);

  useEffect(() => {
    props.onDetailOpenChange?.(mobileView === "detail");
    return () => props.onDetailOpenChange?.(false);
  }, [mobileView, props.onDetailOpenChange]);

  useEffect(() => {
    setSortingTableId(null);
    setFieldEditor(null);
  }, [selectedTableId]);

  if (!props.settings.enabled) {
    return (
      <div className="stm-tables-message">
        <Placeholder title="插件已停用" hint="在设置中重新启用后恢复表格展示与同步" />
      </div>
    );
  }
  if (!active) {
    return (
      <div className="stm-tables-message">
        <Placeholder
          title={
            props.status &&
            props.status.kind !== "active" &&
            props.status.kind !== "branch-detected"
              ? props.status.humanMsg
              : "正在加载…"
          }
          hint="切换到已保存的对话后自动恢复"
        />
      </div>
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
    void props.macro.kick().catch(reportError);
  }

  async function toggleTable(tableId: MemoryTableId, enabled: boolean): Promise<void> {
    try {
      await props.tables.update(currentSpaceId, tableId, { enabled });
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
      const result = await props.fields.update(currentSpaceId, tableId, fieldId, {
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

  function selectTable(tableId: MemoryTableId): void {
    setSelectedTableId(tableId);
    setDetailTab("fields");
    setSortingTableId(null);
    setMobileView("detail");
  }

  function backToList(): void {
    setMobileView("list");
  }

  /** 打开字段编辑器；详情已经承载入口，不再需要展开卡片 */
  function openFieldEditor(state: Exclude<FieldEditorState, null>): void {
    setFieldEditor(state);
  }

  async function createTable(draft: TableDraft): Promise<void> {
    const positions = (rawTables ?? []).map((table) => table.position);
    const position = positions.length === 0 ? 0 : Math.max(...positions) + 1;
    try {
      const created = await props.tables.create(currentSpaceId, {
        key: draft.key,
        position,
        name: draft.name,
        description: draft.description,
        prompt: draft.prompt,
      });
      if (created) {
        setSelectedTableId(created.id);
        setDetailTab("fields");
        setSortingTableId(null);
        setMobileView("detail");
        setCreatingTable(false);
      }
    } catch (error) {
      reportError(error);
    }
    bumpData();
  }

  async function saveTableEdit(tableId: MemoryTableId, draft: TableDraft): Promise<void> {
    try {
      await props.tables.update(currentSpaceId, tableId, {
        key: draft.key,
        name: draft.name,
        description: draft.description,
        prompt: draft.prompt,
      });
      reportSuccess("表格信息已保存");
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
      await props.tables.delete(currentSpaceId, tableId);
    } catch (error) {
      reportError(error);
    }
    setSelectedTableId(null);
    setMobileView("list");
    setDetailTab("fields");
    setSortingTableId(null);
    setFieldEditor(null);
    strategyEditorTableRef.current = null;
    setStrategyPreviewRecords([]);
    setStrategyPreviewError(null);
    bumpData();
  }

  async function createField(tableId: MemoryTableId, draft: FieldDraft): Promise<void> {
    const fields = fieldsByTable.get(tableId) ?? [];
    const position = fields.length === 0 ? 0 : fields[fields.length - 1]!.position + 1;
    try {
      await props.fields.create(currentSpaceId, tableId, {
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
      const result = await props.fields.update(currentSpaceId, tableId, fieldId, {
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
      await props.fields.delete(currentSpaceId, tableId, fieldId);
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
        await props.fields.update(currentSpaceId, tableId, change.id, {
          position: change.position,
        });
      }
    } catch (error) {
      reportError(error);
    }
    bumpData();
  }

  function toggleFieldEditMode(tableId: MemoryTableId): void {
    setSortingTableId((prev) => (prev === tableId ? null : tableId));
  }

  /** 打开显示策略页：切到该表并加载现有记录（最多 5 条）供预览 */
  async function openStrategyEditor(tableId: MemoryTableId): Promise<void> {
    setSelectedTableId(tableId);
    setDetailTab("strategy");
    setSortingTableId(null);
    setMobileView("detail");
    strategyEditorTableRef.current = tableId;
    setStrategyPreviewRecords([]);
    setStrategyPreviewError(null);
    try {
      const page = await props.records.list(currentSpaceId, tableId, {
        page: 1,
        pageSize: 5,
      });
      // 期间已切换/关闭编辑器：丢弃过期结果
      if (strategyEditorTableRef.current !== tableId) return;
      setStrategyPreviewRecords(page?.records ?? []);
    } catch {
      // 记录含已删除字段的孤儿值等场景 Memory 校验会拒绝列表读取：预览降级为提示
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
      await props.fields.setDisplayStrategy(currentSpaceId, tableId, strategy);
      reportSuccess("显示策略已保存");
    } catch (error) {
      reportError(error);
    } finally {
      setStrategySaving(false);
    }
    bumpData();
  }

  function closeStrategyEditor(): void {
    setDetailTab("fields");
  }

  const query = search.trim().toLowerCase();
  const filteredTables = query
    ? tables.filter((table) =>
        `${table.name} ${table.key} ${table.description}`.toLowerCase().includes(query),
      )
    : tables;
  const selectedTable = selectedTableId
    ? (tables.find((table) => table.id === selectedTableId) ?? null)
    : null;
  const selectedRawTable = selectedTable
    ? (rawTables.find((table) => table.id === selectedTable.id) ?? null)
    : null;
  const selectedFields = selectedTableId ? (fieldsByTable.get(selectedTableId) ?? []) : [];
  const selectedDependentFieldIds = selectedRawTable
    ? displayStrategyDependentFieldIds(selectedRawTable.displayStrategy)
    : new Set<MemoryFieldId>();
  const sorting = selectedTableId !== null && sortingTableId === selectedTableId;
  const totalFields = selectedTable?.fields.length ?? 0;
  const enabledFields = selectedTable?.enabledFieldCount ?? 0;
  const fieldStatus =
    totalFields > 0 && enabledFields === totalFields ? "全部启用" : `已启用 ${enabledFields}`;
  const detailOpen = mobileView === "detail" && selectedTable !== null;

  const fieldEditorFields = fieldEditor ? (fieldsByTable.get(fieldEditor.tableId) ?? []) : [];
  const editingField =
    fieldEditor?.mode === "edit"
      ? (fieldEditorFields.find((field) => field.id === fieldEditor.fieldId) ?? null)
      : null;
  const fieldEditorInitial =
    fieldEditor?.mode === "create"
      ? emptyFieldDraft("short_text")
      : editingField
        ? fieldDraftFromField(editingField)
        : null;

  return (
    <div className={`stm-tables-workbench${detailOpen ? " stm-tables-workbench--detail" : ""}`}>
      <aside className="stm-table-rail">
        <div className="stm-table-rail-head">
          <div className="stm-table-rail-title-row">
            <span className="stm-table-rail-title">{tables.length} 张表</span>
            <button
              type="button"
              className="stm-button"
              data-action="create-table"
              onClick={() => setCreatingTable(true)}
            >
              <i className="fa-solid fa-plus" aria-hidden="true"></i>
              新建
            </button>
          </div>
          <div className="stm-table-search">
            <i className="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
            <input
              className="stm-input"
              type="search"
              value={search}
              placeholder="搜索表格或 Key"
              aria-label="搜索表格"
              data-stm-field="table-search"
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </div>
        <div className="stm-table-rail-list">
          {filteredTables.map((table) => {
            const active = table.id === selectedTableId;
            return (
              <button
                key={table.id}
                type="button"
                className={`stm-table-rail-row${active ? " is-active" : ""}${
                  table.enabled ? "" : " is-off"
                }`}
                data-action="expand-table"
                data-table-id={table.id}
                aria-expanded={active}
                onClick={() => selectTable(table.id)}
              >
                <span className="stm-table-glyph" aria-hidden="true">
                  {table.name.slice(0, 1) || "表"}
                </span>
                <span className="stm-table-rail-main">
                  <span className="stm-table-rail-name">{table.name}</span>
                  <span className="stm-table-rail-meta">{table.fields.length} 字段</span>
                </span>
                <span
                  className={`stm-status-dot${table.enabled ? "" : " stm-status-dot--off"}`}
                  aria-hidden="true"
                ></span>
              </button>
            );
          })}
          {filteredTables.length === 0 ? (
            <div className="stm-table-rail-empty">
              {tables.length === 0 ? "还没有记忆表格" : `没有匹配「${search}」的表格`}
            </div>
          ) : null}
        </div>
      </aside>

      {selectedTable && selectedRawTable ? (
        <section className="stm-table-detail-screen">
          {mobileView === "detail" ? (
            <PanelBar
              variant="detail"
              leading={
                <PanelBarAction
                  icon="fa-chevron-left"
                  label="返回表格索引"
                  data-action="back-to-table-list"
                  onClick={backToList}
                />
              }
              title={selectedTable.name}
              subtitle={selectedTable.key}
              trailing={
                <label
                  className="stm-switch"
                  title={`${selectedTable.enabled ? "停用" : "启用"} ${selectedTable.name}`}
                >
                  <input
                    type="checkbox"
                    data-action="toggle-table"
                    data-table-id={selectedTable.id}
                    checked={selectedTable.enabled}
                    aria-label={`启用 ${selectedTable.name}`}
                    onChange={(event) => void toggleTable(selectedTable.id, event.target.checked)}
                  />
                  <span className="stm-switch-track" aria-hidden="true"></span>
                </label>
              }
            />
          ) : null}

          <div className="stm-table-detail-scroll">
            <div className="stm-table-detail-head">
              <div className="stm-table-detail-title-row">
                <span className="stm-table-glyph stm-table-glyph--lg" aria-hidden="true">
                  {selectedTable.name.slice(0, 1) || "表"}
                </span>
                <div className="stm-table-detail-title">
                  <div className="stm-table-detail-name">{selectedTable.name}</div>
                  <div className="stm-table-detail-key">{selectedTable.key}</div>
                </div>
                <label
                  className="stm-switch"
                  title={`${selectedTable.enabled ? "停用" : "启用"} ${selectedTable.name}`}
                >
                  <input
                    type="checkbox"
                    data-action="toggle-table"
                    data-table-id={selectedTable.id}
                    checked={selectedTable.enabled}
                    aria-label={`启用 ${selectedTable.name}`}
                    onChange={(event) => void toggleTable(selectedTable.id, event.target.checked)}
                  />
                  <span className="stm-switch-track" aria-hidden="true"></span>
                </label>
              </div>
              {selectedTable.description ? (
                <div className="stm-table-detail-desc">{selectedTable.description}</div>
              ) : null}
              <div className="stm-table-detail-meta">
                {selectedTable.enabled ? null : <span className="stm-badge">已停用</span>}
                <span>
                  {displayStrategySummary(selectedRawTable.displayStrategy, selectedFields)}
                </span>
              </div>
            </div>

            <div className="stm-table-tabs" role="tablist" aria-label="表格详情">
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === "fields"}
                data-action="set-table-tab"
                data-tab="fields"
                data-table-id={selectedTable.id}
                onClick={() => {
                  setDetailTab("fields");
                  setSortingTableId(null);
                }}
              >
                字段 {totalFields}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === "info"}
                data-action="edit-table"
                data-tab="info"
                data-table-id={selectedTable.id}
                onClick={() => {
                  setDetailTab("info");
                  setSortingTableId(null);
                }}
              >
                表格信息
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === "strategy"}
                data-action="edit-display-strategy"
                data-table-id={selectedTable.id}
                onClick={() => void openStrategyEditor(selectedTable.id)}
              >
                显示策略
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === "vector"}
                data-action="edit-vector-index"
                data-table-id={selectedTable.id}
                onClick={() => setDetailTab("vector")}
              >
                向量索引
              </button>
            </div>

            <div className="stm-table-detail-body">
              {detailTab === "fields" ? (
                <div className="stm-fields-panel">
                  <div className="stm-fields-toolbar">
                    <div className="stm-fields-title">{fieldStatus}</div>
                    <div className="stm-fields-actions">
                      {totalFields > 0 ? (
                        <button
                          type="button"
                          className="stm-button"
                          data-action="toggle-field-edit"
                          data-table-id={selectedTable.id}
                          aria-pressed={sorting}
                          onClick={() => toggleFieldEditMode(selectedTable.id)}
                        >
                          {sorting ? "完成" : "排序"}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="stm-button stm-button--primary"
                        data-action="add-field"
                        data-table-id={selectedTable.id}
                        onClick={() =>
                          openFieldEditor({ mode: "create", tableId: selectedTable.id })
                        }
                      >
                        <i className="fa-solid fa-plus" aria-hidden="true"></i>
                        新增字段
                      </button>
                    </div>
                  </div>

                  {selectedTable.fields.length > 0 ? (
                    <ul className="stm-field-list">
                      {selectedTable.fields.map((field, fieldIndex) => {
                        const isDependent = selectedDependentFieldIds.has(field.id);
                        return (
                          <li key={field.id} className="stm-field-row">
                            {sorting ? (
                              <span className="stm-field-grip" aria-hidden="true">
                                <i className="fa-solid fa-grip-vertical"></i>
                              </span>
                            ) : null}
                            <button
                              type="button"
                              className="stm-field-main"
                              data-action="edit-field"
                              data-table-id={selectedTable.id}
                              data-field-id={field.id}
                              aria-label={`编辑字段 ${field.name}`}
                              onClick={() =>
                                openFieldEditor({
                                  mode: "edit",
                                  tableId: selectedTable.id,
                                  fieldId: field.id,
                                })
                              }
                            >
                              <span className="stm-field-name">
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
                              </span>
                              <span className="stm-field-tag">
                                {field.key} · {field.typeLabel}
                              </span>
                            </button>
                            <label
                              className={`stm-switch${isDependent ? " is-disabled" : ""}`}
                              title={isDependent ? "该字段被显示策略依赖，不能停用" : undefined}
                            >
                              <input
                                type="checkbox"
                                data-action="toggle-field"
                                data-table-id={selectedTable.id}
                                data-field-id={field.id}
                                aria-label={`启用字段 ${field.name}`}
                                checked={field.enabled}
                                disabled={isDependent}
                                onChange={(event) =>
                                  void toggleField(selectedTable.id, field.id, event.target.checked)
                                }
                              />
                              <span className="stm-switch-track" aria-hidden="true"></span>
                            </label>
                            {sorting ? (
                              <div className="stm-field-sort-actions">
                                <button
                                  type="button"
                                  className="stm-field-action"
                                  data-action="move-field-up"
                                  data-table-id={selectedTable.id}
                                  data-field-id={field.id}
                                  disabled={fieldIndex === 0}
                                  aria-label={`上移字段 ${field.name}`}
                                  onClick={() => void moveField(selectedTable.id, field.id, -1)}
                                >
                                  <i className="fa-solid fa-arrow-up" aria-hidden="true"></i>
                                </button>
                                <button
                                  type="button"
                                  className="stm-field-action"
                                  data-action="move-field-down"
                                  data-table-id={selectedTable.id}
                                  data-field-id={field.id}
                                  disabled={fieldIndex === selectedTable.fields.length - 1}
                                  aria-label={`下移字段 ${field.name}`}
                                  onClick={() => void moveField(selectedTable.id, field.id, 1)}
                                >
                                  <i className="fa-solid fa-arrow-down" aria-hidden="true"></i>
                                </button>
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <div className="stm-fields-empty">
                      <div className="stm-fields-empty-title">还没有字段</div>
                      <button
                        type="button"
                        className="stm-button stm-button--primary"
                        data-action="add-field"
                        data-table-id={selectedTable.id}
                        onClick={() =>
                          openFieldEditor({ mode: "create", tableId: selectedTable.id })
                        }
                      >
                        <i className="fa-solid fa-plus" aria-hidden="true"></i>
                        新增字段
                      </button>
                    </div>
                  )}
                </div>
              ) : null}

              {detailTab === "info" ? (
                <div className="stm-table-pane">
                  <TableEditorForm
                    key={`info-${selectedRawTable.id}-${selectedRawTable.updatedAt}`}
                    title="表格信息"
                    initial={{
                      key: selectedRawTable.key,
                      name: selectedRawTable.name,
                      description: selectedRawTable.description,
                      prompt: selectedRawTable.prompt,
                    }}
                    submitLabel="保存修改"
                    onSave={(draft) => void saveTableEdit(selectedTable.id, draft)}
                    onCancel={() => setDetailTab("fields")}
                  />
                  <div className="stm-danger-zone">
                    <div>
                      <div className="stm-danger-title">删除表格</div>
                      <div className="stm-danger-desc">
                        将同时删除 {totalFields} 个字段与其中的记录，且不可恢复。
                      </div>
                    </div>
                    <button
                      type="button"
                      className="stm-button stm-button--danger"
                      data-action="delete-table"
                      data-table-id={selectedTable.id}
                      onClick={() => void deleteTable(selectedTable.id, selectedTable.name)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ) : null}

              {detailTab === "vector" ? (
                <div className="stm-table-pane stm-vector-pane">
                  <VectorIndexEditor
                    key={selectedTable.id}
                    vector={props.vector}
                    records={props.records}
                    memorySpaceId={currentSpaceId}
                    tableId={selectedTable.id}
                    initial={selectedRawTable.vectorIndex}
                    fields={selectedFields}
                    presets={listTablePresets(props.settings.tablePresets, SYSTEM_TABLE_PRESET)}
                    saving={vectorSaving}
                    onCancel={() => setDetailTab("fields")}
                    onSave={async (config: VectorIndexConfiguration) => {
                      setVectorSaving(true);
                      try {
                        await props.tables.update(currentSpaceId, selectedTable.id, {
                          vectorIndex: config,
                        });
                        setReloadKey((key) => key + 1);
                        reportSuccess("向量索引配置已保存");
                      } finally {
                        setVectorSaving(false);
                      }
                    }}
                  />
                  <TableVectorActions
                    vector={props.vector}
                    memorySpaceId={currentSpaceId}
                    tableId={selectedTable.id}
                    enabled={selectedRawTable.vectorIndex?.enabled ?? false}
                  />
                </div>
              ) : null}

              {detailTab === "strategy" ? (
                <div className="stm-table-pane">
                  <DisplayStrategyEditor
                    key={`strategy-${selectedRawTable.id}-${selectedRawTable.updatedAt}`}
                    title="显示策略"
                    initial={emptyDisplayStrategyDraft(selectedRawTable.displayStrategy)}
                    fields={selectedFields}
                    previewRecords={strategyPreviewRecords}
                    previewError={strategyPreviewError}
                    computePreview={computePreview}
                    saving={strategySaving}
                    onSave={(strategy) => void saveDisplayStrategy(selectedTable.id, strategy)}
                    onCancel={closeStrategyEditor}
                  />
                </div>
              ) : null}
            </div>
          </div>
        </section>
      ) : (
        <section className="stm-table-detail-screen stm-table-detail-screen--empty">
          <Placeholder
            title={tables.length === 0 ? "还没有记忆表格" : "选择一张表格"}
            hint={
              tables.length === 0
                ? "点击左侧「新建」开始记录"
                : "从左侧索引选择表格后在这里编辑结构"
            }
          />
        </section>
      )}

      {creatingTable ? (
        <EditorDialog
          label="新建表格"
          section="create-table-modal"
          onClose={() => setCreatingTable(false)}
        >
          <div className="stm-modal-body">
            <TableEditorForm
              title="新建表格"
              initial={EMPTY_TABLE_DRAFT}
              submitLabel="创建表格"
              onSave={(draft) => void createTable(draft)}
              onCancel={() => setCreatingTable(false)}
            />
          </div>
        </EditorDialog>
      ) : null}

      {fieldEditor && fieldEditorInitial ? (
        <EditorDialog
          label={fieldEditor.mode === "create" ? "新增字段" : "编辑字段"}
          section="field-editor-modal"
          onClose={() => setFieldEditor(null)}
        >
          <div className="stm-modal-body">
            <FieldEditorForm
              key={fieldEditor.mode === "create" ? "create" : fieldEditor.fieldId}
              title={fieldEditor.mode === "create" ? "新增字段" : "编辑字段"}
              initial={fieldEditorInitial}
              existingKeys={
                fieldEditor.mode === "edit" && editingField
                  ? fieldEditorFields
                      .filter((field) => field.id !== editingField.id)
                      .map((field) => field.key)
                  : fieldEditorFields.map((field) => field.key)
              }
              referenceTables={rawTables}
              typeLocked={fieldEditor.mode === "edit"}
              submitLabel={fieldEditor.mode === "create" ? "创建字段" : "保存字段"}
              onSave={
                fieldEditor.mode === "create"
                  ? (draft) => void createField(fieldEditor.tableId, draft)
                  : (draft) =>
                      editingField
                        ? void saveFieldEdit(fieldEditor.tableId, editingField.id, draft)
                        : undefined
              }
              onCancel={() => setFieldEditor(null)}
            />
            {editingField ? (
              <div className="stm-modal-danger">
                <button
                  type="button"
                  className="stm-button stm-button--danger"
                  data-action="delete-field"
                  data-table-id={fieldEditor.tableId}
                  data-field-id={editingField.id}
                  disabled={selectedDependentFieldIds.has(editingField.id)}
                  title={
                    selectedDependentFieldIds.has(editingField.id)
                      ? "该字段被显示策略依赖，请先修改显示策略"
                      : undefined
                  }
                  onClick={() =>
                    void deleteField(fieldEditor.tableId, editingField.id, editingField.name)
                  }
                >
                  删除字段
                </button>
              </div>
            ) : null}
          </div>
        </EditorDialog>
      ) : null}
    </div>
  );
}
