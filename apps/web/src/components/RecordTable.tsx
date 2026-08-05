import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  LoaderCircle,
  Plus,
  Search,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { listMemoryFields, type MemoryField } from "../api/memory-fields.ts";
import {
  createMemoryRecord,
  listAllMemoryRecords,
  listMemoryRecords,
  updateMemoryRecord,
  type MemoryFieldValue,
  type MemoryRecord,
  type MemoryRecordPage,
  type MemoryRecordsByTable,
} from "../api/memory-records.ts";
import type { MemoryTable } from "../api/memory-tables.ts";
import { RecordCell } from "./RecordCell.tsx";

export interface RecordSelection {
  readonly record: MemoryRecord;
  readonly fields: readonly MemoryField[];
  readonly referenceRecords: MemoryRecordsByTable;
}

interface RecordTableProps {
  readonly memorySpaceId: string;
  readonly table: MemoryTable;
  readonly onSelect: (selection: RecordSelection | undefined) => void;
  readonly refreshVersion: number;
}

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

const saveStateContent = {
  idle: { icon: Circle, label: "无修改" },
  dirty: { icon: Circle, label: "待保存" },
  saving: { icon: LoaderCircle, label: "保存中" },
  saved: { icon: Check, label: "已保存" },
  error: { icon: AlertCircle, label: "保存失败" },
} as const;

function SaveIndicator({
  state,
  message,
}: {
  readonly state: SaveState;
  readonly message?: string;
}) {
  const content = saveStateContent[state];
  const Icon = content.icon;
  return (
    <span className={`record-save-state ${state}`} title={message || content.label}>
      <Icon size={14} className={state === "saving" ? "spinning" : ""} />
      {message || content.label}
    </span>
  );
}

interface ResizeHandleProps {
  readonly axis: "column" | "row";
  readonly size: number;
  readonly minSize: number;
  readonly label: string;
  readonly onResize: (size: number) => void;
}

