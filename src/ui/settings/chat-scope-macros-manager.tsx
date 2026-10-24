import { macroEditingContextChanged } from "./memory-views-manager-model.ts";
/**
 * 聊天 Scope 宏管理器（双 Scope 宏系统）：设置 Tab「记忆宏」组「对话级宏」分区的列表 CRUD。
 *
 * 与 MemoryViewsManager 同构：同一套草稿模型/校验/编辑器（MemoryViewEditor），
 * 差异只在数据源（chatMetadata 而非 extension_settings）。名字不与任何作用域
 * 冲突——同名即覆盖（对话级 > 全局 > 内置）。
 * - 宏列表变更走 onChange(nextMacros)（宿主写 chatMetadata + 面板版本号自增 +
 *   macro.kick() 立即重建快照）；
 * - 无活动空间时列表可看，编辑禁用（宏按活动空间求值）。
 */
import { useEffect, useMemo, useState } from "react";
import type { MemoryField, MemoryTable } from "../../features/memory/index.ts";
import { reportError, reportSuccess } from "../shell/ui-helpers.tsx";
import { useSettingsPageNavigation } from "./settings-page-navigation.ts";
import { Disclosure } from "../shell/disclosure.tsx";
import {
  emptyMemoryViewDraft,
  memoryViewDraftFromView,
  memoryViewFromDraft,
  validateMemoryViewDraft,
  viewConfigErrors,
  viewSummaryText,
  type MemoryViewDraft,
} from "./memory-views-manager-model.ts";
import { MemoryViewEditor } from "./memory-views-manager.tsx";
import type { MemoryView } from "../../features/macros/memory-views.ts";

