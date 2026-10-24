/**
 * 全局宏管理器（原记忆视图管理器）：设置 Tab「记忆宏」组「全局宏」分区的列表 CRUD。
 *
 * 纯展示层：宏列表/草稿变更走 memory-views-manager-model 纯函数 →
 * onChange(nextViews)（宿主写 settings + macro.kick() 立即重建快照）。
 * 结构：
 * - 空态邀请（说明 + 新建入口）；有活动空间才能编辑（宏按活动空间求值）；
 * - 宏行：名称 + 宏表达式 + 表名/筛选/条数/投影摘要 + 输出体积 + 复制；
 * - 编辑器（新建/编辑共用）：名称（含表达式反馈）+ 表 + 筛选 + 显示字段 + 条数；
 * - 同名覆盖（对话宏优先）在行内提示。
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { MemoryField, MemoryTable } from "../../features/memory/index.ts";
import { validateMemoryViewName } from "../../features/macros/memory-views.ts";
import type { MemoryView } from "../../features/macros/memory-views.ts";
import { splitListText } from "../memory/record-form-model.ts";
import { copyText, reportError, reportSuccess, reportWarning } from "../shell/ui-helpers.tsx";
import { useSettingsPageNavigation } from "./settings-page-navigation.ts";
import { PageChrome } from "../shell/page-layout.tsx";
import { PanelBar, PanelBarAction } from "../shell/panel-bar.tsx";
import { Disclosure } from "../shell/disclosure.tsx";
import { MacroScopeList } from "./macro-scope-list.tsx";
import {
  builtinMacroNames,
  macroConflictBadges,
  macroToken,
  type MacroConflictBadge,
} from "./macro-ui-model.ts";
import {
  emptyMemoryViewDraft,
  isConditionField,
  memoryViewDraftFromView,
  memoryViewFromDraft,
  validateMemoryViewDraft,
  viewConfigErrors,
  type MemoryViewDraft,
} from "./memory-views-manager-model.ts";

export function MemoryViewsManager(props: {
  readonly onCreateActionChange?: (
    action: { label: string; dataAction: string; disabled: boolean; onClick: () => void } | null,
  ) => void;
  readonly onEditingChange?: (editing: boolean) => void;
  readonly registerLeaveGuard?: (guard: (() => boolean) | null) => void;
  /** 合法宏名（裸标识符，如 ste；宏表达式展示与预览用） */
  readonly prefix: string;
  /** 活动空间 id；undefined = 无活动空间（列表可看，编辑禁用） */
  readonly spaceId: string | undefined;
  readonly readTables: (spaceId: string) => Promise<readonly MemoryTable[]>;
  readonly readFields: (spaceId: string, tableId: string) => Promise<readonly MemoryField[]>;
  /** 宏展开文本读取口：完整宏名（{{...}} 形态）→ 预计算快照文本（未知 = 空串） */
  readonly readPreview: (name: string) => string;
  /** 当前对话的对话宏名（同名覆盖提示） */
  readonly chatMacroNames?: readonly string[];
  readonly views: readonly MemoryView[];
  /** 宏列表变更（宿主写 settings + macro.kick()） */
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
  const { screenRef, rememberScroll } = useSettingsPageNavigation(
    editing ? (editing.kind === "new" ? "new:macro" : `edit:macro:${editing.name}`) : "list",
  );
  const hasActiveSpace = props.spaceId !== undefined;

  useEffect(() => {
    props.onEditingChange?.(editing !== null);
    return () => props.onEditingChange?.(false);
  }, [editing, props.onEditingChange]);

  useEffect(() => {
    props.onCreateActionChange?.(
      editing
        ? null
        : {
            label: "新建全局宏",
            dataAction: "add-memory-view",
            disabled: !hasActiveSpace,
            onClick: addView,
          },
    );
    return () => props.onCreateActionChange?.(null);
  }, [editing, hasActiveSpace, props.onCreateActionChange]);

  // 表列表：活动空间变化/宏变化（新表引用）后重取
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

  /** 需要字段的表 Key：全部宏引用表 + 编辑器当前所选表 */
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
  }, [props.spaceId, props.readFields, tables, neededTableKeys]);

  const builtinNames = useMemo(() => builtinMacroNames(tables), [tables]);
  const chatNames = useMemo(() => new Set(props.chatMacroNames ?? []), [props.chatMacroNames]);

  function badgesFor(macro: MemoryView): readonly MacroConflictBadge[] {
    return macroConflictBadges({
      scope: "global",
      name: macro.name,
      chatNames,
      builtinNames,
    });
  }

  function addView(): void {
    if (!hasActiveSpace) return;
    rememberScroll();
    setEditing({ kind: "new" });
    setDraft(emptyMemoryViewDraft());
    setError(undefined);
  }

  function beginEdit(view: MemoryView): void {
    if (!hasActiveSpace) return;
    rememberScroll();
    setEditing({ kind: "edit", name: view.name });
    setDraft(memoryViewDraftFromView(view));
    setError(undefined);
  }

  function cancelEdit(): void {
    rememberScroll();
    setEditing(null);
    setDraft(null);
    setError(undefined);
  }

  function saveDraft(): void {
    if (!draft || !editing || !hasActiveSpace) return;
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
    reportSuccess(editing.kind === "edit" ? "宏已保存" : "宏已创建");
  }

  function deleteView(view: MemoryView): void {
    if (!window.confirm(`删除宏「${view.name}」？所有使用该宏的位置将展开为空内容。`)) return;
    props.onChange(props.views.filter((candidate) => candidate.name !== view.name));
    if (editing?.kind === "edit" && editing.name === view.name) cancelEdit();
    reportSuccess("宏已删除");
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

  if (editing && draft)
    return (
      <div ref={screenRef} className="stm-settings-editor-page">
        <MemoryViewEditor
          chrome
          title={editing.kind === "new" ? "新建全局宏" : "编辑全局宏"}
          prefix={props.prefix}
          draft={draft}
          tables={tables ?? []}
          fields={editingDraftFields}
          error={error}
          unavailable={!hasActiveSpace}
          onDraftChange={setDraft}
          onSave={saveDraft}
          onCancel={cancelEdit}
          registerLeaveGuard={props.registerLeaveGuard}
          onDelete={
            editing.kind === "edit"
              ? () => deleteView(props.views.find((view) => view.name === editing.name)!)
              : undefined
          }
          previewText={
            editing.kind === "edit" && props.prefix !== ""
              ? props.readPreview(macroToken(props.prefix, editing.name))
              : undefined
          }
        />
      </div>
    );

  const emptyHint = hasActiveSpace
    ? props.prefix === ""
      ? "先到宏设置配置有效宏名，再新建全局宏。"
      : `全局宏在所有对话共享；在提示词预设或世界书条目中写 ${macroToken(props.prefix, "名字")} 即可注入。`
    : "全局宏按当前对话的空间求值；打开或切换一个对话后即可创建和编辑。";
  const emptyTitle = hasActiveSpace ? "还没有全局宏" : "先打开一个对话";

  return (
    <div ref={screenRef} className="stm-setting-subgroup" data-stm-section="memory-views">
      {!hasActiveSpace && props.views.length > 0 && (
        <div className="stm-macro-notice" data-stm-field="memory-views-no-space">
          当前没有活动记忆空间：列表可查看，打开或切换对话后才能编辑。
        </div>
      )}
      <MacroScopeList
        macros={props.views}
        prefix={props.prefix}
        tables={tables}
        fieldsByTable={fieldsByTable}
        hasActiveSpace={hasActiveSpace}
        readPreview={props.readPreview}
        errorsFor={rowConfigErrors}
        badgesFor={badgesFor}
        onEdit={beginEdit}
        dataFieldPrefix="memory-view-"
        editAction="edit-memory-view"
        copyAction="copy-memory-view-token"
        errorField="memory-view-config-error"
        emptyTitle={emptyTitle}
        emptyHint={emptyHint}
        emptyActionLabel="新建全局宏"
        emptyAction="add-memory-view"
        onEmptyAction={addView}
        createDisabled={!hasActiveSpace}
      />
      {props.views.length > 0 && (
        <div className="stm-setting-hint" data-stm-field="memory-views-usage-hint">
          {props.prefix === "" ? (
            "先在宏设置中配置有效宏名，宏才会注册。"
          ) : (
            <>
              在提示词预设或世界书条目中写{" "}
              <span className="stm-mono">{macroToken(props.prefix, "宏名")}</span>{" "}
              使用；同名对话宏优先于全局宏。
            </>
          )}
        </div>
      )}
      {props.views.length > 0 && !props.onCreateActionChange && (
        <div className="stm-setting-actions">
          <button
            type="button"
            className="stm-button"
            data-action="add-memory-view"
            disabled={!hasActiveSpace}
            onClick={addView}
          >
            + 新建全局宏
          </button>
        </div>
      )}
    </div>
  );
}

