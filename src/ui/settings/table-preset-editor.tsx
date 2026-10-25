import { FieldList, FieldListRow } from "../memory/field-list.tsx";
import { TableConfigSection, TableFieldsPanel } from "../memory/table-detail-sections.tsx";
import { SettingsActionMenu, type SettingsMenuAction } from "./settings-action-menu.tsx";
import { useEffect, useId, useRef, useState } from "react";
import { useSettingsPageNavigation } from "./settings-page-navigation.ts";
import { PageChrome } from "../shell/page-layout.tsx";
import { PanelBar, PanelBarAction } from "../shell/panel-bar.tsx";
import { Disclosure } from "../shell/disclosure.tsx";
import type { MemoryTableId } from "../../features/memory/index.ts";
import type {
  ResolvedTablePreset,
  TablePresetField,
  TablePresetTable,
} from "../../features/table-presets/preset-model.ts";
import { FieldEditorForm, TableEditorForm } from "../memory/table-editor.tsx";
import { EMPTY_TABLE_DRAFT } from "../memory/table-editor-model.ts";
import {
  emptyFieldDraft,
  fieldTypeNeedsOptions,
  fieldTypeNeedsReference,
  parseOptionsText,
} from "../memory/field-editor-model.ts";
import { FIELD_TYPE_LABELS } from "../memory/table-list-model.ts";
import { PresetVectorIndexEditor } from "./preset-vector-index-editor.tsx";
import {
  presetDisplayStrategySummary,
  presetFieldUsedForDisplay,
  renamePresetDisplayField,
  replacePresetTable,
} from "./table-preset-editor-model.ts";

/** 比较可编辑内容；id / builtIn 在编辑期间不变，且不参与脏状态判断。 */
function presetContent(preset: ResolvedTablePreset): string {
  return JSON.stringify({
    name: preset.name,
    description: preset.description,
    prompt: preset.prompt,
    tables: preset.tables,
  });
}

