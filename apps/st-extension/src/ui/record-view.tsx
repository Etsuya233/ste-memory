/**
 * 记录视图（ticket 11）：按表查看/搜索/分页的记录列表、记录详情（字段值 + 字段证据
 * 楼层 chip）、手动创建/编辑/删除。纯逻辑 seam（record-list-model / record-form-model
 * / evidence-chip-model，有测试兜底）之外，组件只做「状态 → DOM」投影与事件接线。
 *
 * 显示文本按「读时计算」（协调者决策，ticket 10 Comments）：列表行与详情主文案用
 * core previewDisplayText(表当前策略, record.payload) 现算，策略为 null 或计算失败
 * 降级存储 displayText。证据楼层 chip 是全插件唯一签名元素（spec §11）：铜绿 +
 * 等宽 #N，点按跳转 ST 对应消息（adapter.scrollToFloor），悬停/长按浮出原文摘录。
 */
import type {
  MemoryField,
  MemoryRecord,
  MemoryRecordHistory,
  MemoryRecordId,
  MemoryRecordPage,
  MemoryTable,
  MemoryTableId,
} from "@ste-memory/core/memory";
import { useEffect, useRef, useState } from "react";
import type { PluginSettings } from "../settings/plugin-settings.ts";
import type { SpaceContextStatus } from "../space-binding/chat-space-manager.ts";
import type { StChatMessage } from "../st/st-chat-adapter.ts";
import type { PanelRuntime } from "./panel-shell.tsx";
import {
  activeStatus,
  Placeholder,
  reportError,
  reportSuccess,
  reportWarning,
} from "./ui-helpers.tsx";
import { formatSyncTime } from "./space-info.ts";
import { recordSourceLabel, revisionSummaryLine } from "./record-list-model.ts";
import { recordFieldValueText, type RecordFormValue } from "./record-form-model.ts";
import { GridEditor } from "./grid-editor.tsx";
import {
  clampGridWidth,
  defaultGridColumnWidths,
  emptyGridRow,
  GRID_FIELD_MIN_WIDTH,
  GRID_ROW_NUMBER_MIN_WIDTH,
  gridRowsFromRecords,
  hasUnsavedGridChanges,
  loadGridColumnWidths,
  planGridSave,
  saveGridColumnWidths,
  validateGridRows,
  type GridColumnWidths,
  type GridRowErrors,
  type GridRowState,
} from "./grid-editor-model.ts";
import {
  buildMessageExcerpt,
  evidenceChipViewModels,
  floorJumpHint,
  recordHasEvidence,
  type ChatMessageExcerpt,
  type FloorJumpOutcome,
} from "./evidence-chip-model.ts";

/** 列表页大小（记录分页，core list 上限 100 内） */
const RECORD_PAGE_SIZE = 10;

// ---- 记录列表 Tab ----

