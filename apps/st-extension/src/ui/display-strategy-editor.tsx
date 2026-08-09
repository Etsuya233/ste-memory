/**
 * 显示策略编辑器组件（ticket 10）。
 *
 * 纯逻辑（草稿校验、摘要、依赖字段、预览行摘要）在 display-strategy-model（有测试
 * 兜底），组件只做「草稿 → 表单投影」、模板引用插入与预览计算接线；保存动作由父层
 * 异步执行（core setDisplayStrategy 的 DomainError 经 toastr 展示）。预览计算走 core
 * previewDisplayText（computeMemoryRecordDisplayText 同一份规则），不在 UI 重复实现。
 * SSR 冒烟测试直接渲染本组件（无 jsdom，useEffect 不执行）。
 */
import { useEffect, useRef, useState } from "react";
import type {
  MemoryField,
  MemoryFieldId,
  MemoryRecord,
  MemoryRecordPayload,
  MemoryTableDisplayStrategy,
} from "@ste-memory/core/memory";
import {
  displayFieldCandidates,
  displayStrategyFromDraft,
  payloadSummary,
  templateFieldRef,
  validateDisplayStrategyDraft,
  type DisplayStrategyDraft,
} from "./display-strategy-model.ts";

export interface DisplayStrategyEditorProps {
  readonly title: string;
  /** 当前表已保存策略（null = 未配置）构造的初始草稿 */
  readonly initial: DisplayStrategyDraft;
  /** 当前表全部字段（策略校验 / 字段下拉 / 引用 chip / 摘要） */
  readonly fields: readonly MemoryField[];
  /** 预览用现有记录（最多 5 条，payload 用于按草稿策略计算显示文本） */
  readonly previewRecords: readonly MemoryRecord[];
  /** 预览记录加载失败时的提示（无法加载时替代空状态文案） */
  readonly previewError: string | null;
  /** 用给定策略计算一条 payload 的显示文本（core previewDisplayText 绑定当前空间/表） */
  readonly computePreview: (
    strategy: MemoryTableDisplayStrategy,
    payload: MemoryRecordPayload,
  ) => Promise<string>;
  /** 保存进行中（禁用提交按钮，防重复提交） */
  readonly saving: boolean;
  readonly onSave: (strategy: MemoryTableDisplayStrategy) => void;
  readonly onCancel: () => void;
}