function ResizeHandle({ axis, size, minSize, label, onResize }: ResizeHandleProps) {
  function startResize(event: ReactPointerEvent<HTMLSpanElement>) {
    event.preventDefault();
    event.stopPropagation();
    const startPosition = axis === "column" ? event.clientX : event.clientY;
    const resize = (moveEvent: PointerEvent) => {
      const position = axis === "column" ? moveEvent.clientX : moveEvent.clientY;
      onResize(Math.max(minSize, size + position - startPosition));
    };
    const stop = () => {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLSpanElement>) {
    const decrease = axis === "column" ? event.key === "ArrowLeft" : event.key === "ArrowUp";
    const increase = axis === "column" ? event.key === "ArrowRight" : event.key === "ArrowDown";
    if (!decrease && !increase) return;
    event.preventDefault();
    onResize(Math.max(minSize, size + (increase ? 12 : -12)));
  }

  return (
    <span
      className={`record-${axis}-resize-handle`}
      role="separator"
      aria-label={label}
      aria-orientation={axis === "column" ? "vertical" : "horizontal"}
      tabIndex={0}
      onKeyDown={resizeWithKeyboard}
      onPointerDown={startResize}
      /* 阻止 mousedown 默认的焦点转移：否则拖拽行/列手柄时，正在编辑的单元格会因失焦而关闭 */
      onMouseDown={(event) => event.preventDefault()}
    />
  );
}

interface RecordColumn {
  readonly key: string;
  readonly label: ReactNode;
  readonly resizeLabel: string;
  readonly defaultWidth: number;
  readonly className?: string;
  /** 是否允许拖拽调整列宽（行号等窄列关闭）。 */
  readonly resizable?: boolean;
}

interface EditableRecordRowProps {
  readonly memorySpaceId: string;
  readonly tableId: string;
  readonly record: MemoryRecord;
  readonly fields: readonly MemoryField[];
  readonly referenceRecords: MemoryRecordsByTable;
  readonly rowIndex: number;
  readonly onSaved: (record: MemoryRecord) => void;
  readonly onSelect: (record: MemoryRecord) => void;
}

function EditableRecordRow(props: EditableRecordRowProps) {
  const [payload, setPayload] = useState<Record<string, MemoryFieldValue>>(() => ({
    ...props.record.payload,
  }));
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveMessage, setSaveMessage] = useState<string>();
  const recordRef = useRef(props.record);
  const saveQueueRef = useRef(Promise.resolve());
  const fieldVersionsRef = useRef<Record<string, number>>({});
  const [rowHeight, setRowHeight] = useState(54);

  useEffect(() => {
    if (recordRef.current.revisionId === props.record.revisionId) return;
    recordRef.current = props.record;
    setPayload({ ...props.record.payload });
  }, [props.record]);

  function change(fieldId: string, value: MemoryFieldValue | undefined) {
    fieldVersionsRef.current[fieldId] = (fieldVersionsRef.current[fieldId] ?? 0) + 1;
    setPayload((current) => {
      const next = { ...current };
      if (value === undefined) delete next[fieldId];
      else next[fieldId] = value;
      return next;
    });
    setSaveState("dirty");
    setSaveMessage(undefined);
  }

  function save(fieldId: string) {
    const value = payload[fieldId];
    const fieldVersion = fieldVersionsRef.current[fieldId] ?? 0;
    if (JSON.stringify(recordRef.current.payload[fieldId]) === JSON.stringify(value)) return;
    setSaveState("saving");
    setSaveMessage(undefined);
    saveQueueRef.current = saveQueueRef.current.then(async () => {
      try {
        const updated = await updateMemoryRecord(
          props.memorySpaceId,
          props.tableId,
          recordRef.current.id,
          {
            expectedRevisionId: recordRef.current.revisionId,
            patch: { [fieldId]: value === undefined ? null : value },
          },
        );
        recordRef.current = updated;
        if ((fieldVersionsRef.current[fieldId] ?? 0) === fieldVersion) {
          setPayload((current) => {
            const next = { ...current };
            const savedValue = updated.payload[fieldId];
            if (savedValue === undefined) delete next[fieldId];
            else next[fieldId] = savedValue;
            return next;
          });
        }
        setSaveState("saved");
        props.onSaved(updated);
      } catch (cause) {
        setSaveState("error");
        setSaveMessage(cause instanceof Error ? cause.message : "无法保存记录");
      }
    });
  }

  return (
    <tr
      style={{ height: rowHeight }}
      onClick={() => props.onSelect(recordRef.current)}
      onFocus={() => props.onSelect(recordRef.current)}
    >
      <td className="record-row-index-cell">{props.rowIndex}</td>
      <td className="record-status-cell">
        <SaveIndicator state={saveState} message={saveMessage} />
        <ResizeHandle
          axis="row"
          size={rowHeight}
          minSize={42}
          label="调整记录行高"
          onResize={setRowHeight}
        />
      </td>
      <td className="record-display-cell">
        <strong>{recordRef.current.displayText || "未命名记录"}</strong>
      </td>
      {props.fields.map((field) => (
        <td key={field.id} className={`record-field-cell ${!field.enabled ? "disabled-record-cell" : ""}`}>
          <RecordCell
            field={field}
            value={payload[field.id]}
            referenceRecords={
              field.referenceTableId ? (props.referenceRecords[field.referenceTableId] ?? []) : []
            }
            onBlur={() => save(field.id)}
            onChange={(value) => change(field.id, value)}
          />
        </td>
      ))}
      <td className="record-id-cell">
        <code>{recordRef.current.id}</code>
      </td>
      <td>{recordRef.current.source.type === "manual" ? "手动" : "来源"}</td>
    </tr>
  );
}

interface NewRecordRowProps {
  readonly memorySpaceId: string;
  readonly table: MemoryTable;
  readonly fields: readonly MemoryField[];
  readonly referenceRecords: MemoryRecordsByTable;
  readonly onSaved: (record: MemoryRecord) => void;
}