export function RecordsTab(props: {
  readonly runtime: PanelRuntime;
  readonly status: SpaceContextStatus | undefined;
  readonly settings: PluginSettings;
  /** 整库数据版本（导入备份后自增，驱动重取） */
  readonly dataVersion: number;
}) {
  const [tables, setTables] = useState<readonly MemoryTable[] | undefined>(undefined);
  const [selectedTableId, setSelectedTableId] = useState<MemoryTableId | null>(null);
  const [fields, setFields] = useState<readonly MemoryField[]>([]);
  const [recordPage, setRecordPage] = useState<MemoryRecordPage | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // 详情
  const [detailRecordId, setDetailRecordId] = useState<MemoryRecordId | null>(null);
  const [detailRecord, setDetailRecord] = useState<MemoryRecord | undefined>(undefined);
  const [detailDisplayText, setDetailDisplayText] = useState<string>("");
  const [history, setHistory] = useState<readonly MemoryRecordHistory[]>([]);
  // 网格（表格填写视图）：行草稿 + 单元格校验错误 + 列宽（按表持久化，见 model）
  const [gridRows, setGridRows] = useState<readonly GridRowState[]>([]);
  const [gridErrors, setGridErrors] = useState<GridRowErrors>({});
  const [widths, setWidths] = useState<GridColumnWidths>(() => defaultGridColumnWidths([]));
  const [savingGrid, setSavingGrid] = useState(false);
  const newRowCounter = useRef(0);
  // 引用字段的目标表记录（单选/多选引用下拉与勾选组的数据源）
  const [referenceRecords, setReferenceRecords] = useState<
    ReadonlyMap<MemoryTableId, readonly MemoryRecord[]>
  >(new Map());

  const active = activeStatus(props.status);
  const spaceId = active?.space.id;

  /** 数据变更收尾：刷新列表 + 立即重建记忆宏快照（消除指纹轮询陈旧窗口） */
  function bumpData(): void {
    setReloadKey((key) => key + 1);
    void props.runtime.macro.kick().catch(reportError);
  }

  // 表格列表：切空间/导入备份后重取；默认选中第一张表
  useEffect(() => {
    if (!spaceId) {
      setTables(undefined);
      setSelectedTableId(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = await props.runtime.tables.list(spaceId);
        if (cancelled) return;
        setTables(list);
        setSelectedTableId((prev) =>
          prev && list.some((table) => table.id === prev) ? prev : (list[0]?.id ?? null),
        );
      } catch (error) {
        if (!cancelled) reportError(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.runtime, spaceId, props.dataVersion]);

  // 最新网格状态 ref：防抖/翻页/切表的脏检查用（避免把网格状态放进 effect 依赖导致
  // 用户填表时重建计时器）
  const gridStateRef = useRef({ fields, gridRows, recordPage });
  gridStateRef.current = { fields, gridRows, recordPage };

  // 搜索防抖：输入停顿 300ms 后生效并回到第一页（网格有未保存修改时先确认丢弃）
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!confirmDiscardIfDirty()) {
        setSearchInput(search);
        return;
      }
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // 记录分页 + 字段（网格数据源；显示文本在详情读时计算，列表不再需要）
  useEffect(() => {
    if (!spaceId || !selectedTableId) {
      setRecordPage(undefined);
      setFields([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [fieldList, pageData] = await Promise.all([
          props.runtime.fields.list(spaceId, selectedTableId),
          props.runtime.records.list(spaceId, selectedTableId, {
            page,
            pageSize: RECORD_PAGE_SIZE,
            search: search.length > 0 ? search : undefined,
          }),
        ]);
        if (cancelled) return;
        setFields(fieldList);
        setRecordPage(pageData);
        setLoadError(null);
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.runtime, spaceId, selectedTableId, page, search, reloadKey, props.dataVersion]);

  // 引用字段目标表记录（表单选项；失败不阻塞，core 引用校验兜底）
  useEffect(() => {
    if (!spaceId || !selectedTableId) {
      setReferenceRecords(new Map());
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const fieldList = await props.runtime.fields.list(spaceId, selectedTableId);
        const targetIds = [
          ...new Set(
            fieldList
              .filter((field) => field.referenceTableId !== null)
              .map((field) => field.referenceTableId!),
          ),
        ];
        const map = new Map<MemoryTableId, readonly MemoryRecord[]>();
        for (const tableId of targetIds) {
          const pageData = await props.runtime.records.list(spaceId, tableId, {
            page: 1,
            pageSize: 100,
          });
          if (cancelled) return;
          map.set(tableId, pageData?.records ?? []);
        }
        if (cancelled) return;
        setReferenceRecords(map);
      } catch {
        // 引用选项加载失败：表单仍可提交，core validateMemoryRecordReferences 兜底
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.runtime, spaceId, selectedTableId, reloadKey, props.dataVersion]);

  // 网格行：记录页/字段变化时重建（未保存修改已在切表/翻页/搜索入口确认丢弃）
  useEffect(() => {
    setGridRows(gridRowsFromRecords(fields, recordPage?.records ?? []));
    setGridErrors({});
  }, [fields, recordPage]);

  // 列宽：切表/字段变化时从持久化读取；宽度变化写回（拖拽调宽即时生效，按表记住）
  useEffect(() => {
    if (!selectedTableId) return;
    setWidths(loadGridColumnWidths(fields, selectedTableId));
  }, [spaceId, selectedTableId, fields]);
  useEffect(() => {
    if (!selectedTableId) return;
    saveGridColumnWidths(selectedTableId, widths);
  }, [widths, selectedTableId]);

  // 详情：记录 + 修订历史 + 读时显示文本
  useEffect(() => {
    if (!spaceId || !selectedTableId || !detailRecordId) {
      setDetailRecord(undefined);
      setHistory([]);
      setDetailDisplayText("");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const record = await props.runtime.records.find(spaceId, selectedTableId, detailRecordId);
        const historyList = await props.runtime.records.listHistory(spaceId, {
          tableId: selectedTableId,
          recordId: detailRecordId,
        });
        if (cancelled) return;
        setDetailRecord(record);
        setHistory(historyList);
        const table = tables?.find((item) => item.id === selectedTableId);
        if (record && table?.displayStrategy) {
          try {
            const text = await props.runtime.records.previewDisplayText(
              spaceId,
              selectedTableId,
              table.displayStrategy,
              record.payload,
            );
            if (!cancelled) setDetailDisplayText(text);
          } catch {
            if (!cancelled) setDetailDisplayText(record.displayText);
          }
        } else if (record) {
          setDetailDisplayText(record.displayText);
        }
      } catch (error) {
        if (!cancelled) reportError(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.runtime, spaceId, selectedTableId, detailRecordId, reloadKey, tables]);

  if (!props.settings.enabled) {
    return <Placeholder title="插件已停用" hint="在设置中重新启用后恢复记录展示" />;
  }
  if (!active) {
    return (
      <Placeholder
        title={props.status && props.status.kind !== "active" ? props.status.humanMsg : "正在加载…"}
        hint="切换到已保存的对话后自动恢复"
      />
    );
  }
  const currentSpaceId = active.space.id;
  if (tables === undefined) {
    return <Placeholder title="正在加载…" hint="记录列表准备中" />;
  }
  if (tables.length === 0) {
    return <Placeholder title="还没有表格" hint="先在「表格」页创建自定义表格与字段" />;
  }
  const currentTable = tables.find((table) => table.id === selectedTableId) ?? tables[0]!;

  // 是否存在未保存改动（驱动「放弃修改」按钮显示）
  const dirty = hasUnsavedGridChanges(
    fields,
    gridRows,
    new Map((recordPage?.records ?? []).map((record) => [record.id, record])),
  );

  /** 网格有未保存修改时先确认放弃（返回是否可继续） */
  function confirmDiscardIfDirty(): boolean {
    const { fields: currentFields, gridRows: rows, recordPage: page } = gridStateRef.current;
    const originals = new Map((page?.records ?? []).map((record) => [record.id, record]));
    if (!hasUnsavedGridChanges(currentFields, rows, originals)) return true;
    return window.confirm("网格里有未保存的修改，放弃这些修改吗？");
  }

  function selectTable(tableId: MemoryTableId): void {
    if (!confirmDiscardIfDirty()) return;
    setSelectedTableId(tableId);
    setPage(1);
    setSearchInput("");
    setSearch("");
    setDetailRecordId(null);
  }

  function openRecord(recordId: MemoryRecordId): void {
    setDetailRecordId(recordId);
  }

  function addGridRow(): void {
    newRowCounter.current += 1;
    setGridRows((prev) => [...prev, emptyGridRow(fields, `new-${newRowCounter.current}`)]);
  }

  function discardGrid(): void {
    setGridRows(gridRowsFromRecords(fields, recordPage?.records ?? []));
    setGridErrors({});
  }

  function updateRowValue(rowKey: string, fieldId: string, value: RecordFormValue): void {
    setGridRows((prev) =>
      prev.map((row) =>
        row.key === rowKey
          ? {
              ...row,
              draft: { ...row.draft, values: { ...row.draft.values, [fieldId]: value } },
            }
          : row,
      ),
    );
    // 输入后清除该单元格错误（保存时全量重算兜底）
    setGridErrors((prev) => {
      const rowErrors = prev[rowKey];
      if (!rowErrors || rowErrors[fieldId] === undefined) return prev;
      const next = { ...prev };
      const nextRowErrors = { ...rowErrors };
      delete nextRowErrors[fieldId];
      if (Object.keys(nextRowErrors).length === 0) {
        delete next[rowKey];
      } else {
        next[rowKey] = nextRowErrors;
      }
      return next;
    });
  }

  function toggleArrayRowValue(rowKey: string, fieldId: string, item: string): void {
    setGridRows((prev) =>
      prev.map((row) => {
        if (row.key !== rowKey) return row;
        const current = Array.isArray(row.draft.values[fieldId])
          ? [...(row.draft.values[fieldId] as readonly string[])]
          : [];
        const next = current.includes(item)
          ? current.filter((value) => value !== item)
          : [...current, item];
        return {
          ...row,
          draft: { ...row.draft, values: { ...row.draft.values, [fieldId]: next } },
        };
      }),
    );
  }

  async function saveGrid(): Promise<void> {
    if (!spaceId || !selectedTableId) return;
    const nextErrors = validateGridRows(fields, gridRows);
    setGridErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      reportWarning("有字段未通过校验，请修正后再保存");
      return;
    }
    const originals = new Map((recordPage?.records ?? []).map((record) => [record.id, record]));
    const plan = planGridSave(fields, gridRows, originals);
    if (!plan.changed) {
      reportWarning("没有修改任何字段");
      return;
    }
    setSavingGrid(true);
    try {
      for (const payload of plan.creates) {
        await props.runtime.records.create(spaceId, selectedTableId, {
          payload,
          source: { type: "manual" },
        });
      }
      for (const update of plan.updates) {
        await props.runtime.records.update(spaceId, selectedTableId, update.recordId, {
          expectedRevisionId: update.expectedRevisionId,
          patch: update.patch,
          revisionSource: "user",
        });
      }
      reportSuccess(
        plan.creates.length > 0 && plan.updates.length > 0
          ? `已保存：新建 ${plan.creates.length} 条、更新 ${plan.updates.length} 条`
          : plan.creates.length > 0
            ? `已创建 ${plan.creates.length} 条记录`
            : `已更新 ${plan.updates.length} 条记录`,
      );
      bumpData();
    } catch (error) {
      reportError(error);
    } finally {
      setSavingGrid(false);
    }
  }

  function resizeRowNumber(px: number): void {
    setWidths((prev) => ({
      ...prev,
      rowNumber: clampGridWidth(px, GRID_ROW_NUMBER_MIN_WIDTH),
    }));
  }

  function resizeField(fieldId: string, px: number): void {
    setWidths((prev) => ({
      ...prev,
      fields: { ...prev.fields, [fieldId]: clampGridWidth(px, GRID_FIELD_MIN_WIDTH) },
    }));
  }

  async function deleteRecord(): Promise<void> {
    if (!selectedTableId || !detailRecord || !detailRecordId) return;
    if (!window.confirm("确定删除这条记录吗？删除后不可恢复。")) return;
    try {
      await props.runtime.records.delete(
        currentSpaceId,
        selectedTableId,
        detailRecordId,
        detailRecord.revisionId,
        "user",
      );
      reportSuccess("记录已删除");
      setDetailRecordId(null);
      bumpData();
    } catch (error) {
      reportError(error);
    }
  }

  return (
    <div className="stm-record-view">
      <div className="stm-record-toolbar">
        <select
          className="stm-input stm-record-select"
          data-action="record-table-select"
          aria-label="选择表格"
          value={selectedTableId ?? ""}
          onChange={(event) => selectTable(event.target.value as MemoryTableId)}
        >
          {tables.map((table) => (
            <option key={table.id} value={table.id}>
              {table.name}
            </option>
          ))}
        </select>
        <input
          type="search"
          className="stm-input stm-record-search"
          data-action="record-search"
          data-stm-field="record-search"
          placeholder="搜索记录…"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
        <button
          type="button"
          className="stm-button"
          data-action="add-grid-row"
          onClick={addGridRow}
        >
          + 新行
        </button>
        {dirty ? (
          <button
            type="button"
            className="stm-button"
            data-action="discard-grid"
            onClick={discardGrid}
          >
            放弃修改
          </button>
        ) : null}
        <button
          type="button"
          className="stm-button stm-button--primary"
          data-action="save-grid"
          disabled={savingGrid}
          onClick={() => void saveGrid()}
        >
          {savingGrid ? "保存中…" : "保存"}
        </button>
      </div>
      <div className="stm-record-table-meta">
        {currentTable.key} · {currentTable.name}
      </div>
      {detailRecordId ? (
        detailRecord ? (
          <RecordDetail
            record={detailRecord}
            displayText={detailDisplayText}
            fields={fields}
            history={history}
            onBack={() => setDetailRecordId(null)}
            onDelete={() => void deleteRecord()}
            onJumpFloor={(floor) => props.runtime.st.scrollToFloor(floor)}
            getMessageAt={(floor) => props.runtime.st.getMessageAt(floor)}
          />
        ) : (
          <Placeholder title="正在加载…" hint="记录详情读取中" />
        )
      ) : (
        <>
          {loadError ? <Placeholder title="记录加载失败" hint={loadError} /> : null}
          {!loadError && loading && gridRows.length === 0 ? (
            <Placeholder title="正在加载…" hint="记录读取中" />
          ) : null}
          {!loadError && !loading ? (
            <>
              {gridRows.length === 0 ? (
                <Placeholder
                  title="还没有记录"
                  hint={search.length > 0 ? "换个关键词试试" : "点击「+ 新行」写下第一条记忆"}
                />
              ) : null}
              <GridEditor
                fields={fields}
                rows={gridRows}
                errors={gridErrors}
                widths={widths}
                referenceRecords={referenceRecords}
                onValueChange={updateRowValue}
                onToggleArrayValue={toggleArrayRowValue}
                onOpenRecord={openRecord}
                onResizeRowNumber={resizeRowNumber}
                onResizeField={resizeField}
              />
              <div className="stm-pagination">
                <button
                  type="button"
                  className="stm-page-button"
                  data-action="record-page-prev"
                  disabled={(recordPage?.page ?? 1) <= 1}
                  onClick={() => {
                    if (confirmDiscardIfDirty()) setPage((recordPage?.page ?? 1) - 1);
                  }}
                >
                  上一页
                </button>
                <span className="stm-pagination-info">
                  {recordPage && recordPage.totalPages > 0 ? recordPage.page : 0} /{" "}
                  {recordPage?.totalPages ?? 0}（共 {recordPage?.total ?? 0} 条）
                </span>
                <button
                  type="button"
                  className="stm-page-button"
                  data-action="record-page-next"
                  disabled={(recordPage?.page ?? 0) >= (recordPage?.totalPages ?? 0)}
                  onClick={() => {
                    if (confirmDiscardIfDirty()) setPage((recordPage?.page ?? 0) + 1);
                  }}
                >
                  下一页
                </button>
              </div>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

// ---- 记录详情（字段值 + 字段证据 + 来源/修订徽标） ----

function RecordDetail(props: {
  readonly record: MemoryRecord;
  readonly displayText: string;
  readonly fields: readonly MemoryField[];
  readonly history: readonly MemoryRecordHistory[];
  readonly onBack: () => void;
  readonly onDelete: () => void;
  readonly onJumpFloor: (floor: number) => FloorJumpOutcome;
  readonly getMessageAt: (floor: number) => StChatMessage | undefined;
}) {
  const revisionLine = revisionSummaryLine(props.history);
  const noEvidence = !recordHasEvidence(props.record.fieldEvidence);
  return (
    <div className="stm-record-detail">
      <div className="stm-record-detail-header">
        <button
          type="button"
          className="stm-table-action"
          data-action="back-to-records"
          onClick={props.onBack}
        >
          <i className="fa-solid fa-arrow-left" aria-hidden="true"></i> 返回
        </button>
        <div className="stm-record-detail-actions">
          <button
            type="button"
            className="stm-table-action stm-table-action--danger"
            data-action="delete-record"
            onClick={props.onDelete}
          >
            删除
          </button>
        </div>
      </div>
      <div className="stm-record-display-large">{props.displayText}</div>
      <div className="stm-record-meta">
        <span
          className={`stm-source-badge ${
            props.record.source.type === "manual"
              ? "stm-source-badge--manual"
              : "stm-source-badge--agent"
          }`}
        >
          {recordSourceLabel(props.record.source)}
        </span>
        <span className="stm-record-meta-time">
          更新于 {formatSyncTime(props.record.updatedAt)}
        </span>
      </div>
      {revisionLine ? <div className="stm-record-revision">{revisionLine}</div> : null}
      {noEvidence ? (
        <div className="stm-no-evidence">
          {props.record.source.type === "manual" ? "无证据（手动记录）" : "无证据"}
        </div>
      ) : null}
      <ul className="stm-record-fields">
        {props.fields.map((field) => {
          const value = props.record.payload[field.id];
          const chips = evidenceChipViewModels(props.record.fieldEvidence[field.id] ?? []);
          return (
            <li key={field.id} className="stm-record-field">
              <div className="stm-record-field-head">
                <span className="stm-record-field-name">
                  {field.name}
                  {field.required ? (
                    <span className="stm-field-required" title="必填">
                      *
                    </span>
                  ) : null}
                </span>
                {!field.enabled ? <span className="stm-field-disabled">已停用</span> : null}
              </div>
              <div className="stm-record-field-value">{recordFieldValueText(field, value)}</div>
              {chips.length > 0 ? (
                <div className="stm-evidence-row">
                  {chips.map((chip, index) =>
                    chip.kind === "floor" ? (
                      <FloorChip
                        key={index}
                        floor={chip.floor}
                        onJump={props.onJumpFloor}
                        getMessageAt={props.getMessageAt}
                      />
                    ) : (
                      <span
                        key={index}
                        className="stm-evidence-chip stm-evidence-chip--generic"
                        title={chip.sourceType}
                      >
                        {chip.sourceType}
                      </span>
                    ),
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---- 证据楼层 chip（签名元素）：铜绿 + 等宽 #N，点按跳转，悬停/长按浮出摘录 ----

function FloorChip(props: {
  readonly floor: number;
  readonly onJump: (floor: number) => FloorJumpOutcome;
  readonly getMessageAt: (floor: number) => StChatMessage | undefined;
}) {
  const [popover, setPopover] = useState<ChatMessageExcerpt | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function showExcerpt(): void {
    const message = props.getMessageAt(props.floor);
    setPopover(message ? buildMessageExcerpt(message) : null);
  }

  function clearExcerpt(): void {
    if (longPressTimer.current !== undefined) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = undefined;
    }
    setPopover(null);
  }

  return (
    <span className="stm-evidence-chip-wrap">
      <button
        type="button"
        className="stm-evidence-chip stm-evidence-chip--floor"
        data-action="evidence-floor-jump"
        data-floor={props.floor}
        aria-label={`跳转到消息楼层 ${props.floor}`}
        onClick={() => {
          const hint = floorJumpHint(props.onJump(props.floor));
          if (hint) reportWarning(hint);
        }}
        onPointerEnter={showExcerpt}
        onPointerLeave={clearExcerpt}
        onPointerDown={() => {
          longPressTimer.current = setTimeout(showExcerpt, 500);
        }}
        onPointerUp={() => {
          if (longPressTimer.current !== undefined) clearTimeout(longPressTimer.current);
          longPressTimer.current = undefined;
        }}
        onPointerCancel={clearExcerpt}
      >
        <span className="stm-evidence-chip-floor">#{props.floor}</span>
      </button>
      {popover ? (
        <div className="stm-evidence-popover" role="tooltip">
          <div className="stm-evidence-popover-head">
            <span className="stm-evidence-popover-floor">楼层 #{popover.floor}</span>
            <span className="stm-evidence-popover-name">
              {popover.isUser ? "用户" : popover.name || "角色"}
            </span>
          </div>
          <div className="stm-evidence-popover-content">{popover.content}</div>
        </div>
      ) : null}
    </span>
  );
}

