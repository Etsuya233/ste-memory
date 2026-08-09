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
import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { FIELD_TYPE_LABELS } from "./table-list-model.ts";
import {
  buildRecordRowViewModels,
  recordSourceLabel,
  revisionSummaryLine,
  type RecordRowViewModel,
} from "./record-list-model.ts";
import {
  emptyRecordFormDraft,
  joinListText,
  recordFormDraftFromPayload,
  recordFormPatchFromDraft,
  recordPayloadFromDraft,
  recordValueFieldKey,
  recordFieldValueText,
  validateRecordFormDraft,
  type RecordFormDraft,
  type RecordFormValue,
} from "./record-form-model.ts";
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

/** 表单值展示文本（停用字段只读行用；展示逻辑在 seam，见 formDisplayValueText） */
const formValueText = formDisplayValueText;

import { formDisplayValueText } from "./record-form-model.ts";

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
  const [displayTexts, setDisplayTexts] = useState<ReadonlyMap<MemoryRecordId, string>>(new Map());
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
  // 编辑器
  const [editor, setEditor] = useState<
    | { readonly mode: "create" }
    | { readonly mode: "edit"; readonly recordId: MemoryRecordId }
    | null
  >(null);
  // 引用字段的目标表记录（单选/多选引用下拉与勾选组的数据源）
  const [referenceRecords, setReferenceRecords] = useState<
    ReadonlyMap<MemoryTableId, readonly MemoryRecord[]>
  >(new Map());

  const active = activeStatus(props.status);
  const spaceId = active?.space.id;

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

  // 搜索防抖：输入停顿 300ms 后生效并回到第一页
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // 记录分页 + 字段：显示文本读时计算（core 规则）
  useEffect(() => {
    if (!spaceId || !selectedTableId) {
      setRecordPage(undefined);
      setFields([]);
      setDisplayTexts(new Map());
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
        const table = tables?.find((item) => item.id === selectedTableId);
        if (table?.displayStrategy && pageData) {
          const entries = await Promise.all(
            pageData.records.map(async (record) => {
              try {
                const text = await props.runtime.records.previewDisplayText(
                  spaceId,
                  selectedTableId,
                  table.displayStrategy!,
                  record.payload,
                );
                return [record.id, text] as const;
              } catch {
                // 畸形策略/孤儿值等：降级存储 displayText，不阻断列表
                return [record.id, record.displayText] as const;
              }
            }),
          );
          if (cancelled) return;
          setDisplayTexts(new Map(entries));
        } else {
          setDisplayTexts(new Map());
        }
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
  }, [props.runtime, spaceId, selectedTableId, page, search, reloadKey, props.dataVersion, tables]);

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

  function selectTable(tableId: MemoryTableId): void {
    setSelectedTableId(tableId);
    setPage(1);
    setSearchInput("");
    setSearch("");
    setDetailRecordId(null);
    setEditor(null);
  }

  function openRecord(recordId: MemoryRecordId): void {
    setEditor(null);
    setDetailRecordId(recordId);
  }

  async function createRecord(draft: RecordFormDraft): Promise<void> {
    if (!selectedTableId) return;
    const payload = recordPayloadFromDraft(fields, draft);
    await props.runtime.records.create(currentSpaceId, selectedTableId, {
      payload,
      source: { type: "manual" },
    });
    reportSuccess("记录已创建");
    setEditor(null);
    setPage(1);
    setReloadKey((key) => key + 1);
  }

  async function saveRecordEdit(draft: RecordFormDraft): Promise<void> {
    if (!selectedTableId || !detailRecord || !detailRecordId) return;
    const { patch, changed } = recordFormPatchFromDraft(fields, detailRecord, draft);
    if (!changed) {
      reportWarning("没有修改任何字段");
      setEditor(null);
      return;
    }
    await props.runtime.records.update(currentSpaceId, selectedTableId, detailRecordId, {
      expectedRevisionId: detailRecord.revisionId,
      patch,
      revisionSource: "user",
    });
    reportSuccess("记录已更新");
    setEditor(null);
    setReloadKey((key) => key + 1);
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
      setReloadKey((key) => key + 1);
    } catch (error) {
      reportError(error);
    }
  }

  const rows: readonly RecordRowViewModel[] = buildRecordRowViewModels(
    recordPage?.records ?? [],
    displayTexts,
  );

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
          className="stm-button stm-button--primary"
          data-action="create-record"
          onClick={() => setEditor({ mode: "create" })}
        >
          新建记录
        </button>
      </div>
      <div className="stm-record-table-meta">
        {currentTable.key} · {currentTable.name}
      </div>
      {editor ? (
        <RecordForm
          key={editor.mode === "edit" ? `edit-${editor.recordId}` : "create"}
          fields={fields}
          referenceRecords={referenceRecords}
          initial={
            editor.mode === "edit" && detailRecord
              ? recordFormDraftFromPayload(fields, detailRecord.payload)
              : emptyRecordFormDraft(fields)
          }
          submitLabel={editor.mode === "create" ? "创建记录" : "保存修改"}
          onSave={editor.mode === "create" ? createRecord : saveRecordEdit}
          onCancel={() => setEditor(null)}
        />
      ) : detailRecordId ? (
        detailRecord ? (
          <RecordDetail
            record={detailRecord}
            displayText={detailDisplayText}
            fields={fields}
            history={history}
            onBack={() => setDetailRecordId(null)}
            onEdit={() => setEditor({ mode: "edit", recordId: detailRecord.id })}
            onDelete={() => void deleteRecord()}
            onJumpFloor={(floor) => props.runtime.st.scrollToFloor(floor)}
            getMessageAt={(floor) => props.runtime.st.getMessageAt(floor)}
          />
        ) : (
          <Placeholder title="正在加载…" hint="记录详情读取中" />
        )
      ) : (
        <RecordList
          rows={rows}
          loading={loading}
          page={recordPage?.page ?? 1}
          totalPages={recordPage?.totalPages ?? 0}
          total={recordPage?.total ?? 0}
          searching={search.length > 0}
          loadError={loadError}
          onOpen={openRecord}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}

// ---- 记录列表 ----

function RecordList(props: {
  readonly rows: readonly RecordRowViewModel[];
  readonly loading: boolean;
  readonly page: number;
  readonly totalPages: number;
  readonly total: number;
  readonly searching: boolean;
  readonly loadError: string | null;
  readonly onOpen: (recordId: MemoryRecordId) => void;
  readonly onPageChange: (page: number) => void;
}) {
  if (props.loadError) {
    return <Placeholder title="记录加载失败" hint={props.loadError} />;
  }
  if (props.loading && props.rows.length === 0) {
    return <Placeholder title="正在加载…" hint="记录读取中" />;
  }
  if (props.rows.length === 0) {
    return (
      <Placeholder
        title="还没有记录"
        hint={props.searching ? "换个关键词试试" : "点击「新建记录」写下第一条记忆"}
      />
    );
  }
  return (
    <>
      <ul className="stm-record-list">
        {props.rows.map((row) => (
          <li key={row.id} className="stm-record-row">
            <button
              type="button"
              className="stm-record-display"
              data-action="open-record"
              data-record-id={row.id}
              onClick={() => props.onOpen(row.id)}
            >
              {row.displayText}
            </button>
            <span
              className={`stm-source-badge ${
                row.sourceLabel === "手动" ? "stm-source-badge--manual" : "stm-source-badge--agent"
              }`}
            >
              {row.sourceLabel}
            </span>
          </li>
        ))}
      </ul>
      <div className="stm-pagination">
        <button
          type="button"
          className="stm-page-button"
          data-action="record-page-prev"
          disabled={props.page <= 1}
          onClick={() => props.onPageChange(props.page - 1)}
        >
          上一页
        </button>
        <span className="stm-pagination-info">
          {props.totalPages === 0 ? 0 : props.page} / {props.totalPages}（共 {props.total} 条）
        </span>
        <button
          type="button"
          className="stm-page-button"
          data-action="record-page-next"
          disabled={props.page >= props.totalPages}
          onClick={() => props.onPageChange(props.page + 1)}
        >
          下一页
        </button>
      </div>
    </>
  );
}

// ---- 记录详情（字段值 + 字段证据 + 来源/修订徽标） ----

function RecordDetail(props: {
  readonly record: MemoryRecord;
  readonly displayText: string;
  readonly fields: readonly MemoryField[];
  readonly history: readonly MemoryRecordHistory[];
  readonly onBack: () => void;
  readonly onEdit: () => void;
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
            className="stm-table-action"
            data-action="edit-record"
            onClick={props.onEdit}
          >
            编辑
          </button>
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

// ---- 记录创建/编辑表单 ----

function RecordForm(props: {
  readonly fields: readonly MemoryField[];
  readonly referenceRecords: ReadonlyMap<MemoryTableId, readonly MemoryRecord[]>;
  readonly initial: RecordFormDraft;
  readonly submitLabel: string;
  readonly onSave: (draft: RecordFormDraft) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState<RecordFormDraft>(props.initial);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [saving, setSaving] = useState(false);

  function updateValue(fieldId: string, value: RecordFormValue): void {
    setDraft((prev) => ({ values: { ...prev.values, [fieldId]: value } }));
  }

  function toggleArrayValue(fieldId: string, item: string): void {
    setDraft((prev) => {
      const current = Array.isArray(prev.values[fieldId])
        ? [...(prev.values[fieldId] as readonly string[])]
        : [];
      const next = current.includes(item)
        ? current.filter((value) => value !== item)
        : [...current, item];
      return { values: { ...prev.values, [fieldId]: next } };
    });
  }

  async function submit(): Promise<void> {
    const nextErrors = validateRecordFormDraft(props.fields, draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSaving(true);
    try {
      await props.onSave(draft);
    } catch (error) {
      reportError(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stm-record-form">
      <div className="stm-record-form-title">{props.submitLabel}</div>
      <ul className="stm-record-form-fields">
        {props.fields.map((field) => (
          <li key={field.id} className="stm-form-field">
            <div className="stm-form-field-label">
              <span className="stm-form-field-name">
                {field.name}
                {field.required ? (
                  <span className="stm-field-required" title="必填">
                    *
                  </span>
                ) : null}
              </span>
              <span className="stm-form-field-type">{FIELD_TYPE_LABELS[field.type]}</span>
              {!field.enabled ? <span className="stm-field-disabled">已停用</span> : null}
            </div>
            {field.enabled ? (
              renderFieldInput(field, draft, props.referenceRecords, updateValue, toggleArrayValue)
            ) : (
              <div className="stm-form-field-readonly">
                {formValueText(draft.values[field.id])}（停用字段，编辑时保留原值）
              </div>
            )}
            {errors[field.id] ? <div className="stm-form-error">{errors[field.id]}</div> : null}
          </li>
        ))}
      </ul>
      <div className="stm-form-actions">
        <button
          type="button"
          className="stm-button stm-button--primary"
          data-action="save-record"
          disabled={saving}
          onClick={() => void submit()}
        >
          {props.submitLabel}
        </button>
        <button
          type="button"
          className="stm-button"
          data-action="cancel-record-edit"
          onClick={props.onCancel}
        >
          取消
        </button>
      </div>
    </div>
  );
}

function renderFieldInput(
  field: MemoryField,
  draft: RecordFormDraft,
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
          rows={3}
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
