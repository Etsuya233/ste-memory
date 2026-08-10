/**
 * 记录网格（表格填写视图，ticket 11 改造）：电子表格式网格替换「列表 + 表单」。
 *
 * 布局：行 = 记录，列 = 字段；最左为行号列。表头行与行号列 position: sticky
 * 冻结（纵向/横向滚动不跑），表头单元格右缘与行号表头右缘可拖拽调列宽（宽度
 * 持久化见 grid-editor-model 的 load/saveGridColumnWidths）。单元格输入按字段
 * 类型渲染（renderFieldInput，原记录表单逐类型控件原样复用）；停用字段只读。
 *
 * 纯逻辑（行草稿/校验/批量保存计划/列宽 clamp）在 grid-editor-model（有测试
 * 兜底），本组件只做「状态 → DOM」投影与指针事件接线；SSR 冒烟直接渲染。
 */
import { useRef, useState, type ReactNode } from "react";
import type {
  MemoryField,
  MemoryRecord,
  MemoryRecordId,
  MemoryTableId,
} from "@ste-memory/core/memory";
import {
  gridColumnWidth,
  type GridColumnWidths,
  type GridRowErrors,
} from "./grid-editor-model.ts";
import type { GridRowState } from "./grid-editor-model.ts";
import { FIELD_TYPE_LABELS } from "./table-list-model.ts";
import {
  formDisplayValueText,
  joinListText,
  recordValueFieldKey,
  type RecordFormValue,
} from "./record-form-model.ts";

// ---- 网格编辑器 ----

export interface GridEditorProps {
  readonly fields: readonly MemoryField[];
  readonly rows: readonly GridRowState[];
  readonly errors: GridRowErrors;
  readonly widths: GridColumnWidths;
  /** 引用字段的目标表记录（单选/多选引用下拉与勾选组的数据源） */
  readonly referenceRecords: ReadonlyMap<MemoryTableId, readonly MemoryRecord[]>;
  readonly onValueChange: (rowKey: string, fieldId: string, value: RecordFormValue) => void;
  readonly onToggleArrayValue: (rowKey: string, fieldId: string, item: string) => void;
  readonly onOpenRecord: (recordId: MemoryRecordId) => void;
  readonly onResizeRowNumber: (px: number) => void;
  readonly onResizeField: (fieldId: string, px: number) => void;
}

export function GridEditor(props: GridEditorProps) {
  const template = [
    `${props.widths.rowNumber}px`,
    ...props.fields.map((field) => `${gridColumnWidth(field.id, props.widths)}px`),
  ].join(" ");
  return (
    <div className="stm-grid-scroll">
      <div className="stm-grid" style={{ gridTemplateColumns: template }}>
        {/* 表头行：行号列 + 字段列（右缘把手可拖拽调宽） */}
        <div className="stm-grid-cell stm-grid-head stm-grid-rownum">
          <span className="stm-grid-rownum-label">#</span>
          <GridResizeHandle
            ariaLabel="调整行号列宽"
            width={props.widths.rowNumber}
            onResize={props.onResizeRowNumber}
          />
        </div>
        {props.fields.map((field) => (
          <div key={field.id} className="stm-grid-cell stm-grid-head" title={FIELD_TYPE_LABELS[field.type]}>
            <span className="stm-grid-head-name">
              {field.name}
              {field.required ? (
                <span className="stm-field-required" title="必填">
                  *
                </span>
              ) : null}
            </span>
            {!field.enabled ? <span className="stm-grid-head-disabled">停用</span> : null}
            <GridResizeHandle
              ariaLabel={`调整列宽：${field.name}`}
              width={gridColumnWidth(field.id, props.widths)}
              onResize={(px) => props.onResizeField(field.id, px)}
            />
          </div>
        ))}
        {/* 数据行 */}
        {props.rows.map((row, index) => (
          <GridRow
            key={row.key}
            row={row}
            rowNumber={index + 1}
            fields={props.fields}
            error={props.errors[row.key]}
            referenceRecords={props.referenceRecords}
            onValueChange={props.onValueChange}
            onToggleArrayValue={props.onToggleArrayValue}
            onOpenRecord={props.onOpenRecord}
          />
        ))}
      </div>
    </div>
  );
}

// ---- 数据行（行号单元格 + 每字段单元格） ----

function GridRow(props: {
  readonly row: GridRowState;
  readonly rowNumber: number;
  readonly fields: readonly MemoryField[];
  readonly error: Readonly<Record<string, string>> | undefined;
  readonly referenceRecords: ReadonlyMap<MemoryTableId, readonly MemoryRecord[]>;
  readonly onValueChange: (rowKey: string, fieldId: string, value: RecordFormValue) => void;
  readonly onToggleArrayValue: (rowKey: string, fieldId: string, item: string) => void;
  readonly onOpenRecord: (recordId: MemoryRecordId) => void;
}) {
  const isNew = props.row.recordId === null;
  return (
    <>
      <div
        className={`stm-grid-cell stm-grid-rownum${isNew ? " stm-grid-rownum--new" : ""}`}
        data-grid-row={isNew ? "new" : "existing"}
      >
        {isNew ? (
          <span className="stm-grid-rownum-label" title="新记录">
            +
          </span>
        ) : (
          <button
            type="button"
            className="stm-grid-rownum-btn"
            data-action="open-record"
            data-record-id={props.row.recordId}
            aria-label={`查看记录 ${props.rowNumber}`}
            title={`查看记录 ${props.rowNumber}`}
            onClick={() => props.onOpenRecord(props.row.recordId!)}
          >
            {props.rowNumber}
          </button>
        )}
      </div>
      {props.fields.map((field) => {
        const value = props.row.draft.values[field.id];
        const cellError = props.error?.[field.id];
        return (
          <div
            key={field.id}
            className={`stm-grid-cell stm-grid-cell--input${cellError ? " stm-grid-cell--error" : ""}`}
          >
            {field.enabled ? (
              renderFieldInput(
                field,
                props.row.draft,
                props.referenceRecords,
                (fieldId, next) => props.onValueChange(props.row.key, fieldId, next),
                (fieldId, item) => props.onToggleArrayValue(props.row.key, fieldId, item),
              )
            ) : (
              <span className="stm-grid-readonly" title="停用字段，编辑时保留原值">
                {formDisplayValueText(value)}
              </span>
            )}
            {cellError ? <div className="stm-grid-error">{cellError}</div> : null}
          </div>
        );
      })}
    </>
  );
}

