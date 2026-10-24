import { FieldList, FieldListRow } from "./field-list.tsx";
import { PageChrome } from "../shell/page-layout.tsx";
import { Disclosure } from "../shell/disclosure.tsx";
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
  readonly registerLeaveGuard?: (guard: (() => boolean) | null) => void;
}) {
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const listScroll = useRef(0);
  const fieldScroll = useRef(0);
  const navigationStarted = useRef(false);
  const screenRef = useRef<HTMLDivElement>(null);
  const detailFocusTarget = useRef<string | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<MemoryTableId | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const [detailTab, setDetailTab] = useState<"fields" | "info" | "strategy" | "vector">("fields");
  const [fieldManagementTableId, setFieldManagementTableId] = useState<MemoryTableId | null>(null);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
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
    props.registerLeaveGuard?.(
      () =>
        !(saving || strategySaving || vectorSaving) &&
        (!dirty || window.confirm("有未保存修改，放弃草稿吗？")),
    );
    return () => props.registerLeaveGuard?.(null);
  }, [dirty, saving, strategySaving, vectorSaving, props.registerLeaveGuard]);

  useEffect(() => {
    if (!dirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [dirty]);

  useEffect(() => {
    const scroller = screenRef.current?.closest<HTMLElement>(".stm-page-content");
    if (!scroller) return;
    const frame = requestAnimationFrame(() => {
      const screen = screenRef.current!;
      const layout = screen.closest(".stm-page-layout")!;
      const editing = creatingTable || fieldEditor !== null || detailTab !== "fields";
      if (editing || mobileView === "detail") navigationStarted.current = true;
      if (editing) {
        screen
          .querySelector<HTMLElement>(
            "form input:not(:disabled), form select:not(:disabled), form textarea:not(:disabled)",
          )
          ?.focus({ preventScroll: true });
      } else if (mobileView === "list" && navigationStarted.current) {
        const selectedEntry = selectedTableId
          ? screen.querySelector<HTMLElement>(
              `[data-action="expand-table"][data-table-id="${CSS.escape(selectedTableId)}"]`,
            )
          : null;
        (selectedEntry ?? layout.querySelector<HTMLElement>('[data-action="create-table"]'))?.focus(
          { preventScroll: true },
        );
      } else if (mobileView === "detail") {
        const previousEntry = detailFocusTarget.current
          ? screen.querySelector<HTMLElement>(detailFocusTarget.current)
          : null;
        (
          previousEntry ?? layout.querySelector<HTMLElement>('[data-action="back-to-table-list"]')
        )?.focus({ preventScroll: true });
      }
      scroller.scrollTop =
        mobileView === "list" && !creatingTable
          ? listScroll.current
          : detailTab === "fields" && !fieldEditor
            ? fieldScroll.current
            : 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [mobileView, creatingTable, fieldEditor, detailTab, selectedTableId]);

  useEffect(() => {
    setFieldManagementTableId(null);
    setConfigurationOpen(false);
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
    if (saving) return;
    setSaving(true);
    try {
      await props.tables.update(currentSpaceId, tableId, { enabled });
    } catch (error) {
      reportError(error);
    }
    setSaving(false);
    bumpData();
  }

  async function toggleField(
    tableId: MemoryTableId,
    fieldId: MemoryFieldId,
    enabled: boolean,
  ): Promise<void> {
    if (saving) return;
    setSaving(true);
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
    setSaving(false);
    bumpData();
  }

  function selectTable(tableId: MemoryTableId): void {
    listScroll.current = screenRef.current?.closest(".stm-page-content")?.scrollTop ?? 0;
    fieldScroll.current = 0;
    detailFocusTarget.current = null;
    setSelectedTableId(tableId);
    setDetailTab("fields");
    setFieldManagementTableId(null);
    setMobileView("detail");
  }

  function leaveEditor(): void {
    if (
      saving ||
      strategySaving ||
      vectorSaving ||
      (dirty && !window.confirm("有未保存修改，放弃草稿吗？"))
    )
      return;
    setDirty(false);
    setMaintenanceOpen(false);
    if (creatingTable) setCreatingTable(false);
    else if (fieldEditor) setFieldEditor(null);
    else if (detailTab !== "fields") setDetailTab("fields");
    else setMobileView("list");
  }

  /** 打开字段编辑器；详情已经承载入口，不再需要展开卡片 */
  function openFieldEditor(state: Exclude<FieldEditorState, null>): void {
    fieldScroll.current = screenRef.current?.closest(".stm-page-content")?.scrollTop ?? 0;
    detailFocusTarget.current =
      state.mode === "edit"
        ? `[data-action="edit-field"][data-field-id="${CSS.escape(state.fieldId)}"]`
        : null;
    setFieldEditor(state);
  }

  async function createTable(draft: TableDraft): Promise<void> {
    if (saving) return;
    setSaving(true);
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
        setFieldManagementTableId(null);
        setMobileView("detail");
        setDirty(false);
        setCreatingTable(false);
      }
    } catch (error) {
      reportError(error);
    }
    setSaving(false);
    bumpData();
  }

  async function saveTableEdit(tableId: MemoryTableId, draft: TableDraft): Promise<void> {
    if (saving) return;
    setSaving(true);
    try {
      await props.tables.update(currentSpaceId, tableId, {
        key: draft.key,
        name: draft.name,
        description: draft.description,
        prompt: draft.prompt,
      });
      setDirty(false);
      setDetailTab("fields");
      reportSuccess("表格信息已保存");
    } catch (error) {
      reportError(error);
    }
    setSaving(false);
    bumpData();
  }

  async function deleteTable(tableId: MemoryTableId, tableName: string): Promise<void> {
    if (saving) return;
    if (
      !window.confirm(`确定删除表格「${tableName}」吗？将同时删除其中的字段与记录，且不可恢复。`)
    ) {
      return;
    }
    setSaving(true);
    try {
      await props.tables.delete(currentSpaceId, tableId);
    } catch (error) {
      reportError(error);
      return;
    } finally {
      setSaving(false);
    }
    setDirty(false);
    setSelectedTableId(null);
    setMobileView("list");
    setDetailTab("fields");
    setFieldManagementTableId(null);
    setFieldEditor(null);
    strategyEditorTableRef.current = null;
    setStrategyPreviewRecords([]);
    setStrategyPreviewError(null);
    bumpData();
  }

  async function createField(tableId: MemoryTableId, draft: FieldDraft): Promise<void> {
    if (saving) return;
    setSaving(true);
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
      setDirty(false);
      setFieldEditor(null);
    } catch (error) {
      reportError(error);
    }
    setSaving(false);
    bumpData();
  }

  async function saveFieldEdit(
    tableId: MemoryTableId,
    fieldId: MemoryFieldId,
    draft: FieldDraft,
  ): Promise<void> {
    if (saving) return;
    setSaving(true);
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
        setDirty(false);
        setFieldEditor(null);
      } else {
        reportError(new Error("字段已不存在，请刷新后重试"));
      }
    } catch (error) {
      reportError(error);
    }
    setSaving(false);
    bumpData();
  }

  async function deleteField(
    tableId: MemoryTableId,
    fieldId: MemoryFieldId,
    fieldName: string,
  ): Promise<void> {
    if (saving) return;
    if (!window.confirm(`确定删除字段「${fieldName}」吗？记录中已填的旧值将保留但不再显示。`)) {
      return;
    }
    setSaving(true);
    try {
      await props.fields.delete(currentSpaceId, tableId, fieldId);
    } catch (error) {
      reportError(error);
      return;
    } finally {
      setSaving(false);
    }
    detailFocusTarget.current = null;
    setDirty(false);
    setFieldEditor(null);
    bumpData();
  }

  function toggleFieldEditMode(tableId: MemoryTableId): void {
    setFieldManagementTableId((prev) => (prev === tableId ? null : tableId));
  }

  function openConfiguration(tab: "info" | "vector"): void {
    detailFocusTarget.current = ".stm-table-settings > summary";
    fieldScroll.current = screenRef.current?.closest(".stm-page-content")?.scrollTop ?? 0;
    setDetailTab(tab);
  }

  /** 打开显示策略页：切到该表并加载现有记录（最多 5 条）供预览 */
  async function openStrategyEditor(tableId: MemoryTableId): Promise<void> {
    detailFocusTarget.current = ".stm-table-settings > summary";
    fieldScroll.current = screenRef.current?.closest(".stm-page-content")?.scrollTop ?? 0;
    setSelectedTableId(tableId);
    setDetailTab("strategy");
    setFieldManagementTableId(null);
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
      setDirty(false);
      setDetailTab("fields");
      reportSuccess("显示策略已保存");
    } catch (error) {
      reportError(error);
    } finally {
      setStrategySaving(false);
    }
    bumpData();
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
  const managingFields = selectedTableId !== null && fieldManagementTableId === selectedTableId;
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

  const editing = creatingTable || fieldEditor !== null || detailTab !== "fields";
  const busy = saving || strategySaving || vectorSaving;
  const formId = "stm-table-management-editor";
  const sectionTitle = creatingTable
    ? "新建表格"
    : fieldEditor
      ? fieldEditor.mode === "create"
        ? "新增字段"
        : "编辑字段"
      : detailTab === "info"
        ? "表格信息"
        : detailTab === "strategy"
          ? "显示策略"
          : "向量索引";

  return (
    <div className="stm-tables-workbench" ref={screenRef}>
      {detailOpen || creatingTable ? (
        <PageChrome
          pageKey={
            creatingTable
              ? "table:new"
              : fieldEditor
                ? `field:${fieldEditor.mode}:${fieldEditor.mode === "edit" ? fieldEditor.fieldId : fieldEditor.tableId}`
                : `table:${selectedTableId}:${detailTab}`
          }
          header={
            <PanelBar
              variant="detail"
              leading={
                <PanelBarAction
                  icon={creatingTable || fieldEditor ? "fa-xmark" : "fa-chevron-left"}
                  label={
                    creatingTable || fieldEditor
                      ? "取消编辑"
                      : detailTab !== "fields"
                        ? "返回字段详情"
                        : "返回表格索引"
                  }
                  data-action={editing ? "editor-cancel" : "back-to-table-list"}
                  disabled={busy}
                  onClick={leaveEditor}
                />
              }
              title={editing ? sectionTitle : (selectedTable?.name ?? "表格")}
              subtitle={editing ? selectedTable?.name : selectedTable?.key}
              trailing={
                editing ? (
                  <>
                    {(fieldEditor?.mode === "edit" && editingField) || detailTab === "info" ? (
                      <PanelBarAction
                        icon="fa-trash-can"
                        label={fieldEditor ? "删除字段" : "删除表格"}
                        danger
                        data-action={fieldEditor ? "delete-field" : "delete-table"}
                        disabled={
                          busy ||
                          (editingField !== null && selectedDependentFieldIds.has(editingField.id))
                        }
                        onClick={() => {
                          if (dirty && !window.confirm("有未保存修改，放弃草稿并继续删除吗？"))
                            return;
                          if (fieldEditor && editingField)
                            void deleteField(
                              fieldEditor.tableId,
                              editingField.id,
                              editingField.name,
                            );
                          else if (selectedTable)
                            void deleteTable(selectedTable.id, selectedTable.name);
                        }}
                      />
                    ) : null}
                    <PanelBarAction
                      icon="fa-check"
                      label="保存"
                      emphasis
                      type="submit"
                      form={formId}
                      data-action="editor-submit"
                      disabled={busy}
                    />
                  </>
                ) : selectedTable ? (
                  <label
                    className="stm-switch"
                    data-bar-unframed
                    title={selectedTable.enabled ? "停用表格" : "启用表格"}
                  >
                    <input
                      type="checkbox"
                      disabled={busy}
                      data-action="toggle-table"
                      data-table-id={selectedTable.id}
                      checked={selectedTable.enabled}
                      aria-label={`启用 ${selectedTable.name}`}
                      onChange={(event) => void toggleTable(selectedTable.id, event.target.checked)}
                    />
                    <span className="stm-switch-track" aria-hidden="true" />
                  </label>
                ) : null
              }
            />
          }
        />
      ) : (
        <PageChrome
          pageKey="table-list"
          headerTrailing={
            <PanelBarAction
              icon="fa-plus"
              label="新建表格"
              data-action="create-table"
              onClick={() => {
                listScroll.current =
                  screenRef.current?.closest(".stm-page-content")?.scrollTop ?? 0;
                setCreatingTable(true);
              }}
            />
          }
        />
      )}
      {mobileView === "list" && !creatingTable ? (
        <section className="stm-table-index">
          <div className="stm-table-search">
            <i className="fa-solid fa-magnifying-glass" aria-hidden="true" />
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
          <div className="stm-table-rail-list stm-grouped-list">
            {filteredTables.map((table) => (
              <button
                key={table.id}
                type="button"
                className={`stm-table-rail-row${table.enabled ? "" : " is-off"}`}
                data-action="expand-table"
                data-table-id={table.id}
                onClick={() => selectTable(table.id)}
              >
                <span className="stm-table-rail-main">
                  <span className="stm-table-rail-name">{table.name}</span>
                  <span className="stm-table-rail-meta">
                    {table.fields.length} 个字段{table.enabled ? "" : " · 已停用"}
                    {table.description ? ` · ${table.description}` : ""}
                  </span>
                </span>
                <i className="fa-solid fa-chevron-right stm-table-chevron" aria-hidden="true" />
              </button>
            ))}
          </div>
          {filteredTables.length === 0 ? (
            <Placeholder
              title={tables.length ? "没有匹配的表格" : "还没有记忆表格"}
              hint={tables.length ? "试试其他名称或 Key" : "点击加号创建表格"}
            />
          ) : null}
        </section>
      ) : null}
      {creatingTable ? (
        <TableEditorForm
          formId={formId}
          saving={busy}
          onDirtyChange={setDirty}
          title="新建表格"
          initial={EMPTY_TABLE_DRAFT}
          submitLabel="创建表格"
          onSave={(draft) => void createTable(draft)}
          onCancel={leaveEditor}
        />
      ) : fieldEditor && fieldEditorInitial ? (
        <FieldEditorForm
          key={fieldEditor.mode === "create" ? "create" : fieldEditor.fieldId}
          formId={formId}
          saving={busy}
          onDirtyChange={setDirty}
          title={sectionTitle}
          initial={fieldEditorInitial}
          existingKeys={fieldEditorFields
            .filter((field) => field.id !== editingField?.id)
            .map((field) => field.key)}
          referenceTables={rawTables}
          enabledLocked={editingField ? selectedDependentFieldIds.has(editingField.id) : false}
          typeLocked={fieldEditor.mode === "edit"}
          submitLabel="保存字段"
          onSave={(draft) => {
            if (fieldEditor.mode === "create") void createField(fieldEditor.tableId, draft);
            else if (editingField) void saveFieldEdit(fieldEditor.tableId, editingField.id, draft);
          }}
          onCancel={leaveEditor}
        />
      ) : detailOpen && selectedTable && selectedRawTable ? (
        <section className="stm-table-detail-screen">
          {detailTab === "fields" ? (
            <>
              <div className="stm-fields-panel">
                <div className="stm-fields-toolbar">
                  <div className="stm-fields-title">{fieldStatus}</div>
                  <div className="stm-bar-group stm-fields-actions">
                    {totalFields > 0 ? (
                      <PanelBarAction
                        icon={managingFields ? "fa-check" : "fa-pen"}
                        label={managingFields ? "完成编辑" : "编辑字段列表"}
                        disabled={busy}
                        data-action="toggle-field-edit"
                        data-table-id={selectedTable.id}
                        aria-pressed={managingFields}
                        onClick={() => toggleFieldEditMode(selectedTable.id)}
                      />
                    ) : null}
                    <PanelBarAction
                      icon="fa-plus"
                      label="新增字段"
                      emphasis
                      disabled={busy}
                      data-action="add-field"
                      data-table-id={selectedTable.id}
                      onClick={() => openFieldEditor({ mode: "create", tableId: selectedTable.id })}
                    />
                  </div>
                </div>

                {selectedTable.fields.length > 0 ? (
                  <FieldList>
                    {selectedTable.fields.map((field) => {
                      const isDependent = selectedDependentFieldIds.has(field.id);
                      return (
                        <FieldListRow
                          key={field.id}
                          name={field.name}
                          fieldKey={field.key}
                          typeLabel={field.typeLabel}
                          required={field.required}
                          dependent={isDependent}
                          button={{
                            disabled: busy,
                            "data-action": "edit-field",
                            "data-table-id": selectedTable.id,
                            "data-field-id": field.id,
                            "aria-label": `编辑字段 ${field.name}`,
                            onClick: () =>
                              openFieldEditor({
                                mode: "edit",
                                tableId: selectedTable.id,
                                fieldId: field.id,
                              }),
                          }}
                          toggle={{
                            checked: field.enabled,
                            disabled: busy || isDependent,
                            "data-action": "toggle-field",
                            "data-table-id": selectedTable.id,
                            "data-field-id": field.id,
                            onChange: (event) =>
                              void toggleField(selectedTable.id, field.id, event.target.checked),
                          }}
                          actions={
                            managingFields ? (
                              <div className="stm-bar-group stm-field-management-actions">
                                <PanelBarAction
                                  icon="fa-trash-can"
                                  label={`删除字段 ${field.name}`}
                                  danger
                                  data-action="delete-field"
                                  data-table-id={selectedTable.id}
                                  data-field-id={field.id}
                                  disabled={busy || isDependent}
                                  title={
                                    isDependent
                                      ? "该字段被显示策略依赖，请先修改显示策略"
                                      : `删除字段 ${field.name}`
                                  }
                                  onClick={() =>
                                    void deleteField(selectedTable.id, field.id, field.name)
                                  }
                                />
                              </div>
                            ) : null
                          }
                        />
                      );
                    })}
                  </FieldList>
                ) : (
                  <div className="stm-fields-empty">
                    <div className="stm-fields-empty-title">还没有字段</div>
                  </div>
                )}
              </div>
              <Disclosure
                icon="fa-sliders"
                title="表格配置"
                meta={selectedTable.enabled ? undefined : "已停用"}
                className="stm-table-settings"
                open={configurationOpen}
                onToggle={(event) => setConfigurationOpen(event.currentTarget.open)}
              >
                <div className="stm-table-config-list">
                  <button
                    type="button"
                    disabled={busy}
                    data-action="edit-table"
                    data-table-id={selectedTable.id}
                    onClick={() => openConfiguration("info")}
                  >
                    <span>
                      表格信息<small>{selectedTable.description || selectedTable.key}</small>
                    </span>
                    <i className="fa-solid fa-chevron-right" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    data-action="edit-display-strategy"
                    data-table-id={selectedTable.id}
                    onClick={() => void openStrategyEditor(selectedTable.id)}
                  >
                    <span>
                      显示策略
                      <small>
                        {displayStrategySummary(selectedRawTable.displayStrategy, selectedFields)}
                      </small>
                    </span>
                    <i className="fa-solid fa-chevron-right" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    data-action="edit-vector-index"
                    data-table-id={selectedTable.id}
                    onClick={() => openConfiguration("vector")}
                  >
                    <span>
                      向量索引
                      <small>{selectedRawTable.vectorIndex?.enabled ? "已启用" : "未启用"}</small>
                    </span>
                    <i className="fa-solid fa-chevron-right" aria-hidden="true" />
                  </button>
                </div>
              </Disclosure>
            </>
          ) : null}
          {detailTab === "info" ? (
            <TableEditorForm
              key={`info-${selectedRawTable.id}-${selectedRawTable.updatedAt}`}
              formId={formId}
              saving={busy}
              onDirtyChange={setDirty}
              title="表格信息"
              initial={{
                key: selectedRawTable.key,
                name: selectedRawTable.name,
                description: selectedRawTable.description,
                prompt: selectedRawTable.prompt,
              }}
              submitLabel="保存修改"
              onSave={(draft) => void saveTableEdit(selectedTable.id, draft)}
              onCancel={leaveEditor}
            />
          ) : null}
          {detailTab === "strategy" ? (
            <DisplayStrategyEditor
              key={`strategy-${selectedRawTable.id}-${selectedRawTable.updatedAt}`}
              formId={formId}
              onDirtyChange={setDirty}
              title="显示策略"
              initial={emptyDisplayStrategyDraft(selectedRawTable.displayStrategy)}
              fields={selectedFields}
              previewRecords={strategyPreviewRecords}
              previewError={strategyPreviewError}
              computePreview={computePreview}
              saving={strategySaving}
              onSave={(strategy) => void saveDisplayStrategy(selectedTable.id, strategy)}
              onCancel={leaveEditor}
            />
          ) : null}
          {detailTab === "vector" ? (
            <div className="stm-table-pane stm-vector-pane">
              <VectorIndexEditor
                key={selectedTable.id}
                formId={formId}
                onDirtyChange={setDirty}
                vector={props.vector}
                records={props.records}
                memorySpaceId={currentSpaceId}
                tableId={selectedTable.id}
                initial={selectedRawTable.vectorIndex}
                fields={selectedFields}
                presets={listTablePresets(props.settings.tablePresets, SYSTEM_TABLE_PRESET)}
                saving={vectorSaving}
                onCancel={leaveEditor}
                onSave={async (config: VectorIndexConfiguration) => {
                  setVectorSaving(true);
                  try {
                    await props.tables.update(currentSpaceId, selectedTable.id, {
                      vectorIndex: config,
                    });
                    setDirty(false);
                    setDetailTab("fields");
                    bumpData();
                    reportSuccess("向量索引配置已保存");
                  } finally {
                    setVectorSaving(false);
                  }
                }}
              />
              <Disclosure
                icon="fa-screwdriver-wrench"
                title="索引维护"
                meta={selectedRawTable.vectorIndex?.enabled ? undefined : "已停用"}
                open={maintenanceOpen}
                onToggle={(event) => setMaintenanceOpen(event.currentTarget.open)}
              >
                {maintenanceOpen ? (
                  <TableVectorActions
                    vector={props.vector}
                    memorySpaceId={currentSpaceId}
                    tableId={selectedTable.id}
                    enabled={selectedRawTable.vectorIndex?.enabled ?? false}
                  />
                ) : null}
              </Disclosure>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