export function DisplayStrategyEditor(props: DisplayStrategyEditorProps) {
  const [draft, setDraft] = useState<DisplayStrategyDraft>(props.initial);
  // 预览文本（与 previewRecords 对齐；null = 草稿无效或无可预览记录）
  const [previews, setPreviews] = useState<readonly string[] | null>(null);
  const templateRef = useRef<HTMLTextAreaElement>(null);

  const validation = validateDisplayStrategyDraft(draft, props.fields);
  const fieldCandidates = displayFieldCandidates(props.fields);
  const templateFields = props.fields.filter((field) => field.enabled);

  // 草稿变化 → 按草稿策略重算每条记录的显示文本（core 规则，只读）
  useEffect(() => {
    let cancelled = false;
    if (validation || props.previewRecords.length === 0 || props.previewError) {
      setPreviews(null);
      return;
    }
    const strategy = displayStrategyFromDraft(draft);
    void (async () => {
      const results = await Promise.all(
        props.previewRecords.map((record) =>
          props.computePreview(strategy, record.payload).catch(() => "（预览失败）"),
        ),
      );
      if (!cancelled) setPreviews(results);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    draft,
    props.fields,
    props.previewRecords,
    props.previewError,
    props.computePreview,
    validation,
  ]);

  /** 把 {fieldId} 插入模板光标处（无焦点时追加到末尾） */
  function insertFieldRef(fieldId: MemoryFieldId): void {
    const ref = templateFieldRef(fieldId);
    const textarea = templateRef.current;
    const start = textarea ? textarea.selectionStart : draft.template.length;
    const end = textarea ? textarea.selectionEnd : start;
    const next = draft.template.slice(0, start) + ref + draft.template.slice(end);
    setDraft((prev) => ({ ...prev, template: next }));
    // 恢复焦点并把光标移到插入内容之后
    requestAnimationFrame(() => {
      if (!textarea) return;
      textarea.focus();
      const position = start + ref.length;
      textarea.setSelectionRange(position, position);
    });
  }

  return (
    <form
      className="stm-editor"
      data-stm-editor="display-strategy"
      onSubmit={(event) => {
        event.preventDefault();
        if (validation || props.saving) return;
        props.onSave(displayStrategyFromDraft(draft));
      }}
    >
      <div className="stm-editor-title">{props.title}</div>
      <label className="stm-form-row">
        <span className="stm-form-label">显示策略类型</span>
        <select
          className="stm-select"
          data-stm-field="display-strategy-type"
          value={draft.type}
          onChange={(event) =>
            setDraft((prev) => ({ ...prev, type: event.target.value as "field" | "template" }))
          }
        >
          <option value="field">短文本字段</option>
          <option value="template">派生模板</option>
        </select>
      </label>
      {draft.type === "field" ? (
        <label className="stm-form-row">
          <span className="stm-form-label">
            显示字段（短文本） <em className="stm-form-required-mark">*</em>
          </span>
          <select
            className="stm-select"
            data-stm-field="display-strategy-field"
            value={draft.fieldId}
            disabled={fieldCandidates.length === 0}
            onChange={(event) => setDraft((prev) => ({ ...prev, fieldId: event.target.value }))}
          >
            <option value="">
              {fieldCandidates.length === 0 ? "当前表没有已启用的短文本字段" : "选择显示字段…"}
            </option>
            {fieldCandidates.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}（{field.key}）
              </option>
            ))}
          </select>
          {fieldCandidates.length === 0 ? (
            <span className="stm-form-hint">先创建并启用一个短文本字段，再配置显示策略</span>
          ) : null}
        </label>
      ) : (
        <>
          <label className="stm-form-row">
            <span className="stm-form-label">
              显示模板 <em className="stm-form-required-mark">*</em>
            </span>
            <textarea
              ref={templateRef}
              className="stm-textarea"
              data-stm-field="display-strategy-template"
              rows={2}
              value={draft.template}
              placeholder={"用 {字段引用} 组合显示文本，如：{field-name} 住在 {field-location}"}
              onChange={(event) => setDraft((prev) => ({ ...prev, template: event.target.value }))}
            />
          </label>
          {templateFields.length > 0 ? (
            <div className="stm-strategy-chips">
              <span className="stm-strategy-chips-label">插入字段引用：</span>
              {templateFields.map((field) => (
                <button
                  key={field.id}
                  type="button"
                  className="stm-strategy-chip"
                  data-action="insert-field-ref"
                  data-field-id={field.id}
                  onClick={() => insertFieldRef(field.id)}
                >
                  {field.name}
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
      {validation ? (
        <div className="stm-form-error" data-stm-field="display-strategy-error">
          {validation.message}
        </div>
      ) : null}
      <div className="stm-strategy-preview">
        <div className="stm-strategy-preview-title">显示效果预览</div>
        {props.previewError ? (
          <div className="stm-form-hint" data-stm-field="display-strategy-preview-error">
            {props.previewError}
          </div>
        ) : props.previewRecords.length === 0 ? (
          <div className="stm-form-hint" data-stm-field="display-strategy-preview-empty">
            该表还没有记录；保存策略后新记录将按此策略显示
          </div>
        ) : previews === null ? (
          <div className="stm-form-hint" data-stm-field="display-strategy-preview-invalid">
            当前策略无效，无法预览
          </div>
        ) : (
          <ul className="stm-strategy-preview-list">
            {props.previewRecords.map((record, index) => (
              <li key={record.id} className="stm-strategy-preview-row">
                <div className="stm-strategy-preview-text">{previews[index] ?? "（预览失败）"}</div>
                <div className="stm-strategy-preview-meta">
                  {payloadSummary(record.payload, props.fields)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="stm-editor-actions">
        <button
          type="button"
          className="stm-button"
          data-action="editor-cancel"
          onClick={props.onCancel}
        >
          取消
        </button>
        <button
          type="submit"
          className="stm-button stm-button--primary"
          data-action="editor-submit"
          disabled={validation !== null || props.saving}
        >
          保存
        </button>
      </div>
    </form>
  );
}
