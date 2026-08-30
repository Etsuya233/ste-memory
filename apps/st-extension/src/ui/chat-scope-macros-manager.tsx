/**
 * 聊天 Scope 宏管理器（双 Scope 宏系统）：设置 Tab「对话级宏」组下的宏列表 CRUD。
 *
 * 复用 MemoryViewsManager 组件，但数据源是 chatMetadata 而非 extension_settings。
 * - 宏列表/草稿变更走 onChange(nextMacros)（宿主写 chatMetadata + macro.kick()）
 * - 名称校验：不允许与内置宏或全局宏同名
 * - 无活动空间时列表可看，编辑禁用（宏按活动空间求值）
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { MemoryField, MemoryTable } from "@ste-memory/core/memory";
import type { MemoryView } from "../settings/memory-views.ts";
import { validateChatScopeMacroName } from "../macros/chat-scope-macros.ts";
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

export function ChatScopeMacrosManager(props: {
  /** 活动空间 id；undefined = 无活动空间（列表可看，编辑禁用） */
  readonly spaceId: string | undefined;
  readonly readTables: (spaceId: string) => Promise<readonly MemoryTable[]>;
  readonly readFields: (spaceId: string, tableId: string) => Promise<readonly MemoryField[]>;
  /** 全局宏名列表（用于名称冲突校验） */
  readonly globalMacroNames: readonly string[];
  /** 当前对话的聊天 Scope 宏列表 */
  readonly macros: readonly MemoryView[];
  /** 宏列表变更（宿主写 chatMetadata + macro.kick()） */
  readonly onChange: (macros: readonly MemoryView[]) => void;
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
  }, [props.spaceId, props.readTables, props.macros]);

  /** 需要字段的表 Key：全部宏引用表 + 编辑器当前所选表 */
  const neededTableKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const macro of props.macros) keys.add(macro.tableKey);
    if (draft && draft.tableKey !== "") keys.add(draft.tableKey);
    return keys;
  }, [props.macros, draft]);

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
  }, [props.spaceId, tables, neededTableKeys, props.readFields]);

  // 编辑器打开时初始化草稿
  useEffect(() => {
    if (!editing) {
      setDraft(null);
      setError(undefined);
      return;
    }
    if (editing.kind === "new") {
      setDraft(emptyMemoryViewDraft());
    } else {
      const existing = props.macros.find((v) => v.name === editing.name);
      if (existing) setDraft(memoryViewDraftFromView(existing));
    }
  }, [editing, props.macros]);

  /** 校验草稿（名称合法性 + 名称冲突 + 视图结构） */
  function validateDraft(d: MemoryViewDraft): string | undefined {
    // 名称冲突校验
    const nameError = validateChatScopeMacroName(d.name, props.globalMacroNames);
    if (nameError !== undefined) return nameError;
    // 视图结构校验（已有宏名也视为冲突）
    const existingNames = props.macros.map((v) => v.name);
    return validateMemoryViewDraft(d, existingNames);
  }

  /** 保存草稿（新建/编辑） */
  function saveDraft(): void {
    if (!draft) return;
    const validationError = validateDraft(draft);
    if (validationError !== undefined) {
      setError(validationError);
      return;
    }
    const macro = memoryViewFromDraft(draft);
    const next =
      editing?.kind === "edit"
        ? props.macros.map((v) => (v.name === editing.name ? macro : v))
        : [...props.macros, macro];
    props.onChange(next);
    setEditing(null);
    reportSuccess(editing?.kind === "edit" ? "宏已更新" : "宏已创建");
  }

  /** 删除宏 */
  function deleteMacro(name: string): void {
    if (!window.confirm(`确定删除宏「${name}」？`)) return;
    props.onChange(props.macros.filter((v) => v.name !== name));
    reportSuccess("宏已删除");
  }

  /** 宏列表为空时的提示 */
  const isEmpty = props.macros.length === 0 && !editing;

  return (
    <div className="stm-chat-scope-macros-manager">
      {/* 宏列表 */}
      {props.macros.length > 0 && (
        <div className="stm-macro-list">
          {props.macros.map((macro) => {
            const configErrors = tables ? viewConfigErrors(macro, tables, fieldsByTable) : [];
            const hasErrors = configErrors.length > 0;
            return (
              <div key={macro.name} className="stm-macro-row">
                <div className="stm-macro-row-main">
                  <div className="stm-macro-name">{macro.name}</div>
                  <div className="stm-macro-summary">{viewSummaryText(macro)}</div>
                  {hasErrors && (
                    <span className="stm-macro-error-badge" title={configErrors.join("\n")}>
                      ⚠
                    </span>
                  )}
                </div>
                <div className="stm-macro-row-actions">
                  <button
                    type="button"
                    className="stm-button stm-button--small"
                    onClick={() => setEditing({ kind: "edit", name: macro.name })}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="stm-button stm-button--small stm-button--danger"
                    onClick={() => deleteMacro(macro.name)}
                  >
                    删除
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 空状态 */}
      {isEmpty && (
        <div className="stm-macro-empty">
          当前对话未配置聊天 Scope 宏。创建宏可在该对话中使用不同的记忆注入策略。
        </div>
      )}

      {/* 新建按钮 */}
      {!editing && (
        <button
          type="button"
          className="stm-button stm-button--primary"
          onClick={() => setEditing({ kind: "new" })}
          disabled={props.spaceId === undefined}
        >
          新建宏
        </button>
      )}

      {/* 编辑器 */}
      {editing && draft && (
        <div className="stm-macro-editor">
          <div className="stm-macro-editor-header">
            <h4>{editing.kind === "new" ? "新建宏" : "编辑宏"}</h4>
            <button
              type="button"
              className="stm-button stm-button--small"
              onClick={() => setEditing(null)}
            >
              取消
            </button>
          </div>

          {/* 名称 */}
          <label className="stm-macro-field">
            <span className="stm-macro-field-label">宏名</span>
            <input
              className="stm-input"
              type="text"
              value={draft.name}
              placeholder="我的宏"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>

          {/* 表选择 */}
          <label className="stm-macro-field">
            <span className="stm-macro-field-label">表</span>
            <select
              className="stm-select"
              value={draft.tableKey}
              onChange={(event) => setDraft({ ...draft, tableKey: event.target.value })}
            >
              <option value="">选择表</option>
              {tables?.map((table) => (
                <option key={table.key} value={table.key}>
                  {table.name}
                </option>
              ))}
            </select>
          </label>

          {/* 条数上限 */}
          <label className="stm-macro-field">
            <span className="stm-macro-field-label">条数上限</span>
            <input
              className="stm-input"
              type="number"
              min="1"
              max="100"
              value={draft.limitText}
              placeholder="无限制"
              onChange={(event) => {
                setDraft({ ...draft, limitText: event.target.value });
              }}
            />
          </label>

          {/* 错误提示 */}
          {error && <div className="stm-macro-error">{error}</div>}

          {/* 保存按钮 */}
          <div className="stm-macro-editor-actions">
            <button
              type="button"
              className="stm-button stm-button--primary"
              onClick={saveDraft}
            >
              保存
            </button>
            <button
              type="button"
              className="stm-button"
              onClick={() => setEditing(null)}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
