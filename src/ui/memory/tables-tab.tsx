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
import {
  emptyFieldDraft,
  fieldDraftFromField,
  fieldTypeNeedsOptions,
  parseOptionsText,
  swapAdjacentFieldPositions,
  type FieldDraft,
} from "./field-editor-model.ts";
import type { PanelRuntime } from "../shell/panel-shell.tsx";

// ---- 表格列表 Tab（ticket 09：建表 + 表格编辑/删除 + 字段定义编辑器） ----

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

  // 显示策略预览计算：Memory previewDisplayText 绑定当前空间/表（只读，不落库）
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
