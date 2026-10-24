/**
 * 记忆宏作用域列表（全局宏 / 对话宏共用）：对象行 + 空状态。
 * 行内展示宏表达式、表名、筛选/条数/投影摘要与输出体积；右侧预览/复制按钮。
 * 配置错误与同名覆盖提示保留在对应对象附近。
 */
import { useState } from "react";
import type { MemoryField, MemoryTable } from "../../features/memory/index.ts";
import type { MemoryView } from "../../features/macros/memory-views.ts";
import { copyText, reportSuccess, reportWarning } from "../shell/ui-helpers.tsx";
import { PreviewModal } from "../memory/preview-modal.tsx";
import { macroRowMeta, macroToken, type MacroConflictBadge } from "./macro-ui-model.ts";
import { viewSelectionSummary } from "./memory-views-manager-model.ts";

export function MacroScopeList(props: {
  readonly macros: readonly MemoryView[];
  /** 合法注册名（裸标识符）；"" = 宏名无效/未配置，行内不展示可复制表达式 */
  readonly prefix: string;
  readonly tables: readonly MemoryTable[] | undefined;
  readonly fieldsByTable: ReadonlyMap<string, readonly MemoryField[]>;
  readonly hasActiveSpace: boolean;
  readonly readPreview: (name: string) => string;
  readonly errorsFor: (macro: MemoryView) => readonly string[];
  /** 同名覆盖提示（全局宏看对话宏，对话宏看全局/内置宏） */
  readonly badgesFor: (macro: MemoryView) => readonly MacroConflictBadge[];
  readonly onEdit: (macro: MemoryView) => void;
  /** 行容器 data-stm-field 前缀，如 memory-view- / chat-macro- */
  readonly dataFieldPrefix: string;
  /** 行主按钮动作，如 edit-memory-view / edit-chat-scope-macro */
  readonly editAction: string;
  /** 复制按钮动作 */
  readonly copyAction: string;
  /** 配置错误行 data-stm-field */
  readonly errorField: string;
  readonly emptyTitle: string;
  readonly emptyHint: string;
  readonly emptyActionLabel: string;
  readonly emptyAction: string;
  readonly onEmptyAction: () => void;
  readonly createDisabled: boolean;
}) {
  const [preview, setPreview] = useState<{ readonly name: string; readonly text: string } | null>(
    null,
  );

  function openPreview(token: string): void {
    setPreview({ name: token, text: props.readPreview(token) });
  }

  async function copyPreview(): Promise<void> {
    if (!preview) return;
    try {
      const ok = await copyText(preview.text);
      if (ok) reportSuccess(`已复制「${preview.name}」展开文本`);
      else reportWarning("复制失败：浏览器不支持剪贴板写入");
    } catch {
      reportWarning("复制失败：无法写入剪贴板");
    }
  }

  if (props.macros.length === 0) {
    return (
      <div className="stm-macro-empty" data-stm-section="macro-empty">
        <div className="stm-macro-empty-icon" aria-hidden="true">
          <i className="fa-solid fa-wand-magic-sparkles" />
        </div>
        <div className="stm-macro-empty-title">{props.emptyTitle}</div>
        <div className="stm-macro-empty-hint">{props.emptyHint}</div>
        <div className="stm-macro-empty-actions">
          <button
            type="button"
            className="stm-button stm-button--primary"
            data-action={props.emptyAction}
            disabled={props.createDisabled}
            onClick={props.onEmptyAction}
          >
            {props.emptyActionLabel}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="stm-grouped-list stm-macro-list">
        {props.macros.map((macro) => (
          <MacroRow
            key={macro.name}
            macro={macro}
            prefix={props.prefix}
            tables={props.tables}
            fieldsByTable={props.fieldsByTable}
            hasActiveSpace={props.hasActiveSpace}
            readPreview={props.readPreview}
            errors={props.errorsFor(macro)}
            badges={props.badgesFor(macro)}
            onEdit={() => props.onEdit(macro)}
            onPreview={openPreview}
            dataFieldPrefix={props.dataFieldPrefix}
            editAction={props.editAction}
            copyAction={props.copyAction}
            errorField={props.errorField}
          />
        ))}
      </div>
      {preview && (
        <PreviewModal
          title={preview.name}
          text={preview.text}
          onCopy={() => void copyPreview()}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}

function MacroRow(props: {
  readonly macro: MemoryView;
  readonly prefix: string;
  readonly tables: readonly MemoryTable[] | undefined;
  readonly fieldsByTable: ReadonlyMap<string, readonly MemoryField[]>;
  readonly hasActiveSpace: boolean;
  readonly readPreview: (name: string) => string;
  readonly errors: readonly string[];
  readonly badges: readonly MacroConflictBadge[];
  readonly onEdit: () => void;
  readonly onPreview: (token: string) => void;
  readonly dataFieldPrefix: string;
  readonly editAction: string;
  readonly copyAction: string;
  readonly errorField: string;
}) {
  const table = props.tables?.find((candidate) => candidate.key === props.macro.tableKey);
  const tableName = table?.name ?? props.macro.tableKey;
  const condition = props.macro.condition;
  const conditionFieldName =
    condition === null
      ? undefined
      : props.fieldsByTable
          .get(props.macro.tableKey)
          ?.find((field) => field.key === condition.fieldKey)?.name;
  const token = macroToken(props.prefix, props.macro.name);
  const outputText = token !== "" && props.hasActiveSpace ? props.readPreview(token) : "";
  const meta = macroRowMeta({
    tableName,
    selectionSummary: viewSelectionSummary(props.macro, conditionFieldName),
    outputText,
    hasActiveSpace: props.hasActiveSpace,
  });

  function copy(): void {
    void copyText(token)
      .then((copied) => {
        if (copied) reportSuccess(`已复制 ${token}`);
        else reportWarning("复制失败：浏览器不支持剪贴板写入");
      })
      .catch(() => reportWarning("复制失败：无法写入剪贴板"));
  }

  return (
    <div data-stm-field={`${props.dataFieldPrefix}${props.macro.name}`}>
      <div className="stm-macro-row">
        <button
          type="button"
          className="stm-macro-row-main"
          data-action={props.editAction}
          disabled={!props.hasActiveSpace}
          title={props.hasActiveSpace ? undefined : "打开或切换一个对话后才能编辑"}
          onClick={props.onEdit}
        >
          <span className="stm-macro-row-content">
            <span className="stm-macro-row-title-line">
              <span className="stm-settings-item-title">{props.macro.name}</span>
              {props.badges.map((badge) => (
                <span
                  key={badge.text}
                  className="stm-macro-badge"
                  data-kind={badge.kind}
                  title={badge.title}
                >
                  {badge.text}
                </span>
              ))}
            </span>
            <span
              className={`stm-macro-row-token stm-mono${token === "" ? " stm-macro-row-token--empty" : ""}`}
            >
              {token === "" ? "先在宏设置中配置有效宏名" : token}
            </span>
            <span className="stm-macro-row-meta">{meta}</span>
          </span>
          <i className="fa-solid fa-chevron-right" aria-hidden="true" />
        </button>
        <div className="stm-macro-row-actions">
          <button
            type="button"
            className="stm-macro-row-action"
            data-action="preview-macro"
            aria-label={token === "" ? "预览宏（需先配置有效宏名）" : `预览宏 ${token}`}
            title="预览展开文本"
            disabled={token === ""}
            onClick={() => props.onPreview(token)}
          >
            <i className="fa-regular fa-eye" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="stm-macro-row-action"
            data-action={props.copyAction}
            aria-label={token === "" ? "复制宏名（需先配置有效宏名）" : `复制宏名 ${token}`}
            title="复制宏名"
            disabled={token === ""}
            onClick={copy}
          >
            <i className="fa-regular fa-copy" aria-hidden="true" />
          </button>
        </div>
      </div>
      {props.errors.length > 0 && (
        <div className="stm-preset-warning" data-stm-field={props.errorField}>
          配置错误：{props.errors.join("；")}
        </div>
      )}
    </div>
  );
}
