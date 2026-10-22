import { useEffect, useRef, useState } from "react";
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
  presetFieldUsedForDisplay,
  renamePresetDisplayField,
  replacePresetTable,
} from "./table-preset-editor-model.ts";

export function TablePresetEditor(props: {
  readonly initial: ResolvedTablePreset;
  readonly isNew: boolean;
  readonly onSave: (preset: ResolvedTablePreset) => void;
  readonly onClose: () => void;
  readonly registerLeaveGuard?: (guard: (() => boolean) | null) => void;
}) {
  const [draft, setDraft] = useState(props.initial);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(
    () => new Set(props.initial.tables.slice(0, 1).map((table) => table.key)),
  );
  const [managing, setManaging] = useState<ReadonlySet<string>>(new Set());
  const [strategyEditor, setStrategyEditor] = useState<string | null>(null);
  const [vectorEditor, setVectorEditor] = useState<string | null>(null);
  function toggleExpanded(key: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  const [tableEditor, setTableEditor] = useState<number | "new" | null>(null);
  const [fieldEditor, setFieldEditor] = useState<{ table: number; field: number | "new" } | null>(
    null,
  );
  // 子表单尚未提交的输入也必须参与离开提示。
  const [formDirty, setFormDirty] = useState(false);
  const formContainer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    formContainer.current?.scrollIntoView({ block: "nearest" });
  }, [tableEditor, fieldEditor]);
  const dirty = formDirty || JSON.stringify(draft) !== JSON.stringify(props.initial);
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
  function updateTable(index: number, table: TablePresetTable) {
    setDraft({ ...draft, tables: replacePresetTable(draft.tables, index, table) });
  }
  function close() {
    if (!dirty || window.confirm("预设有未保存的修改，放弃修改并返回列表吗？")) props.onClose();
  }
  function moveTable(index: number, delta: number) {
    const tables = [...draft.tables];
    [tables[index], tables[index + delta]] = [tables[index + delta]!, tables[index]!];
    setDraft({ ...draft, tables });
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
    <div ref={formContainer} onChangeCapture={() => setFormDirty(true)}>
      <TableEditorForm
        key={tableEditor}
        title={tableEditor === "new" ? "新增表格" : "编辑表格"}
        initial={tableEditor === "new" ? EMPTY_TABLE_DRAFT : draft.tables[tableEditor]!}
        submitLabel="完成表格编辑"
        onCancel={() => {
          setTableEditor(null);
          setFormDirty(false);
        }}
        onSave={(value) =>
          run(() => {
            const normalized = { ...value, key: value.key.trim(), name: value.name.trim() };
            if (tableEditor === "new") {
              if (draft.tables.some((t) => t.key === normalized.key))
                throw new Error(`表格 Key 已存在：${normalized.key}`);
              setDraft({
                ...draft,
                tables: [
                  ...draft.tables,
                  { ...normalized, enabled: true, displayStrategy: null, fields: [] },
                ],
              });
            } else updateTable(tableEditor, { ...draft.tables[tableEditor]!, ...normalized });
            setTableEditor(null);
            setFormDirty(false);
          })
        }
      />
    </div>
  );
  const fieldForm = fieldEditor && fieldTable && (
    <div ref={formContainer} onChangeCapture={() => setFormDirty(true)}>
      <FieldEditorForm
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
        onCancel={() => {
          setFieldEditor(null);
          setFormDirty(false);
        }}
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
              maxChars: sameType ? field.maxChars : null,
              valuePattern: sameType ? field.valuePattern : null,
              valuePatternMessage: sameType ? field.valuePatternMessage : null,
            };
            updateTable(fieldEditor.table, {
              ...fieldTable,
              displayStrategy: field
                ? renamePresetDisplayField(fieldTable, field.key, updated.key)
                : fieldTable.displayStrategy,
              fields:
                fieldEditor.field === "new"
                  ? [...fieldTable.fields, updated]
                  : fieldTable.fields.map((f, i) => (i === fieldEditor.field ? updated : f)),
            });
            setFieldEditor(null);
            setFormDirty(false);
          })
        }
      />
    </div>
  );
  return (
    <div className="stm-preset-table-page" data-stm-section="table-preset-editor">
      <div className="stm-preset-page-header">
        <button type="button" className="stm-table-action" onClick={close}>
          <i className="fa-solid fa-arrow-left" aria-hidden="true" /> 返回预设列表
        </button>
        <div className="stm-preset-page-title">
          <strong>
            {readonly ? "查看预设" : props.isNew ? "新建预设" : "编辑预设"}
            {draft.name && ` · ${draft.name}`}
          </strong>
          {dirty && <span className="stm-preset-badge">未保存</span>}
        </div>
        {!readonly && (
          <button
            type="button"
            className="stm-button stm-button--primary"
            data-action="save-table-preset"
            disabled={editing}
            onClick={() => run(() => props.onSave(draft))}
          >
            保存预设
          </button>
        )}
      </div>
      {error && (
        <div role="alert" className="stm-form-error">
          {error}
        </div>
      )}
      <details className="stm-table-card stm-preset-info" open={props.isNew}>
        <summary className="stm-preset-info-summary">预设信息与通用填写规则</summary>
        <fieldset disabled={readonly || editing} className="stm-editor stm-preset-editor-fields">
          <label className="stm-form-row">
            <span className="stm-form-label">预设名称</span>
            <input
              className="stm-input"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label className="stm-form-row">
            <span className="stm-form-label">说明</span>
            <input
              className="stm-input"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>
          <label className="stm-form-row">
            <span className="stm-form-label">通用填写规则</span>
            <textarea
              className="stm-textarea"
              rows={3}
              value={draft.prompt ?? ""}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
            />
          </label>
          <div className="stm-setting-hint">
            保存只更新预设库，已有空间保持原状。修改 Key 后请检查填写规则中的文字引用。
          </div>
        </fieldset>
      </details>
      {!readonly && (
        <div className="stm-table-actions stm-table-actions--top">
          <button
            type="button"
            className="stm-button stm-button--primary"
            data-action="create-table"
            disabled={editing}
            onClick={() => setTableEditor("new")}
          >
            新建表格
          </button>
        </div>
      )}
      {tableEditor === "new" && tableForm}
      {draft.tables.length === 0 && (
        <div className="stm-empty">
          <div className="stm-empty-title">还没有预设表格</div>
          <div className="stm-empty-hint">点击上方「新建表格」开始配置</div>
        </div>
      )}
      <ul className="stm-table-list">
        {draft.tables.map((table, ti) => {
          const isExpanded = expanded.has(table.key);
          const isManagingFields = managing.has(table.key);
          const strategy = table.displayStrategy;
          const strategyText =
            strategy?.type === "field"
              ? `显示字段：${table.fields.find((f) => f.key === strategy.fieldKey)?.name ?? strategy.fieldKey}`
              : strategy?.type === "template"
                ? `显示模板：${strategy.template}`
                : "未配置显示策略";
          return (
            <li className="stm-table-card" key={table.key} data-table-key={table.key}>
              <div
                className="stm-table-row"
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest(".stm-switch")) return;
                  toggleExpanded(table.key);
                }}
              >
                <button
                  type="button"
                  className="stm-expand"
                  data-action="expand-table"
                  aria-label={isExpanded ? "收起字段" : "展开字段"}
                  aria-expanded={isExpanded}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleExpanded(table.key);
                  }}
                >
                  <i
                    className={`fa-solid ${isExpanded ? "fa-chevron-up" : "fa-chevron-down"}`}
                    aria-hidden="true"
                  />
                </button>
                <div className="stm-table-row-main">
                  <div className="stm-table-name">{table.name}</div>
                  <div className="stm-table-meta">
                    {table.key} ·{" "}
                    {table.fields.length === 0
                      ? "无字段"
                      : `${table.fields.filter((f) => f.enabled).length}/${table.fields.length} 字段启用`}{" "}
                    · {strategyText}
                  </div>
                </div>
                <label className="stm-switch">
                  <input
                    type="checkbox"
                    aria-label={`启用表格 ${table.name}`}
                    checked={table.enabled}
                    disabled={readonly || editing}
                    onChange={(e) => updateTable(ti, { ...table, enabled: e.target.checked })}
                  />
                  <span className="stm-switch-track" aria-hidden="true" />
                </label>
              </div>
              {!readonly && (
                <div className="stm-table-actions stm-preset-card-actions">
                  <button
                    type="button"
                    className="stm-table-action"
                    data-action="edit-table"
                    disabled={editing}
                    onClick={() => setTableEditor(ti)}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="stm-table-action"
                    data-action="add-field"
                    disabled={editing}
                    onClick={() => {
                      setExpanded(new Set(expanded).add(table.key));
                      setFieldEditor({ table: ti, field: "new" });
                    }}
                  >
                    新增字段
                  </button>
                  <button
                    type="button"
                    className="stm-table-action"
                    data-action="edit-display-strategy"
                    aria-pressed={strategyEditor === table.key}
                    disabled={editing}
                    onClick={() =>
                      setStrategyEditor(strategyEditor === table.key ? null : table.key)
                    }
                  >
                    显示策略
                  </button>
                  <button
                    type="button"
                    className="stm-table-action"
                    data-action="edit-preset-vector-index"
                    aria-pressed={vectorEditor === table.key}
                    disabled={editing}
                    onClick={() => setVectorEditor(vectorEditor === table.key ? null : table.key)}
                  >
                    向量索引
                  </button>
                  <button
                    type="button"
                    className="stm-table-action"
                    aria-label={`上移表格 ${table.name}`}
                    disabled={editing || ti === 0}
                    onClick={() => moveTable(ti, -1)}
                  >
                    上移
                  </button>
                  <button
                    type="button"
                    className="stm-table-action"
                    aria-label={`下移表格 ${table.name}`}
                    disabled={editing || ti === draft.tables.length - 1}
                    onClick={() => moveTable(ti, 1)}
                  >
                    下移
                  </button>
                  <button
                    type="button"
                    className="stm-table-action stm-table-action--danger"
                    data-action="delete-table"
                    disabled={editing}
                    onClick={() =>
                      run(() => {
                        const dependencies = draft.tables.flatMap((t, i) =>
                          i === ti
                            ? []
                            : t.fields
                                .filter((f) => f.referenceTableKey === table.key)
                                .map((f) => `${t.name}.${f.name}`),
                        );
                        if (dependencies.length)
                          throw new Error(`请先调整引用字段：${dependencies.join("、")}`);
                        if (window.confirm(`删除预设表「${table.name}」及其全部字段？`))
                          setDraft({ ...draft, tables: draft.tables.filter((_, i) => i !== ti) });
                      })
                    }
                  >
                    删除
                  </button>
                </div>
              )}
              {tableEditor === ti && tableForm}
              {strategyEditor === table.key && (
                <div className="stm-editor" data-stm-editor="display-strategy">
                  <div className="stm-editor-title">显示策略</div>
                  <fieldset disabled={editing} className="stm-preset-editor-fields">
                    <label className="stm-form-row">
                      <span className="stm-form-label">显示策略类型</span>
                      <select
                        className="stm-select"
                        aria-label="显示策略"
                        value={strategy?.type ?? "none"}
                        onChange={(e) =>
                          updateTable(ti, {
                            ...table,
                            displayStrategy:
                              e.target.value === "none"
                                ? null
                                : e.target.value === "field"
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
                        <span className="stm-form-label">显示字段（短文本）</span>
                        <select
                          aria-label="显示字段"
                          className="stm-select"
                          value={strategy.fieldKey}
                          onChange={(e) =>
                            updateTable(ti, {
                              ...table,
                              displayStrategy: { type: "field", fieldKey: e.target.value },
                            })
                          }
                        >
                          <option value="">请选择字段</option>
                          {table.fields
                            .filter((f) => f.type === "short_text" && f.enabled)
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
                        <span className="stm-form-label">
                          显示模板（使用 {"{字段Key}"} 引用字段）
                        </span>
                        <textarea
                          className="stm-textarea"
                          value={strategy.template}
                          onChange={(e) =>
                            updateTable(ti, {
                              ...table,
                              displayStrategy: { type: "template", template: e.target.value },
                            })
                          }
                        />
                      </label>
                    )}
                  </fieldset>
                  <div className="stm-editor-actions">
                    <button
                      type="button"
                      className="stm-button"
                      onClick={() => setStrategyEditor(null)}
                    >
                      完成
                    </button>
                  </div>
                </div>
              )}
              {vectorEditor === table.key && (
                <PresetVectorIndexEditor
                  table={table}
                  readonly={readonly}
                  onChange={(vectorIndex) => updateTable(ti, { ...table, vectorIndex })}
                />
              )}
              {isExpanded && (
                <>
                  {readonly && (table.description || table.prompt) && (
                    <div className="stm-editor">
                      <div className="stm-setting-hint">{table.description}</div>
                      <div className="stm-setting-hint">{table.prompt}</div>
                    </div>
                  )}
                  <div className="stm-field-edit-toggle">
                    {!readonly ? (
                      <button
                        type="button"
                        className="stm-table-action"
                        data-action="toggle-field-edit"
                        disabled={editing}
                        aria-pressed={isManagingFields}
                        onClick={() =>
                          setManaging((previous) => {
                            const next = new Set(previous);
                            if (next.has(table.key)) next.delete(table.key);
                            else next.add(table.key);
                            return next;
                          })
                        }
                      >
                        {isManagingFields ? "完成字段管理" : "管理字段"}
                      </button>
                    ) : (
                      <span className="stm-table-meta">字段定义</span>
                    )}
                  </div>
                  <ul className="stm-field-list">
                    {table.fields.map((f, fi) => {
                      const dependent = presetFieldUsedForDisplay(table, f.key);
                      return (
                        <li className="stm-field-row" key={f.key}>
                          <div className="stm-field-info">
                            <div className="stm-field-name">
                              {f.name}
                              {f.required && (
                                <span className="stm-field-required" title="必填">
                                  *
                                </span>
                              )}
                              {dependent && <span className="stm-field-dep">显示策略依赖</span>}
                            </div>
                            <div className="stm-field-tag">
                              {f.key} · {FIELD_TYPE_LABELS[f.type]}
                              {f.referenceTableKey && ` → ${f.referenceTableKey}`}
                            </div>
                          </div>
                          <label
                            className="stm-switch"
                            title={dependent ? "该字段被显示策略依赖，不能停用" : undefined}
                          >
                            <input
                              type="checkbox"
                              aria-label={`启用字段 ${f.name}`}
                              checked={f.enabled}
                              disabled={readonly || editing || dependent}
                              onChange={(e) =>
                                updateTable(ti, {
                                  ...table,
                                  fields: table.fields.map((item, index) =>
                                    index === fi ? { ...item, enabled: e.target.checked } : item,
                                  ),
                                })
                              }
                            />
                            <span className="stm-switch-track" aria-hidden="true" />
                          </label>
                          {isManagingFields && !readonly && (
                            <div className="stm-field-edit-row">
                              <button
                                type="button"
                                className="stm-field-action"
                                disabled={editing || fi === 0}
                                aria-label={`上移字段 ${f.name}`}
                                onClick={() => moveField(ti, fi, -1)}
                              >
                                <i className="fa-solid fa-arrow-up" aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="stm-field-action"
                                disabled={editing || fi === table.fields.length - 1}
                                aria-label={`下移字段 ${f.name}`}
                                onClick={() => moveField(ti, fi, 1)}
                              >
                                <i className="fa-solid fa-arrow-down" aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="stm-field-action"
                                data-action="edit-field"
                                disabled={editing}
                                aria-label={`编辑字段 ${f.name}`}
                                onClick={() => setFieldEditor({ table: ti, field: fi })}
                              >
                                <i className="fa-solid fa-pen" aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="stm-field-action stm-field-action--danger"
                                data-action="delete-field"
                                disabled={editing || dependent}
                                title={dependent ? "该字段被显示策略依赖，不能删除" : undefined}
                                aria-label={`删除字段 ${f.name}`}
                                onClick={() => {
                                  if (window.confirm(`删除字段「${f.name}」？`))
                                    updateTable(ti, {
                                      ...table,
                                      fields: table.fields.filter((_, i) => i !== fi),
                                    });
                                }}
                              >
                                <i className="fa-solid fa-trash" aria-hidden="true" />
                              </button>
                            </div>
                          )}
                          {(isManagingFields || readonly) && (
                            <details className="stm-preset-field-constraints">
                              <summary>填写规则与字段约束</summary>
                              <fieldset
                                className="stm-preset-editor-fields"
                                disabled={readonly || editing}
                              >
                                {f.prompt && <div className="stm-setting-hint">{f.prompt}</div>}
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
                                      value={f[key] ?? ""}
                                      onChange={(e) =>
                                        updateTable(ti, {
                                          ...table,
                                          fields: table.fields.map((item, i) =>
                                            i === fi
                                              ? {
                                                  ...item,
                                                  [key]:
                                                    e.target.value === ""
                                                      ? null
                                                      : key === "maxChars"
                                                        ? Number(e.target.value)
                                                        : e.target.value,
                                                }
                                              : item,
                                          ),
                                        })
                                      }
                                    />
                                  </label>
                                ))}
                              </fieldset>
                            </details>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
              {fieldEditor?.table === ti && fieldForm}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
