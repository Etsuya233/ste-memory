/**
 * 记忆视图管理器（ticket 02 / ADR 0025）：设置 Tab「记忆宏」组下的视图列表 CRUD。
 *
 * 纯展示层：视图列表/草稿变更走 memory-views-manager-model 纯函数 →
 * onChange(nextViews)（宿主写 settings + macro.kick() 立即重建快照）。
 * 结构：
 * - 视图折叠行：名称 + 摘要（筛选/条数/投影）+ 配置错误徽标（表/字段缺失或
 *   已停用，与服务翻译层同语义）+ 编辑/删除；
 * - 编辑器（新建/编辑共用）：名称 + 表选择 + 筛选字段/值（single_select 选项
 *   多选，short_text 手输逗号分隔）+ 条数上限 + 显示字段多选；
 * - 表/字段数据异步读取（活动空间）；无活动空间时编辑禁用（视图按活动空间求值）。
 */
import { useEffect, useMemo, useState } from "react";
import type { MemoryField, MemoryTable } from "@ste-memory/core/memory";
import type { MemoryView } from "../settings/memory-views.ts";
import { splitListText } from "./record-form-model.ts";
import { reportError, reportSuccess } from "./ui-helpers.tsx";
import {
  emptyMemoryViewDraft,
  isConditionField,
  memoryViewDraftFromView,
  memoryViewFromDraft,
  validateMemoryViewDraft,
  viewConfigErrors,
  viewSummaryText,
  type MemoryViewDraft,
} from "./memory-views-manager-model.ts";