export function ChatScopeMacrosManager(props: {
  readonly onCreateActionChange?: (
    action: { label: string; dataAction: string; disabled: boolean; onClick: () => void } | null,
  ) => void;
  readonly onEditingChange?: (editing: boolean) => void;
  readonly registerLeaveGuard?: (guard: (() => boolean) | null) => void;
  /** 全局前缀（裸标识符，如 ste；提示文案用） */
  readonly prefix: string;
  /** 活动空间 id；undefined = 无活动空间（列表可看，编辑禁用） */
  readonly spaceId: string | undefined;
  readonly chatIdentity?: string;
  readonly readTables: (spaceId: string) => Promise<readonly MemoryTable[]>;
  readonly readFields: (spaceId: string, tableId: string) => Promise<readonly MemoryField[]>;
  /** 宏展开文本读取口：完整宏名（{{...}} 形态）→ 预计算快照文本（未知 = 空串） */
  readonly readPreview: (name: string) => string;
  /** 当前对话的聊天 Scope 宏列表 */
  readonly macros: readonly MemoryView[];
  /** 宏列表变更（宿主写 chatMetadata + 面板版本号自增 + macro.kick()） */
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
  const [editingContext, setEditingContext] = useState<{
    spaceId: string | undefined;
    chatIdentity: string | undefined;
  } | null>(null);
  const contextChanged =
    editingContext !== null &&
    macroEditingContextChanged(editingContext, {
      spaceId: props.spaceId,
      chatIdentity: props.chatIdentity,
    });
  const [draft, setDraft] = useState<MemoryViewDraft | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const { screenRef, rememberScroll } = useSettingsPageNavigation(
    editing ? (editing.kind === "new" ? "new:macro" : `edit:macro:${editing.name}`) : "list",
  );
  useEffect(() => {
    props.onEditingChange?.(editing !== null);
    return () => props.onEditingChange?.(false);
  }, [editing, props.onEditingChange]);
  /** 打开的预览：弹窗持有点击时捕获的展开文本（「展开时读一次」） */

  useEffect(() => {
    props.onCreateActionChange?.(
      editing
        ? null
        : {
            label: "新建对话宏",
            dataAction: "add-chat-scope-macro",
            disabled: !props.spaceId,
            onClick: beginCreate,
          },
    );
    return () => props.onCreateActionChange?.(null);
  }, [editing, props.spaceId, props.chatIdentity, props.onCreateActionChange]);

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
  }, [props.spaceId, props.readTables, props.readFields, tables, neededTableKeys]);

  function beginEdit(macro: MemoryView): void {
    setEditingContext({ spaceId: props.spaceId, chatIdentity: props.chatIdentity });
    rememberScroll();
    setEditing({ kind: "edit", name: macro.name });
    setDraft(memoryViewDraftFromView(macro));
    setError(undefined);
  }

  function beginCreate(): void {
    setEditingContext({ spaceId: props.spaceId, chatIdentity: props.chatIdentity });
    rememberScroll();
    setEditing({ kind: "new" });
    setDraft(emptyMemoryViewDraft());
    setError(undefined);
  }

  function cancelEdit(): void {
    rememberScroll();
    setEditing(null);
    setEditingContext(null);
    setDraft(null);
    setError(undefined);
  }

  /** 校验草稿（视图结构校验，排除自身旧名）；名字不与任何作用域冲突——同名即覆盖 */
  function validateDraft(d: MemoryViewDraft): string | undefined {
    const existingNames = props.macros
      .filter((candidate) => editing?.kind !== "edit" || candidate.name !== editing.name)
      .map((candidate) => candidate.name);
    return validateMemoryViewDraft(d, existingNames);
  }

  /** 保存草稿（新建/编辑） */
  function saveDraft(): void {
    if (!draft || contextChanged) return;
    const validationError = validateDraft(draft);
    if (validationError !== undefined) {
      setError(validationError);
      return;
    }
    const macro = memoryViewFromDraft(draft);
    const next =
      editing?.kind === "edit"
        ? props.macros.map((candidate) => (candidate.name === editing.name ? macro : candidate))
        : [...props.macros, macro];
    props.onChange(next);
    cancelEdit();
    reportSuccess(editing?.kind === "edit" ? "宏已更新" : "宏已创建");
  }

  /** 删除宏 */
  function deleteMacro(name: string): void {
    if (contextChanged) return;
    if (!window.confirm(`删除宏「${name}」？`)) return;
    props.onChange(props.macros.filter((candidate) => candidate.name !== name));
    if (editing?.kind === "edit" && editing.name === name) cancelEdit();
    reportSuccess("宏已删除");
  }

  /** 折叠行配置错误：表缺失 = 确定错误（立即显示）；表在但字段未加载完 = 暂不显示（避免误报） */
  function rowConfigErrors(macro: MemoryView): readonly string[] {
    if (!props.spaceId || tables === undefined) return [];
    const tableExists = tables.some((candidate) => candidate.key === macro.tableKey);
    if (tableExists && !fieldsByTable.has(macro.tableKey)) return [];
    return viewConfigErrors(macro, tables, fieldsByTable);
  }

  /** 打开宏预览：宏名 = {{前缀::宏名}}，文本点击时从快照读取一次 */

  const editingDraftFields =
    draft && draft.tableKey !== "" ? (fieldsByTable.get(draft.tableKey) ?? []) : [];

  if (editing && draft)
    return (
      <div ref={screenRef} className="stm-settings-editor-page">
        <MemoryViewEditor
          chrome
          title={editing.kind === "new" ? "新建对话宏" : "编辑对话宏"}
          draft={draft}
          tables={tables ?? []}
          fields={editingDraftFields}
          error={
            contextChanged ? "对话已切换，当前草稿未写入新对话；返回列表后可重新编辑。" : error
          }
          unavailable={contextChanged}
          onDraftChange={setDraft}
          onSave={saveDraft}
          onCancel={cancelEdit}
          registerLeaveGuard={props.registerLeaveGuard}
          onDelete={editing.kind === "edit" ? () => deleteMacro(editing.name) : undefined}
          previewText={
            editing.kind === "edit"
              ? props.readPreview(`{{${props.prefix}::${editing.name}}}`)
              : undefined
          }
        />
      </div>
    );

  return (
    <div ref={screenRef} className="stm-setting-subgroup" data-stm-section="chat-scope-macros">
      {!props.spaceId && (
        <div className="stm-preset-warning" data-stm-field="chat-scope-macros-no-space">
          当前没有活动记忆空间：打开/切换对话后可配置聊天 Scope 宏
        </div>
      )}
      <div className="stm-grouped-list stm-macro-list">
        {props.macros.map((macro) => (
          <div key={macro.name} data-stm-field={`chat-macro-${macro.name}`}>
            <button
              type="button"
              className="stm-settings-item-row"
              data-action="edit-chat-scope-macro"
              onClick={() => beginEdit(macro)}
            >
              <span className="stm-settings-item-main">
                <span className="stm-settings-item-title">{macro.name}</span>
                <span className="stm-settings-item-summary">
                  {macro.tableKey} · {viewSummaryText(macro)}
                </span>
              </span>
              <i className="fa-solid fa-chevron-right" aria-hidden="true" />
            </button>
            {rowConfigErrors(macro).length > 0 && (
              <div className="stm-preset-warning" data-stm-field="chat-macro-config-error">
                配置错误：{rowConfigErrors(macro).join("；")}
              </div>
            )}
          </div>
        ))}
      </div>
      {!props.onCreateActionChange && (
        <div className="stm-setting-actions">
          <button
            type="button"
            className="stm-button"
            data-action="add-chat-scope-macro"
            disabled={!props.spaceId}
            onClick={beginCreate}
          >
            + 新建宏
          </button>
        </div>
      )}

      <Disclosure icon="fa-circle-info" title="对话级宏用法" open>
        <div className="stm-setting-hint">
          <span className="stm-mono">{"{{前缀::宏名}}"}</span> 直接展开对应表/筛选/投影；
          仅当前对话可用，随对话文件导入导出；同名宏优先于全局视图与内置宏 （对话级 &gt; 全局 &gt;
          内置）
        </div>
      </Disclosure>
    </div>
  );
}