/** 宏编辑器（新建/编辑共用表单；保存校验由父组件执行） */
export function MemoryViewEditor(props: {
  readonly chrome?: boolean;
  readonly title?: string;
  readonly unavailable?: boolean;
  /** 合法宏名（裸标识符）；用于行内展示将展开的表达式 */
  readonly prefix: string;
  readonly previewText?: string;
  readonly onDelete?: () => void;
  readonly registerLeaveGuard?: (guard: (() => boolean) | null) => void;
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
  const formId = useId();
  const initial = useRef(JSON.stringify(draft));
  const dirty = JSON.stringify(draft) !== initial.current;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    const guard = () => !dirtyRef.current || window.confirm("宏有未保存的修改，放弃修改并离开吗？");
    props.registerLeaveGuard?.(guard);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      props.registerLeaveGuard?.(null);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [props.registerLeaveGuard]);
  function cancel() {
    if (!dirty || window.confirm("宏有未保存的修改，放弃修改并返回吗？")) props.onCancel();
  }

  const conditionField =
    draft.conditionFieldKey !== ""
      ? props.fields.find((field) => field.key === draft.conditionFieldKey)
      : undefined;
  const conditionFields = props.fields.filter((field) => isConditionField(field));
  const nameError = draft.name.trim() === "" ? undefined : validateMemoryViewName(draft.name);
  const token =
    props.prefix !== "" && draft.name.trim() !== "" && nameError === undefined
      ? macroToken(props.prefix, draft.name)
      : "";

  function toggleConditionValue(value: string): void {
    const has = draft.conditionValues.includes(value);
    props.onDraftChange({
      ...draft,
      conditionValues: has
        ? draft.conditionValues.filter((candidate) => candidate !== value)
        : [...draft.conditionValues, value],
    });
  }

  function setConditionValues(values: readonly string[]): void {
    props.onDraftChange({ ...draft, conditionValues: [...values] });
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

  function selectAllProjection(selected: boolean): void {
    props.onDraftChange({
      ...draft,
      projection: selected ? props.fields.map((field) => field.key) : [],
    });
  }

  function copyPreview(): void {
    if (props.previewText === undefined) return;
    void copyText(props.previewText)
      .then((copied) => {
        if (copied) reportSuccess("已复制宏输出");
        else reportWarning("复制失败：浏览器不支持剪贴板写入");
      })
      .catch(() => reportWarning("复制失败：无法写入剪贴板"));
  }

  return (
    <form
      id={formId}
      className="stm-preset-editor stm-settings-form"
      data-stm-section="memory-view-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (!props.unavailable) props.onSave();
      }}
    >
      {props.chrome && (
        <PageChrome
          pageKey={props.title}
          header={
            <PanelBar
              title={props.title}
              leading={
                <PanelBarAction
                  icon="fa-arrow-left"
                  label="返回宏列表"
                  data-action="cancel-memory-view"
                  onClick={cancel}
                />
              }
              trailing={
                <>
                  {props.onDelete && (
                    <PanelBarAction
                      icon="fa-trash"
                      label="删除宏"
                      data-action="delete-current-macro"
                      danger
                      disabled={props.unavailable}
                      onClick={props.onDelete}
                    />
                  )}
                  <PanelBarAction
                    icon="fa-check"
                    label="保存宏"
                    disabled={props.unavailable}
                    data-action="save-memory-view"
                    type="submit"
                    form={formId}
                  />
                </>
              }
            />
          }
        />
      )}
      {props.previewText !== undefined && (
        <Disclosure
          icon="fa-eye"
          title="已保存的宏输出"
          meta={`${props.previewText.length} 字`}
          data-stm-field="memory-view-preview"
        >
          <pre className="stm-mono stm-modal-text">{props.previewText || "（空）"}</pre>
          <button
            type="button"
            className="stm-button"
            data-action="copy-macro-preview"
            onClick={copyPreview}
          >
            复制输出
          </button>
        </Disclosure>
      )}
      {props.error !== undefined && (
        <div className="stm-preset-warning" data-stm-field="memory-view-error">
          {props.error}
        </div>
      )}
      <div className="stm-setting-row">
        <div className="stm-setting-label">
          <div className="stm-setting-name">宏名</div>
          <div className="stm-setting-hint">中文可用；不含空白 / :: / | / {"}}"}</div>
        </div>
        <input
          type="text"
          className="stm-input"
          data-stm-field="memory-view-name"
          value={draft.name}
          placeholder="如：未完成伏笔"
          disabled={props.unavailable}
          onChange={(event) => props.onDraftChange({ ...draft, name: event.target.value })}
        />
        {nameError !== undefined && (
          <div className="stm-preset-warning" data-stm-field="memory-view-name-error">
            {nameError.replaceAll("视图名", "宏名")}
          </div>
        )}
        {token !== "" && (
          <div className="stm-setting-hint" data-stm-field="memory-view-token">
            展开为 <span className="stm-mono">{token}</span>
          </div>
        )}
        {props.prefix === "" && (
          <div className="stm-macro-notice">先在宏设置中配置有效宏名，保存后才能展开。</div>
        )}
      </div>
      <div className="stm-setting-row">
        <div className="stm-setting-label">
          <div className="stm-setting-name">表格</div>
        </div>
        <select
          className="stm-input"
          data-stm-field="memory-view-table"
          value={draft.tableKey}
          disabled={props.unavailable}
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
      {draft.tableKey !== "" && (
        <>
          <div className="stm-setting-row">
            <div className="stm-setting-label">
              <div className="stm-setting-name">筛选字段</div>
            </div>
            <select
              className="stm-input"
              data-stm-field="memory-view-condition-field"
              value={draft.conditionFieldKey}
              disabled={props.unavailable}
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
                    : "输入后按回车或逗号添加（匹配任一值）"}
                </div>
              </div>
              {conditionField?.type === "single_select" ? (
                <>
                  <div className="stm-macro-field-toolbar">
                    <button
                      type="button"
                      className="stm-text-button"
                      data-action="select-all-condition-values"
                      disabled={props.unavailable}
                      onClick={() => setConditionValues(conditionField.options ?? [])}
                    >
                      全选
                    </button>
                    <button
                      type="button"
                      className="stm-text-button"
                      data-action="clear-condition-values"
                      disabled={props.unavailable}
                      onClick={() => setConditionValues([])}
                    >
                      清空
                    </button>
                  </div>
                  <div className="stm-checkbox-group" data-stm-field="memory-view-condition-values">
                    {(conditionField.options ?? []).map((option) => (
                      <label key={option} className="stm-checkbox-label">
                        <input
                          type="checkbox"
                          data-action="toggle-condition-value"
                          checked={draft.conditionValues.includes(option)}
                          disabled={props.unavailable}
                          onChange={() => toggleConditionValue(option)}
                        />
                        <span>{option}</span>
                      </label>
                    ))}
                  </div>
                </>
              ) : (
                <ConditionValueChips
                  values={draft.conditionValues}
                  disabled={props.unavailable}
                  onChange={setConditionValues}
                />
              )}
            </div>
          )}
          <div className="stm-setting-row">
            <div className="stm-setting-label">
              <div className="stm-setting-name">
                显示字段
                <span className="stm-macro-count">
                  已选 {draft.projection.length} / {props.fields.length}
                </span>
              </div>
              <div className="stm-setting-hint">不选 = 沿用显示文本；引用字段显示目标记录文本</div>
            </div>
            <div className="stm-macro-field-toolbar">
              <button
                type="button"
                className="stm-text-button"
                data-action="select-all-projection"
                disabled={props.unavailable || props.fields.length === 0}
                onClick={() => selectAllProjection(true)}
              >
                全选
              </button>
              <button
                type="button"
                className="stm-text-button"
                data-action="clear-projection"
                disabled={props.unavailable || draft.projection.length === 0}
                onClick={() => selectAllProjection(false)}
              >
                清空
              </button>
            </div>
            <div className="stm-checkbox-group" data-stm-field="memory-view-projection">
              {props.fields.map((field) => (
                <label key={field.key} className="stm-checkbox-label">
                  <input
                    type="checkbox"
                    data-action="toggle-projection-field"
                    checked={draft.projection.includes(field.key)}
                    disabled={props.unavailable}
                    onChange={() => toggleProjection(field.key)}
                  />
                  <span>
                    {field.name}（{field.key}）
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div className="stm-setting-row">
            <div className="stm-setting-label">
              <div className="stm-setting-name">条数上限</div>
              <div className="stm-setting-hint">留空 = 最多 100 条（按更新时间倒序，最新在前）</div>
            </div>
            <input
              type="number"
              className="stm-input"
              min="1"
              max="100"
              data-stm-field="memory-view-limit"
              value={draft.limitText}
              placeholder="100"
              disabled={props.unavailable}
              onChange={(event) => props.onDraftChange({ ...draft, limitText: event.target.value })}
            />
          </div>
        </>
      )}
      {!props.chrome && (
        <div className="stm-setting-actions">
          <button
            type="submit"
            className="stm-button"
            data-action="save-memory-view"
            disabled={props.unavailable}
          >
            保存
          </button>
          <button
            type="button"
            className="stm-button"
            data-action="cancel-memory-view"
            onClick={cancel}
          >
            取消
          </button>
        </div>
      )}
    </form>
  );
}