export function TablePresetEditor(props: {
  readonly chrome?: boolean;
  readonly initial: ResolvedTablePreset;
  readonly isNew: boolean;
  readonly presetActions?: (draft: ResolvedTablePreset) => SettingsMenuAction[];
  /** 每次完成操作立即写回预设库；返回规范化后的预设，不再有顶层“保存预设”。 */
  readonly onChange: (preset: ResolvedTablePreset) => ResolvedTablePreset;
  readonly onClose: () => void;
  readonly registerLeaveGuard?: (guard: (() => boolean) | null) => void;
}) {
  const [draft, setDraft] = useState(props.initial);
  const [error, setError] = useState("");
  const [selectedTableKey, setSelectedTableKey] = useState<string | null>(null);
  const [configPage, setConfigPage] = useState<"info" | null>(() =>
    props.isNew && props.initial.tables.length === 0 ? "info" : null,
  );
  const [strategyEditor, setStrategyEditor] = useState<string | null>(null);
  const [vectorEditor, setVectorEditor] = useState<string | null>(null);
  const [tableEditor, setTableEditor] = useState<number | "new" | null>(null);
  const [managingFields, setManagingFields] = useState(false);
  const [sortingFields, setSortingFields] = useState(false);
  const [sortingTables, setSortingTables] = useState(false);
  const [fieldEditor, setFieldEditor] = useState<{
    table: number;
    field: number | "new";
  } | null>(null);
  const page = configPage
    ? `config:${configPage}`
    : tableEditor !== null
      ? `edit:table:${tableEditor}`
      : fieldEditor
        ? `edit:field:${fieldEditor.table}:${fieldEditor.field}`
        : strategyEditor
          ? "strategy"
          : vectorEditor
            ? "vector"
            : (selectedTableKey ?? "overview");
  const { screenRef, rememberScroll } = useSettingsPageNavigation(page);
  const formId = useId();
  const selectedTableIndex = draft.tables.findIndex((table) => table.key === selectedTableKey);
  const selectedTable = draft.tables[selectedTableIndex];
  // 子表单尚未提交的输入也必须参与离开提示。
  const [formDirty, setFormDirty] = useState(false);
  const [fieldConstraints, setFieldConstraints] = useState<
    Pick<TablePresetField, "maxChars" | "valuePattern" | "valuePatternMessage">
  >({
    maxChars: null,
    valuePattern: null,
    valuePatternMessage: null,
  });

  const dirty = formDirty || presetContent(draft) !== presetContent(props.initial);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const readonly = props.initial.builtIn;
  useEffect(() => {
    props.registerLeaveGuard?.(
      () => !dirtyRef.current || window.confirm("预设有未保存的修改，放弃修改并离开吗？"),
    );
    function beforeUnload(event: BeforeUnloadEvent) {
      if (dirtyRef.current) event.preventDefault();
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      props.registerLeaveGuard?.(null);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [props.registerLeaveGuard]);

  function run(action: () => void) {
    try {
      action();
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  /** 写库并把本地草稿推进到规范化后的新值；异常交给调用方的 run 处理。 */
  function persist(next: ResolvedTablePreset) {
    setDraft(props.onChange(next));
  }
  function persistTable(index: number, table: TablePresetTable) {
    persist({ ...draft, tables: replacePresetTable(draft.tables, index, table) });
  }
  /** 开关、删除、排序等即时操作自行吞掉错误并展示提示。 */
  function commit(next: ResolvedTablePreset) {
    run(() => persist(next));
  }
  /** 提交当前草稿；没有变化时不写库。 */
  function persistDraft() {
    if (presetContent(draft) === presetContent(props.initial)) return;
    setDraft(props.onChange(draft));
  }
  function commitDraft() {
    run(persistDraft);
  }
  /** 属性页暂时只更新草稿，返回时提交。 */
  function setTableDraft(index: number, table: TablePresetTable) {
    setDraft({ ...draft, tables: replacePresetTable(draft.tables, index, table) });
  }
  function updateTable(index: number, table: TablePresetTable) {
    commit({ ...draft, tables: replacePresetTable(draft.tables, index, table) });
  }
  function close() {
    if (!dirty || window.confirm("预设有未保存的修改，放弃修改并返回列表吗？")) props.onClose();
  }
  function moveTable(index: number, delta: number) {
    const tables = [...draft.tables];
    [tables[index], tables[index + delta]] = [tables[index + delta]!, tables[index]!];
    commit({ ...draft, tables });
  }
  function moveField(tableIndex: number, index: number, delta: number) {
    const table = draft.tables[tableIndex]!;
    const fields = [...table.fields];
    [fields[index], fields[index + delta]] = [fields[index + delta]!, fields[index]!];
    updateTable(tableIndex, { ...table, fields });
  }
  const editing = tableEditor !== null || fieldEditor !== null;
  const fieldTable = fieldEditor ? draft.tables[fieldEditor.table]! : undefined;
  const field =
    fieldEditor && fieldEditor.field !== "new" ? fieldTable!.fields[fieldEditor.field]! : undefined;

  const tableForm = tableEditor !== null && (
    <div onChangeCapture={() => setFormDirty(true)}>
      <TableEditorForm
        formId={props.chrome ? formId : undefined}
        key={tableEditor}
        title={tableEditor === "new" ? "新增表格" : "编辑表格"}
        initial={tableEditor === "new" ? EMPTY_TABLE_DRAFT : draft.tables[tableEditor]!}
        submitLabel="完成表格编辑"
        onCancel={cancelSubform}
        onSave={(value) =>
          run(() => {
            const normalized = { ...value, key: value.key.trim(), name: value.name.trim() };
            if (tableEditor === "new") {
              if (draft.tables.some((t) => t.key === normalized.key))
                throw new Error(`表格 Key 已存在：${normalized.key}`);
              persist({
                ...draft,
                tables: [
                  ...draft.tables,
                  { ...normalized, enabled: true, displayStrategy: null, fields: [] },
                ],
              });
            } else persistTable(tableEditor, { ...draft.tables[tableEditor]!, ...normalized });
            rememberScroll();
            setSelectedTableKey(normalized.key);
            setTableEditor(null);
            setFormDirty(false);
          })
        }
      />
    </div>
  );
  const fieldForm = fieldEditor && fieldTable && (
    <div onChangeCapture={() => setFormDirty(true)}>
      <FieldEditorForm
        formId={props.chrome ? formId : undefined}
        key={`${fieldEditor.table}-${fieldEditor.field}`}
        title={field ? "编辑字段" : "新增字段"}
        initial={
          field
            ? {
                ...field,
                optionsText: field.options.join("\n"),
                referenceTableId: field.referenceTableKey ?? "",
              }
            : emptyFieldDraft("short_text")
        }
        existingKeys={fieldTable.fields.filter((_, i) => i !== fieldEditor.field).map((f) => f.key)}
        referenceTables={draft.tables.map((t) => ({
          id: t.key as MemoryTableId,
          name: t.name,
        }))}
        typeLocked={false}
        submitLabel="完成字段编辑"
        onCancel={cancelSubform}
        onSave={(value) =>
          run(() => {
            const sameType = field?.type === value.type;
            const updated: TablePresetField = {
              key: value.key.trim(),
              name: value.name.trim(),
              type: value.type,
              required: value.required,
              prompt: value.prompt,
              enabled: value.enabled,
              options: fieldTypeNeedsOptions(value.type) ? parseOptionsText(value.optionsText) : [],
              referenceTableKey: fieldTypeNeedsReference(value.type)
                ? value.referenceTableId
                : null,
              maxChars: sameType ? fieldConstraints.maxChars : null,
              valuePattern: sameType ? fieldConstraints.valuePattern : null,
              valuePatternMessage: sameType ? fieldConstraints.valuePatternMessage : null,
            };
            persistTable(fieldEditor.table, {
              ...fieldTable,
              displayStrategy: field
                ? renamePresetDisplayField(fieldTable, field.key, updated.key)
                : fieldTable.displayStrategy,
              fields:
                fieldEditor.field === "new"
                  ? [...fieldTable.fields, updated]
                  : fieldTable.fields.map((f, i) => (i === fieldEditor.field ? updated : f)),
            });
            rememberScroll();
            setFieldEditor(null);
            setFormDirty(false);
          })
        }
      />
    </div>
  );
  function cancelSubform() {
    if (formDirty && !window.confirm("有未完成的修改，放弃并返回吗？")) return;
    rememberScroll();
    setTableEditor(null);
    setFieldEditor(null);
    setFormDirty(false);
  }
  function openTable(key: string | null) {
    rememberScroll();
    setConfigPage(null);
    setStrategyEditor(null);
    setVectorEditor(null);
    setManagingFields(false);
    setSortingFields(false);
    setSortingTables(false);
    setSelectedTableKey(key);
  }
  function openTableForm(index: number | "new") {
    setConfigPage(null);
    setStrategyEditor(null);
    setVectorEditor(null);
    setManagingFields(false);
    setSortingFields(false);
    rememberScroll();
    setTableEditor(index);
  }
  function openFieldForm(table: number, field: number | "new") {
    setConfigPage(null);
    setStrategyEditor(null);
    setVectorEditor(null);
    setManagingFields(false);
    setSortingFields(false);
    const source = field === "new" ? null : draft.tables[table]!.fields[field]!;
    setFieldConstraints({
      maxChars: source?.maxChars ?? null,
      valuePattern: source?.valuePattern ?? null,
      valuePatternMessage: source?.valuePatternMessage ?? null,
    });
    rememberScroll();
    setFieldEditor({ table, field });
  }
  function backToTable() {
    rememberScroll();
    run(() => {
      persistDraft();
      setStrategyEditor(null);
      setVectorEditor(null);
    });
  }
  function deleteTable(index: number) {
    run(() => {
      const table = draft.tables[index]!;
      const dependencies = draft.tables.flatMap((other, i) =>
        i === index
          ? []
          : other.fields
              .filter((f) => f.referenceTableKey === table.key)
              .map((f) => `${other.name}.${f.name}`),
      );
      if (dependencies.length) throw new Error(`请先调整引用字段：${dependencies.join("、")}`);
      if (window.confirm(`删除预设表「${table.name}」及其全部字段？`)) {
        persist({ ...draft, tables: draft.tables.filter((_, i) => i !== index) });
        setTableEditor(null);
        setFieldEditor(null);
        openTable(null);
      }
    });
  }
  function deleteField(tableIndex: number, fieldIndex: number) {
    const table = draft.tables[tableIndex]!;
    const target = table.fields[fieldIndex]!;
    if (window.confirm(`删除字段「${target.name}」？`)) {
      run(() => {
        persistTable(tableIndex, {
          ...table,
          fields: table.fields.filter((_, i) => i !== fieldIndex),
        });
        setFieldEditor(null);
        setFormDirty(false);
      });
    }
  }
  const creatingInfo = props.isNew && props.initial.tables.length === 0 && configPage === "info";
  const heading =
    configPage === "info"
      ? creatingInfo
        ? "新建预设"
        : "预设信息"
      : tableEditor !== null
        ? tableEditor === "new"
          ? "新建表格"
          : "编辑表格"
        : fieldEditor
          ? field
            ? "编辑字段"
            : "新建字段"
          : strategyEditor
            ? "显示策略"
            : vectorEditor
              ? "向量索引"
              : selectedTable
                ? selectedTable.name
                : readonly
                  ? draft.name
                  : props.isNew && props.initial.tables.length === 0
                    ? "新建预设"
                    : "编辑预设";
  const nested =
    (!creatingInfo && configPage !== null) ||
    editing ||
    strategyEditor !== null ||
    vectorEditor !== null ||
    selectedTable !== undefined;
  const back = creatingInfo
    ? close
    : configPage
      ? () => {
          rememberScroll();
          run(() => {
            persistDraft();
            setConfigPage(null);
          });
        }
      : editing
        ? cancelSubform
        : strategyEditor || vectorEditor
          ? backToTable
          : selectedTable
            ? () => openTable(null)
            : close;
  const strategy = selectedTable?.displayStrategy;
  const canDeleteField = field && fieldTable && !presetFieldUsedForDisplay(fieldTable, field.key);
  const fieldStatus = selectedTable
    ? selectedTable.fields.length > 0 && selectedTable.fields.every((item) => item.enabled)
      ? "全部启用"
      : `已启用 ${selectedTable.fields.filter((item) => item.enabled).length}`
    : "";
  const menuActions: SettingsMenuAction[] = [
    ...(props.presetActions?.(draft) ?? []),
    {
      label: "预设信息与填写规则",
      dataAction: "edit-preset-info",
      onSelect: () => {
        rememberScroll();
        setConfigPage("info");
      },
    },
  ];
  return (
    <div
      ref={screenRef}
      className="stm-settings-detail-page stm-preset-table-page"
      data-stm-section="table-preset-editor"
      data-preset-screen={page}
    >
      {props.chrome && (
        <PageChrome
          pageKey={page}
          header={
            <PanelBar
              title={heading}
              subtitle={dirty ? "预设未保存" : draft.name || undefined}
              leading={
                <PanelBarAction
                  icon="fa-arrow-left"
                  label={editing ? "取消编辑" : nested ? "返回" : "返回预设列表"}
                  data-action="close-table-preset"
                  onClick={back}
                />
              }
              trailing={
                readonly ? undefined : editing ? (
                  <>
                    {fieldEditor && canDeleteField && (
                      <PanelBarAction
                        icon="fa-trash"
                        label="删除字段"
                        data-action="delete-field"
                        danger
                        onClick={() => deleteField(fieldEditor.table, fieldEditor.field as number)}
                      />
                    )}
                    {tableEditor !== null && tableEditor !== "new" && (
                      <PanelBarAction
                        icon="fa-trash"
                        label="删除表格"
                        data-action="delete-table"
                        danger
                        onClick={() => deleteTable(tableEditor)}
                      />
                    )}
                    <PanelBarAction
                      icon="fa-check"
                      label={fieldEditor ? "完成字段编辑" : "完成表格编辑"}
                      data-action={fieldEditor ? "save-preset-field" : "save-preset-table"}
                      type="submit"
                      form={formId}
                    />
                  </>
                ) : configPage !== null ||
                  strategyEditor !== null ||
                  vectorEditor !== null ? undefined : selectedTable ? (
                  <label
                    className="stm-switch"
                    data-bar-unframed
                    title={selectedTable.enabled ? "停用表格" : "启用表格"}
                  >
                    <input
                      type="checkbox"
                      checked={selectedTable.enabled}
                      data-action="toggle-table"
                      aria-label={`启用表格 ${selectedTable.name}`}
                      onChange={(event) =>
                        updateTable(selectedTableIndex, {
                          ...selectedTable,
                          enabled: event.target.checked,
                        })
                      }
                    />
                    <span className="stm-switch-track" aria-hidden="true" />
                  </label>
                ) : (
                  <SettingsActionMenu actions={menuActions} />
                )
              }
            />
          }
        />
      )}
      {!props.chrome && (
        <div className="stm-setting-actions">
          <button type="button" className="stm-button" onClick={back}>
            返回
          </button>
        </div>
      )}
      {error && (
        <div className="stm-form-error" role="alert">
          {error}
        </div>
      )}
      {configPage === "info" ? (
        <fieldset
          disabled={readonly}
          className="stm-settings-fields"
          data-stm-section="preset-info"
          onBlur={commitDraft}
        >
          <label className="stm-form-row">
            <span className="stm-form-label">预设名称</span>
            <input
              className="stm-input"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label className="stm-form-row">
            <span className="stm-form-label">说明</span>
            <input
              className="stm-input"
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>
          <label className="stm-form-row">
            <span className="stm-form-label">通用填写规则</span>
            <textarea
              className="stm-textarea"
              rows={3}
              value={draft.prompt ?? ""}
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
            />
          </label>
          <p className="stm-setting-hint">修改会自动保存到预设库；已有空间保持原状。</p>
        </fieldset>
      ) : tableEditor !== null ? (
        tableForm
      ) : fieldEditor ? (
        <>
          {fieldForm}
          {field && (
            <Disclosure icon="fa-sliders" title="字段约束">
              <fieldset className="stm-preset-editor-fields">
                {(
                  [
                    ["maxChars", "最大字符数"],
                    ["valuePattern", "格式正则表达式"],
                    ["valuePatternMessage", "格式错误提示"],
                  ] as const
                ).map(([key, label]) => (
                  <label className="stm-form-row" key={key}>
                    <span className="stm-form-label">{label}</span>
                    <input
                      className="stm-input"
                      type={key === "maxChars" ? "number" : "text"}
                      min={key === "maxChars" ? 1 : undefined}
                      value={fieldConstraints[key] ?? ""}
                      onChange={(event) => {
                        setFormDirty(true);
                        setFieldConstraints({
                          ...fieldConstraints,
                          [key]:
                            event.target.value === ""
                              ? null
                              : key === "maxChars"
                                ? Number(event.target.value)
                                : event.target.value,
                        });
                      }}
                    />
                  </label>
                ))}
              </fieldset>
            </Disclosure>
          )}
        </>
      ) : strategyEditor && selectedTable ? (
        <fieldset className="stm-settings-fields">
          <label className="stm-form-row">
            <span className="stm-form-label">显示策略</span>
            <select
              className="stm-input"
              value={strategy?.type ?? "none"}
              onChange={(event) =>
                setTableDraft(selectedTableIndex, {
                  ...selectedTable,
                  displayStrategy:
                    event.target.value === "none"
                      ? null
                      : event.target.value === "field"
                        ? { type: "field", fieldKey: "" }
                        : { type: "template", template: "" },
                })
              }
            >
              <option value="none">默认显示</option>
              <option value="field">短文本字段</option>
              <option value="template">派生模板</option>
            </select>
          </label>
          {strategy?.type === "field" && (
            <label className="stm-form-row">
              <span className="stm-form-label">显示字段</span>
              <select
                className="stm-input"
                value={strategy.fieldKey}
                onChange={(event) =>
                  setTableDraft(selectedTableIndex, {
                    ...selectedTable,
                    displayStrategy: { type: "field", fieldKey: event.target.value },
                  })
                }
              >
                <option value="">请选择字段</option>
                {selectedTable.fields
                  .filter((f) => f.enabled && f.type === "short_text")
                  .map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {strategy?.type === "template" && (
            <label className="stm-form-row">
              <span className="stm-form-label">显示模板</span>
              <textarea
                className="stm-textarea"
                placeholder="使用 {字段Key} 引用字段"
                value={strategy.template}
                onChange={(event) =>
                  setTableDraft(selectedTableIndex, {
                    ...selectedTable,
                    displayStrategy: { type: "template", template: event.target.value },
                  })
                }
              />
            </label>
          )}
          <p className="stm-setting-hint">返回时自动保存本表显示策略。</p>
        </fieldset>
      ) : vectorEditor && selectedTable ? (
        <>
          <PresetVectorIndexEditor
            table={selectedTable}
            readonly={readonly}
            onChange={(vectorIndex) =>
              setTableDraft(selectedTableIndex, { ...selectedTable, vectorIndex })
            }
          />
          <p className="stm-setting-hint">返回时自动保存本表向量索引。</p>
        </>
      ) : selectedTable ? (
        <>
          <TableFieldsPanel
            status={fieldStatus}
            actions={
              <>
                {selectedTable.fields.length > 0 ? (
                  <PanelBarAction
                    icon={managingFields ? "fa-check" : "fa-pen"}
                    label={managingFields ? "完成编辑" : "编辑字段列表"}
                    data-action="toggle-preset-field-edit"
                    aria-pressed={managingFields}
                    disabled={readonly}
                    onClick={() => {
                      setSortingFields(false);
                      setManagingFields((prev) => !prev);
                    }}
                  />
                ) : null}
                {selectedTable.fields.length > 1 ? (
                  <PanelBarAction
                    icon={sortingFields ? "fa-check" : "fa-sort"}
                    label={sortingFields ? "完成排序" : "调整字段顺序"}
                    data-action="toggle-preset-field-order"
                    aria-pressed={sortingFields}
                    disabled={readonly}
                    onClick={() => {
                      setManagingFields(false);
                      setSortingFields((prev) => !prev);
                    }}
                  />
                ) : null}
                <PanelBarAction
                  icon="fa-plus"
                  label="新建字段"
                  data-action="add-field"
                  disabled={readonly}
                  onClick={() => openFieldForm(selectedTableIndex, "new")}
                />
              </>
            }
          >
            {selectedTable.fields.length > 0 ? (
              <FieldList>
                {selectedTable.fields.map((f, fi) => {
                  const dependent = presetFieldUsedForDisplay(selectedTable, f.key);
                  return (
                    <FieldListRow
                      key={f.key}
                      name={f.name}
                      fieldKey={f.key}
                      typeLabel={FIELD_TYPE_LABELS[f.type]}
                      required={f.required}
                      dependent={dependent}
                      button={{
                        "data-action": "edit-field",
                        disabled: readonly,
                        onClick: () => openFieldForm(selectedTableIndex, fi),
                      }}
                      toggle={
                        sortingFields
                          ? undefined
                          : {
                              checked: f.enabled,
                              disabled: readonly || dependent,
                              onChange: (event) =>
                                updateTable(selectedTableIndex, {
                                  ...selectedTable,
                                  fields: selectedTable.fields.map((item, i) =>
                                    i === fi ? { ...item, enabled: event.target.checked } : item,
                                  ),
                                }),
                            }
                      }
                      actions={
                        sortingFields ? (
                          <div className="stm-bar-group stm-field-management-actions">
                            <PanelBarAction
                              icon="fa-arrow-up"
                              label={`上移字段 ${f.name}`}
                              data-action="move-preset-field-up"
                              disabled={readonly || fi === 0}
                              onClick={() => moveField(selectedTableIndex, fi, -1)}
                            />
                            <PanelBarAction
                              icon="fa-arrow-down"
                              label={`下移字段 ${f.name}`}
                              data-action="move-preset-field-down"
                              disabled={readonly || fi === selectedTable.fields.length - 1}
                              onClick={() => moveField(selectedTableIndex, fi, 1)}
                            />
                          </div>
                        ) : managingFields ? (
                          <div className="stm-bar-group stm-field-management-actions">
                            <PanelBarAction
                              icon="fa-trash-can"
                              label={`删除字段 ${f.name}`}
                              danger
                              data-action="delete-preset-field"
                              disabled={readonly || dependent}
                              title={
                                dependent
                                  ? "该字段被显示策略依赖，请先修改显示策略"
                                  : `删除字段 ${f.name}`
                              }
                              onClick={() => deleteField(selectedTableIndex, fi)}
                            />
                          </div>
                        ) : null
                      }
                    />
                  );
                })}
              </FieldList>
            ) : null}
          </TableFieldsPanel>
          <TableConfigSection
            meta={selectedTable.enabled ? undefined : "已停用"}
            items={[
              {
                key: "info",
                title: "表格信息",
                summary: selectedTable.description || selectedTable.key,
                action: "configure-preset-table",
                disabled: readonly,
                onClick: readonly ? undefined : () => openTableForm(selectedTableIndex),
              },
              {
                key: "strategy",
                title: "显示策略",
                summary: presetDisplayStrategySummary(selectedTable),
                action: "configure-preset-display",
                disabled: readonly,
                onClick: readonly
                  ? undefined
                  : () => {
                      rememberScroll();
                      setStrategyEditor(selectedTable.key);
                      setVectorEditor(null);
                      setConfigPage(null);
                    },
              },
              {
                key: "vector",
                title: "向量索引",
                summary: selectedTable.vectorIndex?.enabled ? "已启用" : "未启用",
                action: "configure-preset-vector",
                disabled: readonly,
                onClick: readonly
                  ? undefined
                  : () => {
                      rememberScroll();
                      setVectorEditor(selectedTable.key);
                      setStrategyEditor(null);
                      setConfigPage(null);
                    },
              },
            ]}
          />
        </>
      ) : (
        <>
          <TableFieldsPanel
            status={`${draft.tables.length} 张表`}
            emptyTitle="还没有预设表格"
            actions={
              <>
                {draft.tables.length > 1 ? (
                  <PanelBarAction
                    icon={sortingTables ? "fa-check" : "fa-sort"}
                    label={sortingTables ? "完成排序" : "调整表格顺序"}
                    data-action="toggle-preset-table-order"
                    aria-pressed={sortingTables}
                    disabled={readonly}
                    onClick={() => setSortingTables((prev) => !prev)}
                  />
                ) : null}
                <PanelBarAction
                  icon="fa-plus"
                  label="新建表格"
                  data-action="create-table"
                  disabled={readonly}
                  onClick={() => openTableForm("new")}
                />
              </>
            }
          >
            {draft.tables.length > 0 ? (
              <ul className="stm-grouped-list stm-settings-item-list">
                {draft.tables.map((table, index) => (
                  <li
                    key={table.key}
                    className={sortingTables ? "stm-settings-item-with-action" : undefined}
                    data-table-key={table.key}
                  >
                    <button
                      type="button"
                      className="stm-settings-item-row"
                      data-action="open-preset-table"
                      onClick={() => openTable(table.key)}
                    >
                      <span className="stm-settings-item-main">
                        <span className="stm-settings-item-title">{table.name}</span>
                        <span className="stm-settings-item-summary">
                          {table.key} · {table.fields.length} 个字段
                          {table.enabled ? "" : " · 已停用"}
                        </span>
                      </span>
                      <i className="fa-solid fa-chevron-right" aria-hidden="true" />
                    </button>
                    {sortingTables ? (
                      <div className="stm-bar-group stm-field-management-actions">
                        <PanelBarAction
                          icon="fa-arrow-up"
                          label={`上移表格 ${table.name}`}
                          data-action="move-preset-table-up"
                          disabled={readonly || index === 0}
                          onClick={() => moveTable(index, -1)}
                        />
                        <PanelBarAction
                          icon="fa-arrow-down"
                          label={`下移表格 ${table.name}`}
                          data-action="move-preset-table-down"
                          disabled={readonly || index === draft.tables.length - 1}
                          onClick={() => moveTable(index, 1)}
                        />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </TableFieldsPanel>
        </>
      )}
    </div>
  );
}