function NewRecordRow(props: NewRecordRowProps) {
  const [payload, setPayload] = useState<Record<string, MemoryFieldValue>>({});
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveMessage, setSaveMessage] = useState<string>();
  const [rowHeight, setRowHeight] = useState(54);

  function change(fieldId: string, value: MemoryFieldValue | undefined) {
    setPayload((current) => {
      const next = { ...current };
      if (value === undefined) delete next[fieldId];
      else next[fieldId] = value;
      return next;
    });
    setSaveState("dirty");
    setSaveMessage(undefined);
  }

  async function save(event: FocusEvent<HTMLTableRowElement>) {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    if (Object.keys(payload).length === 0 || saveState === "saving") return;
    const missingField = props.fields.find((field) => {
      const value = payload[field.id];
      return (
        field.required &&
        (value === undefined ||
          value === null ||
          value === "" ||
          (Array.isArray(value) && value.length === 0))
      );
    });
    if (missingField) {
      setSaveState("error");
      setSaveMessage(`请填写 ${missingField.name}`);
      return;
    }
    setSaveState("saving");
    setSaveMessage(undefined);
    try {
      const created = await createMemoryRecord(props.memorySpaceId, props.table.id, { payload });
      setPayload({});
      setSaveState("saved");
      props.onSaved(created);
    } catch (cause) {
      setSaveState("error");
      setSaveMessage(cause instanceof Error ? cause.message : "无法创建记录");
    }
  }

  const disabled = !props.table.displayStrategy || saveState === "saving";
  return (
    <tr
      className="new-record-row"
      style={{ height: rowHeight }}
      onBlur={(event) => void save(event)}
    >
      <td className="record-row-index-cell" aria-hidden="true">
        <Plus size={12} />
      </td>
      <td className="record-status-cell">
        <span className="new-record-label">
          <Plus size={14} /> 新记录
        </span>
        <SaveIndicator
          state={saveState}
          message={!props.table.displayStrategy ? "请先配置显示策略" : saveMessage}
        />
        <ResizeHandle
          axis="row"
          size={rowHeight}
          minSize={42}
          label="调整新增行高"
          onResize={setRowHeight}
        />
      </td>
      <td className="record-display-cell">保存后生成</td>
      {props.fields.map((field) => (
        <td key={field.id} className={`record-field-cell ${!field.enabled ? "disabled-record-cell" : ""}`}>
          <RecordCell
            field={field}
            value={payload[field.id]}
            referenceRecords={
              field.referenceTableId ? (props.referenceRecords[field.referenceTableId] ?? []) : []
            }
            disabled={disabled}
            onChange={(value) => change(field.id, value)}
          />
        </td>
      ))}
      <td className="record-id-cell">自动生成</td>
      <td>手动</td>
    </tr>
  );
}

const PAGE_SIZE_OPTIONS = [50, 100, 200] as const;
const DEFAULT_PAGE_SIZE = 50;

