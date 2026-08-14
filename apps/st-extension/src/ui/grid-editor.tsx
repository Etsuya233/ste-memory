/**
 * 记录网格（表格填写视图，ticket 11 改造 + ticket 21 UX）：行 = 记录，列 = 字段。
 *
 * 布局：最左为行号列；表头行与行号列 position: sticky 冻结（纵向/横向滚动不跑）。
 * 表头单元格右缘可拖拽调列宽、行号单元格下缘可拖拽调行高（逐行，均持久化，见
 * grid-editor-model 的 load/saveGridColumnWidths / load/saveGridRowHeights）。
 *
 * 查看/编辑模式（ticket 21）：每行处于两种模式之一——查看模式默认，整行格式化
 * 只读文本（引用解析 + 3 行 / 8 字截断），点击单元格进入编辑模式；编辑模式控件
 * 铺满单元格（短/长文本/列表均为 textarea；多选为原生 <select multiple>），焦点
 * 离开该行退回查看模式，Esc 撤销该行改动。已修改行背景色标记；保存中行号格替换
 * 为转圈状态；校验/提交错误显示在行底错误条（跨整行宽）。
 *
 * 纯逻辑（行草稿/校验/保存计划/列宽行高 clamp/脏判定/查看文本）在
 * grid-editor-model（有测试兜底），本组件只做「状态 → DOM」投影与指针事件接线。
 */
import { useRef, useState, type ReactNode } from "react";
import type {
  MemoryField,
  MemoryRecord,
  MemoryRecordId,
  MemoryTableId,
} from "@ste-memory/core/memory";
import {
  buildReferenceLabelMap,
  gridColumnWidth,
  gridDisplayValueText,
  gridRowErrorLines,
  gridRowHeight,
  type GridColumnWidths,
  type GridRowErrors,
  type GridRowHeights,
} from "./grid-editor-model.ts";
import type { GridRowState } from "./grid-editor-model.ts";
import { FIELD_TYPE_LABELS } from "./table-list-model.ts";
import { joinListText, recordValueFieldKey, type RecordFormValue } from "./record-form-model.ts";

// ---- 网格编辑器 ----

export interface GridEditorProps {
  readonly fields: readonly MemoryField[];
  readonly rows: readonly GridRowState[];
  /** 校验错误（保存时全校验；行底错误条） */
  readonly errors: GridRowErrors;
  /** 提交失败（逐行保存时收集；行底错误条置顶行） */
  readonly commitErrors: Readonly<Record<string, string>>;
  readonly widths: GridColumnWidths;
  readonly heights: GridRowHeights;
  /** 正在编辑的行（null = 全部查看模式） */
  readonly editingKey: string | null;
  /** 进入编辑模式时自动聚焦的字段（点击进编辑的那个单元格） */
  readonly focusFieldId: string | null;
  /** 已修改（未保存）行 key 集合：背景色标记 */
  readonly dirtyRowKeys: ReadonlySet<string>;
  /** 正在保存的行 key 集合：行号格替换为转圈状态 */
  readonly savingRowKeys: ReadonlySet<string>;
  /** 引用字段的目标表记录（单选/多选引用下拉与查看文本解析的数据源） */
  readonly referenceRecords: ReadonlyMap<MemoryTableId, readonly MemoryRecord[]>;
  readonly onValueChange: (rowKey: string, fieldId: string, value: RecordFormValue) => void;
  readonly onOpenRecord: (recordId: MemoryRecordId) => void;
  readonly onEditRow: (rowKey: string | null, focusFieldId?: string) => void;
  /** Esc：撤销该行改动并退出编辑模式（新行 = 删除草稿行） */
  readonly onRevertRow: (rowKey: string) => void;
  readonly onResizeRowNumber: (px: number) => void;
  readonly onResizeField: (fieldId: string, px: number) => void;
  readonly onResizeRowHeight: (rowKey: string, px: number) => void;
}

export function GridEditor(props: GridEditorProps) {
  const template = [
    `${props.widths.rowNumber}px`,
    ...props.fields.map((field) => `${gridColumnWidth(field.id, props.widths)}px`),
  ].join(" ");
  const referenceLabels = buildReferenceLabelMap(props.referenceRecords);
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
          <div
            key={field.id}
            className="stm-grid-cell stm-grid-head"
            title={FIELD_TYPE_LABELS[field.type]}
          >
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
            commitError={props.commitErrors[row.key]}
            referenceLabels={referenceLabels}
            referenceRecords={props.referenceRecords}
            rowHeight={gridRowHeight(row.key, props.heights)}
            editing={props.editingKey === row.key}
            focusFieldId={props.editingKey === row.key ? props.focusFieldId : null}
            dirty={props.dirtyRowKeys.has(row.key)}
            saving={props.savingRowKeys.has(row.key)}
            onValueChange={props.onValueChange}
            onOpenRecord={props.onOpenRecord}
            onEditRow={props.onEditRow}
            onRevertRow={props.onRevertRow}
            onResizeRowHeight={props.onResizeRowHeight}
          />
        ))}
      </div>
    </div>
  );
}