/** short_text 筛选值：可增删 chip，回车/逗号提交（匹配任一值）。 */
function ConditionValueChips(props: {
  readonly values: readonly string[];
  readonly disabled?: boolean;
  readonly onChange: (values: readonly string[]) => void;
}) {
  const [text, setText] = useState("");

  function commit(): void {
    if (props.disabled) return;
    const parts = splitListText(text);
    if (parts.length === 0) return;
    const next = [...props.values];
    for (const part of parts) {
      if (!next.includes(part)) next.push(part);
    }
    props.onChange(next);
    setText("");
  }

  function remove(value: string): void {
    props.onChange(props.values.filter((candidate) => candidate !== value));
  }

  return (
    <div className="stm-chip-editor" data-stm-field="memory-view-condition-values">
      {props.values.map((value) => (
        <span className="stm-macro-chip" key={value}>
          <span>{value}</span>
          <button
            type="button"
            className="stm-macro-chip-remove"
            data-action="remove-condition-value"
            aria-label={`移除筛选值 ${value}`}
            disabled={props.disabled}
            onClick={() => remove(value)}
          >
            <i className="fa-solid fa-xmark" aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        type="text"
        className="stm-macro-chip-input"
        data-stm-field="memory-view-condition-value-input"
        value={text}
        placeholder={props.values.length === 0 ? "输入后按回车或逗号添加" : "继续添加…"}
        disabled={props.disabled}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" ||
            event.key === "," ||
            event.key === "，" ||
            event.key === "、"
          ) {
            event.preventDefault();
            commit();
          }
        }}
      />
    </div>
  );
}