export function MemoryViewsManager(props: {
  /** 活动空间 id；undefined = 无活动空间（列表可看，编辑禁用） */
  readonly spaceId: string | undefined;
  readonly readTables: (spaceId: string) => Promise<readonly MemoryTable[]>;
  readonly readFields: (spaceId: string, tableId: string) => Promise<readonly MemoryField[]>;
  readonly views: readonly MemoryView[];
  /** 视图列表变更（宿主写 settings + macro.kick()） */
  readonly onChange: (views: readonly MemoryView[]) => void;
}) {
  const [tables, setTables] = useState<readonly MemoryTable[] | undefined>(undefined);
  /** 表 Key → 字段（配置错误检测与编辑器选项的数据源） */
  const [fieldsByTable, setFieldsByTable] = useState<ReadonlyMap<string, readonly MemoryField[]>>(
    new Map(),
  );
  const [editing, setEditing] = useState<
    { readonly kind: "new" } | { readonly kind: "edit"; readonly name: string } | null
  >(null);
  const [draft, setDraft] = useState<MemoryViewDraft | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  // 表列表：活动空间变化/视图变化（新表引用）后重取
  useEffect(() => {
    const spaceId = props.spaceId;
    if (!spaceId) {
      setTables(undefined);
      setFieldsByTable(new Map());
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = await props.readTables(spaceId);
        if (!cancelled) setTables(list);
      } catch (readError) {
        reportError(readError);
        if (!cancelled) setTables([]); // 读取失败：列表空（编辑器无表可选）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.spaceId, props.readTables, props.views]);

  /** 需要字段的表 Key：全部视图引用表 + 编辑器当前所选表 */
  const neededTableKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const view of props.views) keys.add(view.tableKey);
    if (draft && draft.tableKey !== "") keys.add(draft.tableKey);
    return keys;
  }, [props.views, draft]);

  useEffect(() => {
    const spaceId = props.spaceId;
    if (!spaceId || tables === undefined) {
      setFieldsByTable(new Map());
      return;
    }
    let cancelled = false;
    void (async () => {
      const next = new Map<string, readonly MemoryField[]>();
      for (const key of neededTableKeys) {
        const table = tables.find((candidate) => candidate.key === key);
        if (!table) continue;
        try {
          const fields = await props.readFields(spaceId, table.id);
          if (cancelled) return;
          next.set(key, fields);
        } catch {
          // 单表字段读取失败：跳过（配置错误徽标按「字段未知」显示）
        }
      }
      if (!cancelled) setFieldsByTable(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [props.spaceId, props.readTables, props.readFields, tables, neededTableKeys]);

  function addView(): void {
    setEditing({ kind: "new" });
    setDraft(emptyMemoryViewDraft());
    setError(undefined);
  }

  function beginEdit(view: MemoryView): void {
    setEditing({ kind: "edit", name: view.name });
    setDraft(memoryViewDraftFromView(view));
    setError(undefined);
  }

  function cancelEdit(): void {
    setEditing(null);
    setDraft(null);
    setError(undefined);
  }

  function saveDraft(): void {
    if (!draft || !editing) return;
    // 全局唯一排除自身（编辑时旧名不算重复）
    const existingNames = props.views
      .filter((view) => editing.kind !== "edit" || view.name !== editing.name)
      .map((view) => view.name);
    const errorText = validateMemoryViewDraft(draft, existingNames);
    if (errorText !== undefined) {
      setError(errorText);
      return;
    }
    const view = memoryViewFromDraft(draft);
    const next =
      editing.kind === "edit"
        ? props.views.map((candidate) => (candidate.name === editing.name ? view : candidate))
        : [...props.views, view];
    props.onChange(next);
    cancelEdit();
    reportSuccess(editing.kind === "edit" ? "视图已保存" : "视图已创建");
  }

  function deleteView(view: MemoryView): void {
    if (!window.confirm(`删除视图「${view.name}」？引用它的宏将展开为空串。`)) return;
    props.onChange(props.views.filter((candidate) => candidate.name !== view.name));
    if (editing?.kind === "edit" && editing.name === view.name) cancelEdit();
    reportSuccess("视图已删除");
  }

  /** 折叠行配置错误：表缺失 = 确定错误（立即显示）；表在但字段未加载完 = 暂不显示（避免误报） */
  function rowConfigErrors(view: MemoryView): readonly string[] {
    if (!props.spaceId || tables === undefined) return [];
    const tableExists = tables.some((candidate) => candidate.key === view.tableKey);
    if (tableExists && !fieldsByTable.has(view.tableKey)) return [];
    return viewConfigErrors(view, tables, fieldsByTable);
  }

  const editingDraftFields =
    draft && draft.tableKey !== "" ? (fieldsByTable.get(draft.tableKey) ?? []) : [];

  return (
    <div className="stm-setting-subgroup" data-stm-section="memory-views">
      <div className="stm-setting-hint">
        <span className="stm-mono">{"{{宏名::视图名}}"}</span> 展开对应视图（无参 {"{{宏名}}"}{" "}
        仍是全部启用表）；视图按活动空间求值， 表/字段缺失时展开为空串并在此显示配置错误
      </div>
      {!props.spaceId && (
        <div className="stm-preset-warning" data-stm-field="memory-views-no-space">
          当前没有活动记忆空间：打开/切换对话后可配置视图
        </div>
      )}
      {props.views.map((view) => (
        <MemoryViewRow
          key={view.name}
          view={view}
          errors={rowConfigErrors(view)}
          onBeginEdit={() => beginEdit(view)}
          onDelete={() => deleteView(view)}
        />
      ))}
      <div className="stm-setting-actions">
        <button
          type="button"
          className="stm-button"
          data-action="add-memory-view"
          disabled={!props.spaceId}
          onClick={addView}
        >
          + 新建视图
        </button>
      </div>
      {editing && draft && (
        <MemoryViewEditor
          draft={draft}
          tables={tables ?? []}
          fields={editingDraftFields}
          error={error}
          onDraftChange={setDraft}
          onSave={saveDraft}
          onCancel={cancelEdit}
        />
      )}
    </div>
  );
}

/** 视图折叠行：名称 + 摘要 + 配置错误徽标 + 编辑/删除 */
function MemoryViewRow(props: {
  readonly view: MemoryView;
  readonly errors: readonly string[];
  readonly onBeginEdit: () => void;
  readonly onDelete: () => void;
}) {
  return (
    <div className="stm-preset-fragment" data-stm-field={`memory-view-${props.view.name}`}>
      <div className="stm-preset-fragment-head">
        <button
          type="button"
          className="stm-preset-fragment-title"
          data-action="edit-memory-view"
          onClick={props.onBeginEdit}
          title="编辑视图"
        >
          <span className="stm-preset-fragment-preview">
            {props.view.name}
            <span className="stm-mono"> · {props.view.tableKey}</span> ·{" "}
            {viewSummaryText(props.view)}
          </span>
        </button>
        <button
          type="button"
          className="stm-preset-fragment-remove"
          data-action="delete-memory-view"
          onClick={props.onDelete}
          title="删除视图"
        >
          ✕
        </button>
      </div>
      {props.errors.length > 0 && (
        <div className="stm-preset-warning" data-stm-field="memory-view-config-error">
          配置错误：{props.errors.join("；")}
        </div>
      )}
    </div>
  );
}

/** 视图编辑器（新建/编辑共用表单；保存校验由父组件执行） */
export function MemoryViewEditor(props: {
  readonly draft: MemoryViewDraft;
  readonly tables: readonly MemoryTable[];
  /** 当前所选表的字段（编辑器选项 + 值输入形态判断的数据源） */
  readonly fields: readonly MemoryField[];
  readonly error: string | undefined;
  readonly onDraftChange: (draft: MemoryViewDraft) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  const { draft } = props;
  const conditionField =
    draft.conditionFieldKey !== ""
      ? props.fields.find((field) => field.key === draft.conditionFieldKey)
      : undefined;
  const conditionFields = props.fields.filter((field) => isConditionField(field));

  function toggleConditionValue(value: string): void {
    const has = draft.conditionValues.includes(value);
    props.onDraftChange({
      ...draft,
      conditionValues: has
        ? draft.conditionValues.filter((candidate) => candidate !== value)
        : [...draft.conditionValues, value],
    });
  }

  function toggleProjection(key: string): void {
    const has = draft.projection.includes(key);
    props.onDraftChange({
      ...draft,
      projection: has
        ? draft.projection.filter((candidate) => candidate !== key)
        : [...draft.projection, key],
    });
  }

  return (
    <div className="stm-preset-editor" data-stm-section="memory-view-editor">
      <div className="stm-setting-row">
        <div className="stm-setting-label">
          <div className="stm-setting-name">视图名</div>
          <div className="stm-setting-hint">中文可用；不含空白 / :: / | / {"}}"}</div>
        </div>
        <input
          type="text"
          className="stm-input"
          data-stm-field="memory-view-name"
          value={draft.name}
          placeholder="如：未完成伏笔"
          onChange={(event) => props.onDraftChange({ ...draft, name: event.target.value })}
        />
      </div>
      <div className="stm-setting-row">
        <div className="stm-setting-label">
          <div className="stm-setting-name">表格</div>
        </div>
        <select
          className="stm-input"
          data-stm-field="memory-view-table"
          value={draft.tableKey}
          onChange={(event) =>
            props.onDraftChange({
              ...draft,
              tableKey: event.target.value,
              conditionFieldKey: "",
              conditionValues: [],
              projection: [],
            })
          }
        >
          <option value="">选择表格…</option>
          {props.tables.map((table) => (
            <option key={table.key} value={table.key}>
              {table.key} · {table.name}
            </option>
          ))}
        </select>
      </div>
      <div className="stm-setting-row">
        <div className="stm-setting-label">
          <div className="stm-setting-name">筛选字段</div>
          <div className="stm-setting-hint">仅 single_select / short_text 字段</div>
        </div>
        <select
          className="stm-input"
          data-stm-field="memory-view-condition-field"
          value={draft.conditionFieldKey}
          onChange={(event) =>
            props.onDraftChange({
              ...draft,
              conditionFieldKey: event.target.value,
              conditionValues: [],
            })
          }
        >
          <option value="">无筛选</option>
          {conditionFields.map((field) => (
            <option key={field.key} value={field.key}>
              {field.name}（{field.key}）
            </option>
          ))}
        </select>
      </div>
      {draft.conditionFieldKey !== "" && (
        <div className="stm-setting-row">
          <div className="stm-setting-label">
            <div className="stm-setting-name">筛选值</div>
            <div className="stm-setting-hint">
              {conditionField?.type === "single_select"
                ? "多选（匹配任一值）"
                : "多个值用逗号分隔（匹配任一值）"}
            </div>
          </div>
          {conditionField?.type === "single_select" ? (
            <div className="stm-checkbox-group" data-stm-field="memory-view-condition-values">
              {(conditionField.options ?? []).map((option) => (
                <label key={option} className="stm-checkbox-label">
                  <input
                    type="checkbox"
                    data-action="toggle-condition-value"
                    checked={draft.conditionValues.includes(option)}
                    onChange={() => toggleConditionValue(option)}
                  />
                  <span>{option}</span>
                </label>
              ))}
            </div>
          ) : (
            <input
              type="text"
              className="stm-input"
              data-stm-field="memory-view-condition-values"
              value={draft.conditionValues.join("、")}
              placeholder="埋设中、已触发"
              onChange={(event) =>
                props.onDraftChange({
                  ...draft,
                  conditionValues: splitListText(event.target.value),
                })
              }
            />
          )}
        </div>
      )}
      <div className="stm-setting-row">
        <div className="stm-setting-label">
          <div className="stm-setting-name">条数上限</div>
          <div className="stm-setting-hint">留空 = 最多 100 条（按更新时间倒序）</div>
        </div>
        <input
          type="number"
          className="stm-input"
          min="1"
          max="100"
          data-stm-field="memory-view-limit"
          value={draft.limitText}
          placeholder="100"
          onChange={(event) => props.onDraftChange({ ...draft, limitText: event.target.value })}
        />
      </div>
      <div className="stm-setting-row">
        <div className="stm-setting-label">
          <div className="stm-setting-name">显示字段</div>
          <div className="stm-setting-hint">不选 = 沿用显示文本；引用字段显示目标记录文本</div>
        </div>
        <div className="stm-checkbox-group" data-stm-field="memory-view-projection">
          {props.fields.map((field) => (
            <label key={field.key} className="stm-checkbox-label">
              <input
                type="checkbox"
                data-action="toggle-projection-field"
                checked={draft.projection.includes(field.key)}
                onChange={() => toggleProjection(field.key)}
              />
              <span>
                {field.name}（{field.key}）
              </span>
            </label>
          ))}
        </div>
      </div>
      {props.error !== undefined && (
        <div className="stm-preset-warning" data-stm-field="memory-view-error">
          {props.error}
        </div>
      )}
      <div className="stm-setting-actions">
        <button
          type="button"
          className="stm-button"
          data-action="save-memory-view"
          onClick={props.onSave}
        >
          保存
        </button>
        <button
          type="button"
          className="stm-button"
          data-action="cancel-memory-view"
          onClick={props.onCancel}
        >
          取消
        </button>
      </div>
    </div>
  );
}