// ---- 列宽拖拽把手（表头单元格右缘；触屏 touch-action none，桌面拖拽为主） ----

function GridResizeHandle(props: {
  readonly ariaLabel: string;
  /** 当前列宽（拖拽起点；拖拽中随父级 state 更新） */
  readonly width: number;
  readonly onResize: (px: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  function beginDrag(event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.stopPropagation();
    startXRef.current = event.clientX;
    startWidthRef.current = props.width;
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setDragging(true);
  }

  function moveDrag(event: React.PointerEvent<HTMLDivElement>): void {
    if (!dragging) return;
    props.onResize(startWidthRef.current + (event.clientX - startXRef.current));
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>): void {
    if (!dragging) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    setDragging(false);
  }

  return (
    <div
      className="stm-grid-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={props.ariaLabel}
      tabIndex={0}
      onPointerDown={beginDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") props.onResize(props.width - 8);
        if (event.key === "ArrowRight") props.onResize(props.width + 8);
      }}
    />
  );
}

// ---- 单元格输入（按字段类型；原记录表单控件语义原样保留） ----

function renderFieldInput(
  field: MemoryField,
  draft: { readonly values: Readonly<Record<string, RecordFormValue>> },
  referenceRecords: ReadonlyMap<MemoryTableId, readonly MemoryRecord[]>,
  updateValue: (fieldId: string, value: RecordFormValue) => void,
  toggleArrayValue: (fieldId: string, item: string) => void,
): ReactNode {
  const value = draft.values[field.id];
  const dataField = recordValueFieldKey(field);
  switch (field.type) {
    case "short_text":
      return (
        <input
          type="text"
          className="stm-input"
          data-stm-field={dataField}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => updateValue(field.id, event.target.value)}
        />
      );
    case "long_text":
      return (
        <textarea
          className="stm-input stm-input--textarea"
          data-stm-field={dataField}
          rows={2}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => updateValue(field.id, event.target.value)}
        />
      );
    case "short_text_list":
      return (
        <input
          type="text"
          className="stm-input"
          data-stm-field={dataField}
          placeholder="逗号或换行分隔多个值"
          value={
            typeof value === "string" ? value : joinListText(Array.isArray(value) ? value : [])
          }
          onChange={(event) => updateValue(field.id, event.target.value)}
        />
      );
    case "integer":
    case "decimal":
      return (
        <input
          type="number"
          step={field.type === "decimal" ? "any" : "1"}
          className="stm-input"
          data-stm-field={dataField}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => updateValue(field.id, event.target.value)}
        />
      );
    case "boolean":
      return (
        <label className="stm-switch">
          <input
            type="checkbox"
            data-stm-field={dataField}
            checked={value === true}
            onChange={(event) => updateValue(field.id, event.target.checked)}
          />
          <span className="stm-switch-track" aria-hidden="true"></span>
        </label>
      );
    case "date":
      return (
        <input
          type="date"
          className="stm-input"
          data-stm-field={dataField}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => updateValue(field.id, event.target.value)}
        />
      );
    case "datetime":
      return (
        <input
          type="datetime-local"
          className="stm-input"
          data-stm-field={dataField}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => updateValue(field.id, event.target.value)}
        />
      );
    case "single_select":
      return (
        <select
          className="stm-input"
          data-stm-field={dataField}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => updateValue(field.id, event.target.value)}
        >
          <option value="">—</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    case "multi_select":
      return (
        <div className="stm-option-group">
          {field.options.map((option) => (
            <label key={option} className="stm-option">
              <input
                type="checkbox"
                data-stm-field={dataField}
                checked={Array.isArray(value) && value.includes(option)}
                onChange={() => toggleArrayValue(field.id, option)}
              />
              <span>{option}</span>
            </label>
          ))}
        </div>
      );
    case "single_reference": {
      const options = field.referenceTableId
        ? (referenceRecords.get(field.referenceTableId) ?? [])
        : [];
      return (
        <select
          className="stm-input"
          data-stm-field={dataField}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => updateValue(field.id, event.target.value)}
        >
          <option value="">—</option>
          {options.map((record) => (
            <option key={record.id} value={record.id}>
              {record.displayText}
            </option>
          ))}
        </select>
      );
    }
    case "multi_reference": {
      const options = field.referenceTableId
        ? (referenceRecords.get(field.referenceTableId) ?? [])
        : [];
      return (
        <div className="stm-option-group">
          {options.map((record) => (
            <label key={record.id} className="stm-option">
              <input
                type="checkbox"
                data-stm-field={dataField}
                checked={Array.isArray(value) && value.includes(record.id)}
                onChange={() => toggleArrayValue(field.id, record.id)}
              />
              <span>{record.displayText}</span>
            </label>
          ))}
        </div>
      );
    }
  }
}
