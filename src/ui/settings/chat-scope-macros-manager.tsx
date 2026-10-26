import { Button } from "../kit/controls.tsx";
/**
 * 对话宏管理器（原聊天 Scope 宏）：设置 Tab「记忆宏」组「对话宏」分区的列表 CRUD。
 *
 * 与 MemoryViewsManager 同构：同一套草稿模型/校验/编辑器（MemoryViewEditor），
 * 差异只在数据源（chatMetadata 而非 extension_settings）。名字不与任何作用域
 * 冲突——同名即覆盖（对话宏 > 全局宏 > 内置宏）。
 * - 宏列表变更走 onChange(nextMacros)（宿主写 chatMetadata + 面板版本号自增 +
 *   macro.kick() 立即重建快照）；
 * - 无活动空间时列表可看，编辑禁用（宏按活动空间求值）。
 */
import { useEffect, useMemo, useState } from "react";
import type { MemoryField, MemoryTable } from "../../features/memory/index.ts";
import { reportError, reportSuccess } from "../shell/ui-helpers.tsx";
import { useSettingsPageNavigation } from "./settings-page-navigation.ts";
import { MacroScopeList } from "./macro-scope-list.tsx";
import {
  builtinMacroNames,
  macroConflictBadges,
  macroToken,
  type MacroConflictBadge,
} from "./macro-ui-model.ts";
import {
  emptyMemoryViewDraft,
  macroEditingContextChanged,
  memoryViewDraftFromView,
  memoryViewFromDraft,
  validateMemoryViewDraft,
  viewConfigErrors,
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
  /** 合法宏名（裸标识符，如 ste；宏表达式展示与预览用） */
  readonly prefix: string;
  /** 活动空间 id；undefined = 无活动空间（列表可看，编辑禁用） */
  readonly spaceId: string | undefined;
  readonly chatIdentity?: string;
  readonly readTables: (spaceId: string) => Promise<readonly MemoryTable[]>;
  readonly readFields: (spaceId: string, tableId: string) => Promise<readonly MemoryField[]>;
  /** 宏展开文本读取口：完整宏名（{{...}} 形态）→ 预计算快照文本（未知 = 空串） */
  readonly readPreview: (name: string) => string;
  /** 当前全局宏名（同名覆盖提示） */
  readonly globalMacroNames?: readonly string[];
  /** 当前对话的对话宏列表 */
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
            label: "新建对话宏",
            dataAction: "add-chat-scope-macro",
            disabled: !hasActiveSpace,
            onClick: beginCreate,
          },
    );
    return () => props.onCreateActionChange?.(null);
  }, [editing, hasActiveSpace, props.chatIdentity, props.onCreateActionChange]);

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
  }, [props.spaceId, props.readFields, tables, neededTableKeys]);

  const builtinNames = useMemo(() => builtinMacroNames(tables), [tables]);
  const globalNames = useMemo(
    () => new Set(props.globalMacroNames ?? []),
    [props.globalMacroNames],
  );

  function badgesFor(macro: MemoryView): readonly MacroConflictBadge[] {
    return macroConflictBadges({
      scope: "chat",
      name: macro.name,
      globalNames,
      builtinNames,
    });
  }

  function beginEdit(macro: MemoryView): void {
    if (!hasActiveSpace) return;
    setEditingContext({ spaceId: props.spaceId, chatIdentity: props.chatIdentity });
    rememberScroll();
    setEditing({ kind: "edit", name: macro.name });
    setDraft(memoryViewDraftFromView(macro));
    setError(undefined);
  }

  function beginCreate(): void {
    if (!hasActiveSpace) return;
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
    return validateMemoryViewDraft(d, existingNames, "宏名已存在（当前对话内唯一）");
  }

  /** 保存草稿（新建/编辑） */
  function saveDraft(): void {
    if (!draft || contextChanged || !hasActiveSpace) return;
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
    if (!window.confirm(`删除宏「${name}」？所有使用该宏的位置将展开为空内容。`)) return;
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

  const editingDraftFields =
    draft && draft.tableKey !== "" ? (fieldsByTable.get(draft.tableKey) ?? []) : [];

  if (editing && draft)
    return (
      <div ref={screenRef} className="stm-settings-editor-page">
        <MemoryViewEditor
          chrome
          title={editing.kind === "new" ? "新建对话宏" : "编辑对话宏"}
          prefix={props.prefix}
          draft={draft}
          tables={tables ?? []}
          fields={editingDraftFields}
          error={
            contextChanged ? "对话已切换，当前草稿未写入新对话；返回列表后可重新编辑。" : error
          }
          unavailable={contextChanged || !hasActiveSpace}
          onDraftChange={setDraft}
          onSave={saveDraft}
          onCancel={cancelEdit}
          registerLeaveGuard={props.registerLeaveGuard}
          onDelete={editing.kind === "edit" ? () => deleteMacro(editing.name) : undefined}
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
      ? "先到宏设置配置有效宏名，再新建对话宏。"
      : `对话宏只随当前对话保存；在提示词预设或世界书条目中写 ${macroToken(props.prefix, "名字")} 即可注入。`
    : "对话宏只属于当前对话；打开或切换一个对话后即可创建和编辑。";
  const emptyTitle = hasActiveSpace ? "当前对话还没有对话宏" : "先打开一个对话";

  return (
    <div ref={screenRef} className="stm-setting-subgroup" data-stm-section="chat-scope-macros">
      {!hasActiveSpace && props.macros.length > 0 && (
        <div className="stm-macro-notice" data-stm-field="chat-scope-macros-no-space">
          当前没有活动记忆空间：列表可查看，打开或切换对话后才能编辑。
        </div>
      )}
      <MacroScopeList
        macros={props.macros}
        prefix={props.prefix}
        tables={tables}
        fieldsByTable={fieldsByTable}
        hasActiveSpace={hasActiveSpace}
        readPreview={props.readPreview}
        errorsFor={rowConfigErrors}
        badgesFor={badgesFor}
        onEdit={beginEdit}
        dataFieldPrefix="chat-macro-"
        editAction="edit-chat-scope-macro"
        copyAction="copy-chat-macro-token"
        errorField="chat-macro-config-error"
        emptyTitle={emptyTitle}
        emptyHint={emptyHint}
        emptyActionLabel="新建对话宏"
        emptyAction="add-chat-scope-macro"
        onEmptyAction={beginCreate}
        createDisabled={!hasActiveSpace}
      />
      {props.macros.length > 0 && (
        <div className="stm-setting-hint" data-stm-field="chat-scope-macros-usage-hint">
          {props.prefix === "" ? (
            "先在宏设置中配置有效宏名，宏才会注册。"
          ) : (
            <>对话宏只随当前对话保存，同名时优先于全局宏与内置宏。</>
          )}
        </div>
      )}
      {props.macros.length > 0 && !props.onCreateActionChange && (
        <div className="stm-setting-actions">
          <Button
            type="button"

            data-action="add-chat-scope-macro"
            disabled={!hasActiveSpace}
            onClick={beginCreate}
          >
            + 新建对话宏
          </Button>
        </div>
      )}
    </div>
  );
}
