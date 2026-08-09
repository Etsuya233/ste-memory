/**
 * 表格 / 字段定义编辑器组件（ticket 09）。
 *
 * 纯逻辑（草稿校验、选项解析、类型→配置形态映射）在 table-editor-model /
 * field-editor-model（有测试兜底），组件只做「草稿 → 表单投影」与本地即时校验；
 * 保存动作由父层异步执行，core 的 DomainError（key 冲突、跨空间引用等）
 * 经 toastr 展示。SSR 冒烟测试直接渲染本组件（无 jsdom）。
 */
import { useState } from "react";
import type { MemoryTable, MemoryFieldType } from "@ste-memory/core/memory";
import { FIELD_TYPE_LABELS } from "./table-list-model.ts";
import {
  validateTableDraft,
  type TableDraft,
  type TableDraftErrors,
} from "./table-editor-model.ts";
import {
  fieldTypeNeedsOptions,
  fieldTypeNeedsReference,
  validateFieldDraft,
  type FieldDraft,
  type FieldDraftErrors,
} from "./field-editor-model.ts";

/** 全部 12 种字段类型（表单下拉选项；顺序与 FIELD_TYPE_LABELS 一致） */
const FIELD_TYPES = Object.keys(FIELD_TYPE_LABELS) as readonly MemoryFieldType[];

// ---- 表格编辑表单 ----

export interface TableEditorFormProps {
  readonly title: string;
  readonly initial: TableDraft;
  readonly submitLabel: string;
  readonly onSave: (draft: TableDraft) => void;
  readonly onCancel: () => void;
}

export function TableEditorForm(props: TableEditorFormProps) {
  const [draft, setDraft] = useState<TableDraft>(props.initial);
  const [errors, setErrors] = useState<TableDraftErrors>({});

  function set<K extends keyof TableDraft>(key: K, value: TableDraft[K]): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function submit(): void {
    const nextErrors = validateTableDraft(draft);
    setErrors(nextErrors);
    if (nextErrors.key || nextErrors.name) return;
    props.onSave(draft);
  }

  return (
    <form
      className="stm-editor"
      data-stm-editor="table"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="stm-editor-title">{props.title}</div>
      <label className="stm-form-row">
        <span className="stm-form-label">
          Key <em className="stm-form-required-mark">*</em>
        </span>
        <input
          className="stm-input"
          type="text"
          data-stm-field="table-key"
          value={draft.key}
          placeholder="唯一英文标识，如 characters"
          onChange={(event) => set("key", event.target.value)}
        />
        {errors.key ? <span className="stm-form-error">{errors.key}</span> : null}
      </label>
      <label className="stm-form-row">
        <span className="stm-form-label">
          名称 <em className="stm-form-required-mark">*</em>
        </span>
        <input
          className="stm-input"
          type="text"
          data-stm-field="table-name"
          value={draft.name}
          placeholder="如：角色档案"
          onChange={(event) => set("name", event.target.value)}
        />
        {errors.name ? <span className="stm-form-error">{errors.name}</span> : null}
      </label>
      <label className="stm-form-row">
        <span className="stm-form-label">描述</span>
        <input
          className="stm-input"
          type="text"
          data-stm-field="table-description"
          value={draft.description}
          placeholder="这张表记录什么"
          onChange={(event) => set("description", event.target.value)}
        />
      </label>
      <label className="stm-form-row">
        <span className="stm-form-label">表格 Prompt</span>
        <textarea
          className="stm-textarea"
          data-stm-field="table-prompt"
          value={draft.prompt}
          rows={3}
          placeholder="给 Agent 的填表指引（可选）"
          onChange={(event) => set("prompt", event.target.value)}
        />
      </label>
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
        >
          {props.submitLabel}
        </button>
      </div>
    </form>
  );
}

// ---- 字段定义编辑表单 ----

export interface FieldEditorFormProps {
  readonly title: string;
  readonly initial: FieldDraft;
  /** 同表其他字段的 key（编辑模式排除自身）；用于 key 冲突即时校验 */
  readonly existingKeys: readonly string[];
  /** 引用目标候选表（当前记忆空间内全部表，含系统表） */
  readonly referenceTables: readonly MemoryTable[];
  /** 编辑模式 = true：类型选择器禁用（字段类型创建后不可修改） */
  readonly typeLocked: boolean;
  readonly submitLabel: string;
  readonly onSave: (draft: FieldDraft) => void;
  readonly onCancel: () => void;
}