export function RecordTable({ memorySpaceId, table, onSelect, refreshVersion }: RecordTableProps) {
  const [fields, setFields] = useState<MemoryField[]>([]);
  const [result, setResult] = useState<MemoryRecordPage>();
  const [referenceRecords, setReferenceRecords] = useState<MemoryRecordsByTable>({});
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});

  function load(nextPage: number, nextSearch: string) {
    setLoading(true);
    setError(undefined);
    void Promise.all([
      listMemoryFields(memorySpaceId, table.id),
      listMemoryRecords(memorySpaceId, table.id, {
        page: nextPage,
        pageSize,
        search: nextSearch,
      }),
    ])
      .then(async ([nextFields, nextResult]) => {
        const referenceTableIds = [
          ...new Set(
            nextFields.flatMap((field) => (field.referenceTableId ? [field.referenceTableId] : [])),
          ),
        ];
        const referenceEntries = await Promise.all(
          referenceTableIds.map(
            async (tableId) =>
              [tableId, await listAllMemoryRecords(memorySpaceId, tableId)] as const,
          ),
        );
        setFields(nextFields);
        setResult(nextResult);
        setReferenceRecords(Object.fromEntries(referenceEntries));
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "无法读取记录"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    onSelect(undefined);
    load(page, search);
  }, [memorySpaceId, table.id, page, search, pageSize, refreshVersion]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setPageInput("1");
    setSearch(searchInput);
  }

  /** 跳到指定页：钳制到有效范围，并同步页码输入框。 */
  function jumpToPage(raw: string) {
    const next = Number(raw);
    if (!Number.isInteger(next)) return;
    const clamped = Math.min(
      Math.max(1, next),
      Math.max(1, result?.totalPages ?? 1),
    );
    setPage(clamped);
    setPageInput(String(clamped));
  }

  function updateVisibleRecord(record: MemoryRecord) {
    setResult((current) =>
      current
        ? {
            ...current,
            records: current.records.map((item) => (item.id === record.id ? record : item)),
          }
        : current,
    );
    onSelect({ record, fields, referenceRecords });
  }

  /**
   * 选择回调的去重版：行内的 focus/click 会在编辑输入聚焦时再次触发，
   * 若每次都 setState 会引发整表重渲染，导致原生 date/time 输入框的
   * 内部焦点段丢失（表现为点击后无法键入）。同一 revision 只通知一次。
   */
  const lastSelectionKeyRef = useRef<string | undefined>(undefined);
  function selectRecord(record: MemoryRecord) {
    const key = `${record.id}@${record.revisionId}`;
    if (lastSelectionKeyRef.current === key) return;
    lastSelectionKeyRef.current = key;
    onSelect({ record, fields, referenceRecords });
  }

  const columns: readonly RecordColumn[] = [
    {
      key: "row",
      label: "",
      resizeLabel: "行号",
      defaultWidth: 44,
      className: "record-row-index-cell",
      resizable: false,
    },
    {
      key: "status",
      label: "保存状态",
      resizeLabel: "调整保存状态列宽",
      defaultWidth: 128,
      className: "record-status-cell",
    },
    {
      key: "display",
      label: "显示文本",
      resizeLabel: "调整显示文本列宽",
      defaultWidth: 180,
    },
    ...fields.map((field) => ({
      key: `field-${field.id}`,
      label: (
        <>
          {field.name}
          {field.required ? <strong> *</strong> : null}
        </>
      ),
      resizeLabel: `调整${field.name}列宽`,
      defaultWidth: 180,
      className: !field.enabled ? "disabled-record-cell" : undefined,
    })),
    { key: "id", label: "记录 ID", resizeLabel: "调整记录 ID 列宽", defaultWidth: 180 },
    { key: "source", label: "来源", resizeLabel: "调整来源列宽", defaultWidth: 100 },
  ];
  const tableWidth = columns.reduce(
    (total, column) => total + (columnWidths[column.key] ?? column.defaultWidth),
    0,
  );

  return (
    <div className="record-table-workspace">
      <div className="record-toolbar">
        <form className="record-search" onSubmit={submitSearch}>
          <Search size={16} />
          <input
            aria-label="搜索当前表格"
            placeholder="搜索显示文本、字段值或记录 ID"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </form>
      </div>
      {error ? <p className="form-error record-table-error">{error}</p> : null}
      {loading && !result ? (
        <div className="table-empty-state">
          <p>正在读取记录...</p>
        </div>
      ) : null}
      {result ? (
        <>
          <div className="record-table-scroll">
            <table
              className="record-table"
              style={
                { width: tableWidth, "--record-table-width": `${tableWidth}px` } as CSSProperties
              }
            >
              <colgroup>
                {columns.map((column) => (
                  <col
                    key={column.key}
                    style={{ width: columnWidths[column.key] ?? column.defaultWidth }}
                  />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {columns.map((column) => {
                    const width = columnWidths[column.key] ?? column.defaultWidth;
                    return (
                      <th key={column.key} className={column.className}>
                        {column.label}
                        {column.resizable === false ? null : (
                          <ResizeHandle
                            axis="column"
                            size={width}
                            minSize={88}
                            label={column.resizeLabel}
                            onResize={(nextWidth) =>
                              setColumnWidths((current) => ({
                                ...current,
                                [column.key]: nextWidth,
                              }))
                            }
                          />
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {result.records.map((record, index) => (
                  <EditableRecordRow
                    key={record.id}
                    memorySpaceId={memorySpaceId}
                    tableId={table.id}
                    record={record}
                    fields={fields}
                    referenceRecords={referenceRecords}
                    rowIndex={(page - 1) * pageSize + index + 1}
                    onSaved={updateVisibleRecord}
                    onSelect={selectRecord}
                  />
                ))}
                <NewRecordRow
                  memorySpaceId={memorySpaceId}
                  table={table}
                  fields={fields}
                  referenceRecords={referenceRecords}
                  onSaved={(record) => {
                    onSelect({ record, fields, referenceRecords });
                    load(page, search);
                  }}
                />
              </tbody>
            </table>
          </div>
          {result.total === 0 && search ? (
            <p className="record-search-empty">当前没有匹配记录，可直接在表尾新增。</p>
          ) : null}
          <footer className="record-pagination">
            <span>
              共 {result.total} 条 · 第 {result.page}/{Math.max(1, result.totalPages)} 页
            </span>
            <div className="record-pagination-controls">
              <button
                className="icon-btn"
                type="button"
                aria-label="上一页"
                disabled={page <= 1}
                onClick={() => jumpToPage(String(page - 1))}
              >
                <ChevronLeft size={16} />
              </button>
              <form
                className="record-page-jump"
                onSubmit={(event) => {
                  event.preventDefault();
                  jumpToPage(pageInput);
                }}
              >
                <input
                  type="number"
                  min={1}
                  max={Math.max(1, result.totalPages)}
                  value={pageInput}
                  aria-label="页码"
                  title="输入页码后按 Enter 跳转"
                  onChange={(event) => setPageInput(event.target.value)}
                  onBlur={() => jumpToPage(pageInput)}
                />
                <span>/ {Math.max(1, result.totalPages)}</span>
              </form>
              <button
                className="icon-btn"
                type="button"
                aria-label="下一页"
                disabled={page >= result.totalPages}
                onClick={() => jumpToPage(String(page + 1))}
              >
                <ChevronRight size={16} />
              </button>
              <select
                className="record-page-size"
                value={pageSize}
                aria-label="每页条数"
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                  setPageInput("1");
                }}
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size} 条/页
                  </option>
                ))}
              </select>
            </div>
          </footer>
        </>
      ) : null}
    </div>
  );
}