// ---- 数据行（行号单元格 + 每字段单元格 + 行底错误条） ----

function GridRow(props: {
  readonly row: GridRowState;
  readonly rowNumber: number;
  readonly fields: readonly MemoryField[];
  readonly error: Readonly<Record<string, string>> | undefined;
  readonly commitError: string | undefined;
  readonly referenceLabels: ReadonlyMap<string, string>;
  readonly referenceRecords: ReadonlyMap<MemoryTableId, readonly MemoryRecord[]>;
  readonly rowHeight: number;
  readonly editing: boolean;
  readonly focusFieldId: string | null;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly onValueChange: (rowKey: string, fieldId: string, value: RecordFormValue) => void;
  readonly onOpenRecord: (recordId: MemoryRecordId) => void;
  readonly onEditRow: (rowKey: string | null, focusFieldId?: string) => void;
  readonly onRevertRow: (rowKey: string) => void;
  readonly onResizeRowHeight: (rowKey: string, px: number) => void;
}) {
  const { row, fields } = props;
  const isNew = row.recordId === null;
  const dirtyClass = props.dirty ? " stm-grid-cell--dirty" : "";
  const heightStyle = { height: props.rowHeight };
  const errorLines = gridRowErrorLines(props.error, props.commitError, fields);
  // 行内所有单元格元素（0 = 行号格，1+ = 字段格）：失焦时判断焦点是否仍在行内
  // （行内 Tab/点击切换字段不退出编辑模式，焦点离开整行才退出）
  const rowCellRefs = useRef<(HTMLDivElement | null)[]>([]);
  const cellRef = (index: number) => (element: HTMLDivElement | null) => {
    rowCellRefs.current[index] = element;
  };
  function focusLeftRow(event: { readonly relatedTarget: EventTarget | null }): boolean {
    const related = event.relatedTarget as Node | null;
    return !rowCellRefs.current.some((cell) => cell !== null && cell.contains(related));
  }

  return (
    <>
      <div
        className={`stm-grid-cell stm-grid-rownum${isNew ? " stm-grid-rownum--new" : ""}${dirtyClass}`}
        data-grid-row={isNew ? "new" : "existing"}
        style={heightStyle}
        ref={cellRef(0)}
      >
        {props.saving ? (
          <span className="stm-grid-rownum-saving" title="保存中" aria-label="保存中">
            <i className="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>
          </span>
        ) : isNew ? (
          <span className="stm-grid-rownum-label" title="新记录">
            +
          </span>
        ) : (
          <button
            type="button"
            className="stm-grid-rownum-btn"
            data-action="open-record"
            data-record-id={row.recordId!}
            aria-label={`查看记录 ${props.rowNumber}`}
            title={`查看记录 ${props.rowNumber}`}
            onClick={() => props.onOpenRecord(row.recordId!)}
          >
            {props.rowNumber}
          </button>
        )}
        <GridRowResizeHandle
          ariaLabel={`调整记录 ${props.rowNumber} 行高`}
          height={props.rowHeight}
          onResize={(px) => props.onResizeRowHeight(row.key, px)}
        />
      </div>
      {fields.map((field, fieldIndex) => {
        const value = row.draft.values[field.id];
        const dataField = recordValueFieldKey(field);
        return (
          <div
            key={field.id}
            ref={cellRef(fieldIndex + 1)}
            className={`stm-grid-cell${props.editing && field.enabled ? " stm-grid-cell--input" : " stm-grid-cell--view"}${dirtyClass}`}
            style={heightStyle}
            onBlur={
              props.editing
                ? (event) => {
                    // 焦点离开整行（含 tab 出最后一个控件/点外部）→ 退出编辑模式
                    if (focusLeftRow(event)) {
                      props.onEditRow(null);
                    }
                  }
                : undefined
            }
            onKeyDown={
              props.editing
                ? (event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      props.onRevertRow(row.key);
                    }
                  }
                : undefined
            }
          >
            {props.editing && field.enabled ? (
              renderFieldInput(
                field,
                row.draft,
                props.referenceRecords,
                (fieldId, next) => props.onValueChange(row.key, fieldId, next),
                props.focusFieldId === field.id,
              )
            ) : (
              <div
                className={`stm-grid-view-text${field.enabled ? "" : " stm-grid-view-text--disabled"}`}
                title={gridDisplayValueText(field, value, props.referenceLabels)}
                data-stm-field={dataField}
                onClick={field.enabled ? () => props.onEditRow(row.key, field.id) : undefined}
              >
                {gridDisplayValueText(field, value, props.referenceLabels)}
              </div>
            )}
          </div>
        );
      })}
      {errorLines.length > 0 ? (
        <div className="stm-grid-row-errors" style={{ gridColumn: "1 / -1" }}>
          {errorLines.map((line) => (
            <div key={line} className="stm-grid-row-error">
              {line}
            </div>
          ))}
        </div>
      ) : null}
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

// ---- 行高拖拽把手（行号单元格下缘；与列宽把手同一指针模式，纵向） ----

function GridRowResizeHandle(props: {
  readonly ariaLabel: string;
  /** 当前行高（拖拽起点；拖拽中随父级 state 更新） */
  readonly height: number;
  readonly onResize: (px: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  function beginDrag(event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.stopPropagation();
    startYRef.current = event.clientY;
    startHeightRef.current = props.height;
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    setDragging(true);
  }

  function moveDrag(event: React.PointerEvent<HTMLDivElement>): void {
    if (!dragging) return;
    props.onResize(startHeightRef.current + (event.clientY - startYRef.current));
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
      className="stm-grid-row-resize"
      role="separator"
      aria-orientation="horizontal"
      aria-label={props.ariaLabel}
      tabIndex={0}
      onPointerDown={beginDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp") props.onResize(props.height - 8);
        if (event.key === "ArrowDown") props.onResize(props.height + 8);
      }}
    />
  );
}

// ---- 单元格输入（按字段类型；编辑模式控件铺满单元格） ----

function renderFieldInput(
  field: MemoryField,
  draft: { readonly values: Readonly<Record<string, RecordFormValue>> },
  referenceRecords: ReadonlyMap<MemoryTableId, readonly MemoryRecord[]>,
  updateValue: (fieldId: string, value: RecordFormValue) => void,
  autoFocus: boolean,
): ReactNode {
  const value = draft.values[field.id];
  const dataField = recordValueFieldKey(field);
  switch (field.type) {
    case "short_text":
    case "long_text":
      // 短/长文本统一 textarea 铺满单元格（ticket 21）
      return (
        <textarea
          className="stm-input"
          data-stm-field={dataField}
          autoFocus={autoFocus}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => updateValue(field.id, event.target.value)}
        />
      );
    case "short_text_list":
      return (
        <textarea
          className="stm-input"
          data-stm-field={dataField}
          autoFocus={autoFocus}
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
          autoFocus={autoFocus}
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
            autoFocus={autoFocus}
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
          autoFocus={autoFocus}
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
          autoFocus={autoFocus}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => updateValue(field.id, event.target.value)}
        />
      );
    case "single_select":
      return (
        <select
          className="stm-input"
          data-stm-field={dataField}
          autoFocus={autoFocus}
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
      // 原生多选（ticket 21）：size 压缩到 3 行适配默认行高，桌面为行内列表框、iOS 全屏选择器
      return (
        <select
          multiple
          size={Math.min(Math.max(field.options.length, 1), 3)}
          className="stm-input stm-input--multiselect"
          data-stm-field={dataField}
          autoFocus={autoFocus}
          value={Array.isArray(value) ? [...value] : []}
          onChange={(event) =>
            updateValue(
              field.id,
              [...event.target.selectedOptions].map((option) => option.value),
            )
          }
        >
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    case "single_reference": {
      const options = field.referenceTableId
        ? (referenceRecords.get(field.referenceTableId) ?? [])
        : [];
      return (
        <select
          className="stm-input"
          data-stm-field={dataField}
          autoFocus={autoFocus}
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
        <select
          multiple
          size={Math.min(Math.max(options.length, 1), 3)}
          className="stm-input stm-input--multiselect"
          data-stm-field={dataField}
          autoFocus={autoFocus}
          value={Array.isArray(value) ? [...value] : []}
          onChange={(event) =>
            updateValue(
              field.id,
              [...event.target.selectedOptions].map((option) => option.value),
            )
          }
        >
          {options.map((record) => (
            <option key={record.id} value={record.id}>
              {record.displayText}
            </option>
          ))}
        </select>
      );
    }
  }
}