export function FieldEditorForm(props: FieldEditorFormProps) {
  const [draft, setDraft] = useState<FieldDraft>(props.initial);
  const [errors, setErrors] = useState<FieldDraftErrors>({});

  function set<K extends keyof FieldDraft>(key: K, value: FieldDraft[K]): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function changeType(type: MemoryFieldType): void {
    // 切离引用类型时清空目标表（切到引用类型时由用户重新选择）
    setDraft((prev) => ({
      ...prev,
      type,
      referenceTableId: fieldTypeNeedsReference(type) ? prev.referenceTableId : "",
    }));
  }

  function submit(): void {
    const nextErrors = validateFieldDraft(draft, props.existingKeys);
    setErrors(nextErrors);
    if (nextErrors.key || nextErrors.name || nextErrors.options || nextErrors.reference) {
      return;
    }
    props.onSave(draft);
  }

  return (
    <form
      className="stm-editor"
      data-stm-editor="field"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="stm-editor-title">{props.title}</div>
      <label className="stm-form-row">
        <span className="stm-form-label">
          Key <em className="stm-form-required-mark">*</em>
        </span>
        <input
          className="stm-input"
          type="text"
          data-stm-field="field-key"
          value={draft.key}
          placeholder="唯一英文标识，如 full_name"
          onChange={(event) => set("key", event.target.value)}
        />
        {errors.key ? <span className="stm-form-error">{errors.key}</span> : null}
      </label>
      <label className="stm-form-row">
        <span className="stm-form-label">
          名称 <em className="stm-form-required-mark">*</em>
        </span>
        <input
          className="stm-input"
          type="text"
          data-stm-field="field-name"
          value={draft.name}
          placeholder="如：全名"
          onChange={(event) => set("name", event.target.value)}
        />
        {errors.name ? <span className="stm-form-error">{errors.name}</span> : null}
      </label>
      <label className="stm-form-row">
        <span className="stm-form-label">
          类型
          {props.typeLocked ? (
            <span className="stm-form-hint stm-form-hint--inline">创建后不可修改</span>
          ) : null}
        </span>
        <select
          className="stm-select"
          data-stm-field="field-type"
          value={draft.type}
          disabled={props.typeLocked}
          onChange={(event) => changeType(event.target.value as MemoryFieldType)}
        >
          {FIELD_TYPES.map((type) => (
            <option key={type} value={type}>
              {FIELD_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      </label>
      {fieldTypeNeedsOptions(draft.type) ? (
        <label className="stm-form-row">
          <span className="stm-form-label">
            固定选项 <em className="stm-form-required-mark">*</em>
          </span>
          <textarea
            className="stm-textarea"
            data-stm-field="field-options"
            value={draft.optionsText}
            rows={4}
            placeholder={"每行一个选项，如：\n朋友\n家人\n同事"}
            onChange={(event) => set("optionsText", event.target.value)}
          />
          {errors.options ? (
            <span className="stm-form-error">{errors.options}</span>
          ) : (
            <span className="stm-form-hint">每行一个选项，保存后不可重复</span>
          )}
        </label>
      ) : null}
      {fieldTypeNeedsReference(draft.type) ? (
        <label className="stm-form-row">
          <span className="stm-form-label">
            引用目标表 <em className="stm-form-required-mark">*</em>
          </span>
          <select
            className="stm-select"
            data-stm-field="field-reference-table"
            value={draft.referenceTableId}
            onChange={(event) => set("referenceTableId", event.target.value)}
          >
            <option value="">选择目标表…</option>
            {props.referenceTables.map((table) => (
              <option key={table.id} value={table.id}>
                {table.name}
                {table.kind === "system" ? "（系统表）" : ""}
              </option>
            ))}
          </select>
          {errors.reference ? (
            <span className="stm-form-error">{errors.reference}</span>
          ) : (
            <span className="stm-form-hint">只能引用当前记忆空间内的表</span>
          )}
        </label>
      ) : null}
      <label className="stm-form-row">
        <span className="stm-form-label">字段 Prompt</span>
        <textarea
          className="stm-textarea"
          data-stm-field="field-prompt"
          value={draft.prompt}
          rows={2}
          placeholder="给 Agent 的填值指引（可选）"
          onChange={(event) => set("prompt", event.target.value)}
        />
      </label>
      <div className="stm-form-row stm-form-row--inline">
        <label className="stm-form-check">
          <input
            type="checkbox"
            data-stm-field="field-required"
            checked={draft.required}
            onChange={(event) => set("required", event.target.checked)}
          />
          必填
        </label>
        <label className="stm-form-check">
          <input
            type="checkbox"
            data-stm-field="field-enabled"
            checked={draft.enabled}
            onChange={(event) => set("enabled", event.target.checked)}
          />
          启用
        </label>
      </div>
      {draft.required && !draft.enabled ? (
        <div className="stm-form-warning">停用必填字段后，Agent 可能无法创建合法记录</div>
      ) : null}
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
        >
          {props.submitLabel}
        </button>
      </div>
    </form>
  );
}
