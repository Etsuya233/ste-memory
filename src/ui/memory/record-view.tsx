import { PageChrome } from "../shell/page-layout.tsx";
import { Disclosure } from "../shell/disclosure.tsx";
/**
 * 记录视图（ticket 11）：按表查看/搜索/分页的记录列表、记录详情（字段值 + 字段证据
 * 楼层 chip）、手动创建/编辑/删除。纯逻辑 seam（record-list-model / record-form-model
 * / evidence-chip-model，有测试兜底）之外，组件只做「状态 → DOM」投影与事件接线。
 *
 * 显示文本按「读时计算」（协调者决策，ticket 10 Comments）：列表行与详情主文案用
 * Memory previewDisplayText(表当前策略, record.payload) 现算，策略为 null 或计算失败
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
} from "../../features/memory/index.ts";
import { useEffect, useId, useRef, useState } from "react";
import type { PluginSettings } from "../../features/settings/plugin-settings.ts";
import type { SpaceContextStatus } from "../../features/chat-binding/chat-space-manager.ts";
import type { StChatMessage } from "../../infrastructure/sillytavern/chat-adapter.ts";
import type { PanelRuntime } from "../shell/panel-shell.tsx";
import { PanelBar, PanelBarAction, PanelBottomBar } from "../shell/panel-bar.tsx";
import {
  activeStatus,
  Placeholder,
  reportError,
  reportSuccess,
  reportWarning,
} from "../shell/ui-helpers.tsx";
import { formatDisplayTime } from "../shell/space-info.ts";
import { recordSourceLabel } from "./record-list-model.ts";
import {
  recordFieldValueText,
  recordFormDraftFromPayload,
  emptyRecordFormDraft,
  recordFormPatchFromDraft,
  recordPayloadFromDraft,
  validateRecordFormDraft,
  type RecordFormDraft,
  type RecordFormValue,
} from "./record-form-model.ts";
import { GridEditor, renderFieldInput } from "./grid-editor.tsx";
import { VectorRecordStatus } from "./vector-record-status.tsx";
import type { VectorIndexService } from "../../features/vector-index/vector-index-service.ts";
import type { MemorySpaceId } from "../../features/memory/index.ts";
import {
  clampGridRowHeight,
  clampGridWidth,
  defaultGridColumnWidths,
  emptyGridRow,
  GRID_FIELD_MIN_WIDTH,
  GRID_ROW_NUMBER_MIN_WIDTH,
  gridRowIsDirty,
  gridRowsFromRecords,
  hasUnsavedGridChanges,
  loadGridColumnWidths,
  loadGridRowHeights,
  planGridSave,
  saveGridColumnWidths,
  saveGridRowHeights,
  validateGridRows,
  buildReferenceLabelMap,
  type GridColumnWidths,
  type GridRowErrors,
  type GridRowHeights,
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

/** 列表页大小（记录分页，Memory list 上限 100 内） */
const RECORD_PAGE_SIZE = 10;

/** 离开记录 Tab 前的未保存修改确认（可取消的守卫，返回 true = 可以离开） */
export type LeaveGuard = () => boolean;

// ---- 记录列表 Tab ----

export function RecordsTab(props: {
  readonly onFocusConsumed?: () => void;
  readonly focusRecord?: { tableId: MemoryTableId; recordId: MemoryRecordId } | null;
  readonly runtime: PanelRuntime;
  readonly status: SpaceContextStatus | undefined;
  readonly settings: PluginSettings;
  /** 整库数据版本（导入备份后自增，驱动重取） */
  readonly dataVersion: number;
  /** 注册离开守卫（切 Tab / 关面板时由面板先询问；卸载时注销） */
  readonly registerLeaveGuard?: (guard: LeaveGuard | null) => void;
}) {
  useEffect(() => {
    props.onFocusConsumed?.();
  }, []);
  const [tables, setTables] = useState<readonly MemoryTable[] | undefined>(undefined);
  const [selectedTableId, setSelectedTableId] = useState<MemoryTableId | null>(
    props.focusRecord?.tableId ?? null,
  );
  const [fields, setFields] = useState<readonly MemoryField[]>([]);
  const [recordPage, setRecordPage] = useState<MemoryRecordPage | undefined>(undefined);
  const [vectorSummaries, setVectorSummaries] = useState<ReadonlyMap<MemoryRecordId, string>>(
    new Map(),
  );
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // 详情
  const [detailRecordId, setDetailRecordId] = useState<MemoryRecordId | null>(
    props.focusRecord?.recordId ?? null,
  );
  const [detailRecord, setDetailRecord] = useState<MemoryRecord | undefined>(undefined);
  const [detailDisplayText, setDetailDisplayText] = useState<string>("");
  const [history, setHistory] = useState<readonly MemoryRecordHistory[]>([]);
  // 网格（表格填写视图）：行草稿 + 单元格校验错误 + 列宽（按表持久化，见 model）
  const [gridRows, setGridRows] = useState<readonly GridRowState[]>([]);
  const [gridErrors, setGridErrors] = useState<GridRowErrors>({});
  const [commitErrors, setCommitErrors] = useState<Readonly<Record<string, string>>>({});
  const [widths, setWidths] = useState<GridColumnWidths>(() => defaultGridColumnWidths([]));
  const [heights, setHeights] = useState<GridRowHeights>({});
  const [savingGrid, setSavingGrid] = useState(false);
  // 查看/编辑模式（ticket 21）：当前编辑行 + 进入时自动聚焦的字段 + 保存中的行
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [focusFieldId, setFocusFieldId] = useState<string | null>(null);
  const [savingRows, setSavingRows] = useState<readonly string[]>([]);
  // 窄屏式选择器：搜索框默认折叠在右侧，点击展开
  const [searchOpen, setSearchOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [editor, setEditor] = useState<{
    original: MemoryRecord | null;
    draft: RecordFormDraft;
  } | null>(null);
  const [formErrors, setFormErrors] = useState<Readonly<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [savingRecord, setSavingRecord] = useState(false);
  const [deletingRecord, setDeletingRecord] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const editorFormId = useId();
  const listScrollTop = useRef(0);
  const showingRecord = editor !== null || detailRecordId !== null;
  useEffect(() => {
    // PageChrome replaces the header in a layout effect. Restore after that commit so
    // the previous viewport height cannot clamp the saved list scroll position.
    const body = viewRef.current?.closest(".stm-panel-body");
    if (!body) return;
    const frame = requestAnimationFrame(() => {
      body.scrollTop = showingRecord ? 0 : listScrollTop.current;
    });
    return () => cancelAnimationFrame(frame);
  }, [showingRecord]);
  const editorStateRef = useRef({ editor, fields, savingRecord, savingGrid, deletingRecord });
  editorStateRef.current = { editor, fields, savingRecord, savingGrid, deletingRecord };
  const newRowCounter = useRef(0);
  // 引用字段的目标表记录（单选/多选引用下拉与勾选组的数据源）
  const [referenceRecords, setReferenceRecords] = useState<
    ReadonlyMap<MemoryTableId, readonly MemoryRecord[]>
  >(new Map());

  const active = activeStatus(props.status);
  const spaceId = active?.space.id;
  const dataScopeRef = useRef({ spaceId, dataVersion: props.dataVersion });
  dataScopeRef.current = { spaceId, dataVersion: props.dataVersion };
  const previousSpaceId = useRef(spaceId);
  useEffect(() => {
    if (previousSpaceId.current === spaceId) return;
    previousSpaceId.current = spaceId;
    setEditor(null);
    setTables(undefined);
    setSelectedTableId(null);
    setFields([]);
    setRecordPage(undefined);
    setDetailRecordId(null);
    setDetailRecord(undefined);
    setSearchInput("");
    setSearch("");
    setPage(1);
  }, [spaceId]);

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
      if (searchInput.trim() === search) return;
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

  // 引用字段目标表记录（表单选项；失败不阻塞，Memory 引用校验兜底）
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
        // 引用选项加载失败：表单仍可提交，Memory validateMemoryRecordReferences 兜底
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
    setCommitErrors({});
  }, [fields, recordPage]);

  // 编辑中的行被重建移除（保存成功/切页后）→ 退出编辑模式
  useEffect(() => {
    if (editingKey && !gridRows.some((row) => row.key === editingKey)) setEditingKey(null);
  }, [gridRows, editingKey]);

  // 列宽：切表/字段变化时从持久化读取；宽度变化写回（拖拽调宽即时生效，按表记住）
  useEffect(() => {
    if (!selectedTableId) return;
    setWidths(loadGridColumnWidths(fields, selectedTableId));
  }, [spaceId, selectedTableId, fields]);
  useEffect(() => {
    if (!selectedTableId) return;
    saveGridColumnWidths(selectedTableId, widths);
  }, [widths, selectedTableId]);

  // 行高：切表/记录页变化时从持久化读取；变化写回（只持久化已有记录的 recordId 键）
  useEffect(() => {
    if (!selectedTableId) return;
    setHeights(loadGridRowHeights(recordPage?.records ?? [], selectedTableId));
  }, [spaceId, selectedTableId, recordPage]);
  useEffect(() => {
    if (!selectedTableId) return;
    const recordIds = new Set((recordPage?.records ?? []).map((record) => record.id));
    const persisted: Record<string, number> = {};
    for (const [key, value] of Object.entries(heights)) {
      if (recordIds.has(key as MemoryRecordId)) persisted[key] = value;
    }
    saveGridRowHeights(selectedTableId, persisted);
  }, [heights, selectedTableId, recordPage]);

  // 离开守卫（切 Tab / 关面板）：有未保存修改时先确认，拒绝则留在原地
  useEffect(() => {
    const register = props.registerLeaveGuard;
    register?.(confirmDiscardIfDirty);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedRecordChanges()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      register?.(null);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [props.registerLeaveGuard]);

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

  useEffect(() => {
    if (!spaceId || !selectedTableId || !recordPage) {
      setVectorSummaries(new Map());
      return;
    }
    let cancelled = false;
    void Promise.all(
      recordPage.records.map(async (record) => {
        const scope = { memorySpaceId: spaceId, tableId: selectedTableId, recordId: record.id };
        const [previews, state] = await Promise.all([
          props.runtime.vector.preview(scope),
          props.runtime.vector.getStatus(scope),
        ]);
        if (previews.length === 0) return [record.id, ""] as const;
        const ready = previews.filter((preview) =>
          state.vectors.some(
            (vector) =>
              vector.groupId === preview.groupId && vector.fingerprint === preview.fingerprint,
          ),
        ).length;
        const empty = previews.filter((preview) => preview.status === "empty").length;
        const failed = previews.filter(
          (preview) =>
            preview.status === "too_long" ||
            preview.status === "unavailable" ||
            state.tasks.some(
              (task) =>
                task.groupId === preview.groupId &&
                task.status === "failed" &&
                task.fingerprint === preview.fingerprint,
            ),
        ).length;
        return [
          record.id,
          `就绪 ${ready}/${previews.length}${empty ? ` · 空 ${empty}` : ""}${failed ? ` · 异常 ${failed}` : ""}`,
        ] as const;
      }),
    )
      .then((rows) => {
        if (!cancelled) setVectorSummaries(new Map(rows));
      })
      .catch((error) => {
        if (!cancelled) reportError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [props.runtime, spaceId, selectedTableId, recordPage, reloadKey]);

  if (!props.settings.enabled) {
    return <Placeholder title="插件已停用" hint="在设置中重新启用后恢复记录展示" />;
  }
  if (!active) {
    return (
      <Placeholder
        title={
          props.status && props.status.kind !== "active" && props.status.kind !== "branch-detected"
            ? props.status.humanMsg
            : "正在加载…"
        }
        hint="切换到已保存的对话后自动恢复"
      />
    );
  }
  const currentSpaceId = active.space.id;
  const referenceLabels = buildReferenceLabelMap(referenceRecords);
  if (tables === undefined) {
    return (
      <div className="stm-empty" role="status">
        正在加载…
      </div>
    );
  }
  if (tables.length === 0) {
    return <Placeholder title="还没有表格" hint="先在「表格」页创建自定义表格与字段" />;
  }
  const currentTable = tables.find((table) => table.id === selectedTableId) ?? tables[0]!;

  // 是否存在未保存改动（驱动「放弃修改」按钮显示）与脏行集合（背景色标记）
  const originals = new Map((recordPage?.records ?? []).map((record) => [record.id, record]));
  const dirty = hasUnsavedGridChanges(fields, gridRows, originals);
  const dirtyRowKeys = new Set(
    gridRows.filter((row) => gridRowIsDirty(fields, row, originals)).map((row) => row.key),
  );
  // 详情中的记录在网格里有未保存草稿 → 页头小标记
  const detailDirty =
    detailRecordId !== null &&
    gridRows.some(
      (row) => row.recordId === detailRecordId && gridRowIsDirty(fields, row, originals),
    );
  const formChanged =
    editor !== null &&
    (editor.original === null ||
      recordFormPatchFromDraft(fields, editor.original, editor.draft).changed);

  /** 当前是否有未保存改动（读 ref 最新状态；离开守卫与导航确认共用） */
  function hasUnsavedRecordChanges(): boolean {
    if (
      editorStateRef.current.savingRecord ||
      editorStateRef.current.savingGrid ||
      editorStateRef.current.deletingRecord
    )
      return true;
    const { fields: currentFields, gridRows: rows, recordPage: page } = gridStateRef.current;
    const originals = new Map((page?.records ?? []).map((record) => [record.id, record]));
    const { editor: currentEditor } = editorStateRef.current;
    const formDirty =
      currentEditor !== null &&
      (currentEditor.original
        ? recordFormPatchFromDraft(currentFields, currentEditor.original, currentEditor.draft)
            .changed
        : JSON.stringify(currentEditor.draft) !==
          JSON.stringify(emptyRecordFormDraft(currentFields)));
    return hasUnsavedGridChanges(currentFields, rows, originals) || formDirty;
  }

  /** 有未保存修改时先确认放弃（返回是否可继续） */
  function confirmDiscardIfDirty(): boolean {
    if (
      editorStateRef.current.savingRecord ||
      editorStateRef.current.savingGrid ||
      editorStateRef.current.deletingRecord
    )
      return false;
    if (!hasUnsavedRecordChanges()) return true;
    return window.confirm("有未保存的记录修改，放弃这些修改吗？");
  }

  function selectTable(tableId: MemoryTableId): void {
    if (tableId === selectedTableId) return;
    if (!confirmDiscardIfDirty()) return;
    setSelectedTableId(tableId);
    setEditor(null);
    setPage(1);
    setSearchInput("");
    setSearch("");
    setDetailRecordId(null);
    setEditingKey(null);
    setSearchOpen(false);
  }

  function openRecord(recordId: MemoryRecordId): void {
    listScrollTop.current = viewRef.current!.closest(".stm-panel-body")!.scrollTop;
    setDetailRecord(undefined);
    setDetailRecordId(recordId);
  }

  function openEditor(original: MemoryRecord | null): void {
    if (!confirmDiscardIfDirty()) return;
    if (detailRecordId === null) {
      listScrollTop.current = viewRef.current!.closest(".stm-panel-body")!.scrollTop;
    }
    discardGrid();
    setFormErrors({});
    setFormError(null);
    setEditor({
      original,
      draft: original
        ? recordFormDraftFromPayload(fields, original.payload)
        : emptyRecordFormDraft(fields),
    });
  }

  async function saveRecord(): Promise<void> {
    if (!editor || !selectedTableId) return;
    const saveScope = dataScopeRef.current;
    const errors = validateRecordFormDraft(fields, editor.draft);
    setFormErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) return;
    setSavingRecord(true);
    try {
      const record = editor.original
        ? await props.runtime.records.update(currentSpaceId, selectedTableId, editor.original.id, {
            expectedRevisionId: editor.original.revisionId,
            patch: recordFormPatchFromDraft(fields, editor.original, editor.draft).patch,
            revisionSource: "user",
          })
        : await props.runtime.records.create(currentSpaceId, selectedTableId, {
            payload: recordPayloadFromDraft(fields, editor.draft),
            source: { type: "manual" },
          });
      if (!record) throw new Error("记录已不存在，请重新打开表格");
      if (
        dataScopeRef.current.spaceId !== saveScope.spaceId ||
        dataScopeRef.current.dataVersion !== saveScope.dataVersion
      )
        return;
      setEditor(null);
      setDetailRecord(record);
      setDetailRecordId(record.id);
      reportSuccess("记录已保存");
      bumpData();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingRecord(false);
    }
  }

  function addGridRow(): void {
    newRowCounter.current += 1;
    const key = `new-${newRowCounter.current}`;
    setGridRows((prev) => [...prev, emptyGridRow(fields, key)]);
    // 新行以编辑模式进入（可立即输入）
    setEditingKey(key);
    setFocusFieldId(null);
  }

  function discardGrid(): void {
    setGridRows(gridRowsFromRecords(fields, recordPage?.records ?? []));
    setGridErrors({});
    setCommitErrors({});
    setEditingKey(null);
  }

  /** Esc：撤销单行改动并退出编辑模式（新行 = 删除草稿行） */
  function revertRow(rowKey: string): void {
    setEditingKey(null);
    setFocusFieldId(null);
    setGridRows((prev) => {
      const target = prev.find((row) => row.key === rowKey);
      if (!target) return prev;
      if (target.recordId === null) return prev.filter((row) => row.key !== rowKey);
      const original = originals.get(target.recordId);
      if (!original) return prev;
      return prev.map((row) =>
        row.key === rowKey
          ? {
              key: rowKey,
              recordId: original.id,
              draft: recordFormDraftFromPayload(fields, original.payload),
            }
          : row,
      );
    });
    clearRowError(rowKey);
  }

  function clearRowError(rowKey: string): void {
    setGridErrors((prev) => {
      if (prev[rowKey] === undefined) return prev;
      const next = { ...prev };
      delete next[rowKey];
      return next;
    });
    setCommitErrors((prev) => {
      if (prev[rowKey] === undefined) return prev;
      const next = { ...prev };
      delete next[rowKey];
      return next;
    });
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
    // 行底错误条是「上次保存失败的判决」，编辑过程不闪断（下次保存重新校验）
  }

  function editRow(rowKey: string | null, fieldId?: string): void {
    setEditingKey(rowKey);
    setFocusFieldId(rowKey === null ? null : (fieldId ?? null));
  }

  async function saveGrid(): Promise<void> {
    if (!spaceId || !selectedTableId) return;
    const saveScope = dataScopeRef.current;
    const originals = new Map((recordPage?.records ?? []).map((record) => [record.id, record]));
    const nextErrors = validateGridRows(fields, gridRows);
    setGridErrors(nextErrors);
    setCommitErrors({});
    // 只提交通过校验的行（校验失败行保留草稿 + 行底错误条，不进保存计划）
    const validRows = gridRows.filter((row) => nextErrors[row.key] === undefined);
    const plan = planGridSave(fields, validRows, originals);
    const plannedKeys = [
      ...plan.creates.map((item) => item.rowKey),
      ...plan.updates.map((item) => item.rowKey),
    ];
    if (plannedKeys.length === 0) {
      if (Object.keys(nextErrors).length > 0) {
        reportWarning(`有 ${Object.keys(nextErrors).length} 条记录未通过校验`);
      } else {
        reportWarning("没有修改任何字段");
      }
      return;
    }
    setSavingGrid(true);
    setSavingRows(plannedKeys);
    const failures: Record<string, string> = {};
    const committed: MemoryRecord[] = [];
    const createdByRowKey = new Map<string, MemoryRecord>();
    const updatedByRecordId = new Map<MemoryRecordId, MemoryRecord>();
    try {
      // 逐行提交、失败不阻断（错误就地显示在行底错误条）
      for (const item of plan.creates) {
        try {
          const record = await props.runtime.records.create(spaceId, selectedTableId, {
            payload: item.payload,
            source: { type: "manual" },
          });
          if (!record) {
            failures[item.rowKey] = "创建失败：表格或记录不可用";
            continue;
          }
          createdByRowKey.set(item.rowKey, record);
          committed.push(record);
        } catch (error) {
          failures[item.rowKey] = error instanceof Error ? error.message : String(error);
        }
      }
      for (const item of plan.updates) {
        try {
          const record = await props.runtime.records.update(
            spaceId,
            selectedTableId,
            item.recordId,
            {
              expectedRevisionId: item.expectedRevisionId,
              patch: item.patch,
              revisionSource: "user",
            },
          );
          if (!record) {
            failures[item.rowKey] = "更新失败：记录已不存在";
            continue;
          }
          updatedByRecordId.set(item.recordId, record);
          committed.push(record);
        } catch (error) {
          failures[item.rowKey] = error instanceof Error ? error.message : String(error);
        }
      }
    } finally {
      setSavingRows([]);
      setSavingGrid(false);
    }
    if (
      dataScopeRef.current.spaceId !== saveScope.spaceId ||
      dataScopeRef.current.dataVersion !== saveScope.dataVersion
    )
      return;
    const failedCount = Object.keys(failures).length + Object.keys(nextErrors).length;
    if (failedCount === 0) {
      reportSuccess(
        plan.creates.length > 0 && plan.updates.length > 0
          ? `已保存：新建 ${plan.creates.length} 条、更新 ${plan.updates.length} 条`
          : plan.creates.length > 0
            ? `已创建 ${plan.creates.length} 条记录`
            : `已更新 ${plan.updates.length} 条记录`,
      );
      bumpData();
      return;
    }
    // 部分失败：不整页刷新（bumpData 会重建行、丢掉失败行草稿）；就地更新成功行，
    // 失败行保留草稿 + 行底错误条；记忆宏照常重建（数据确实变了）
    setCommitErrors(failures);
    setGridRows((prev) =>
      prev.flatMap((row) => {
        const created = createdByRowKey.get(row.key);
        if (created) {
          return [
            {
              key: created.id,
              recordId: created.id,
              draft: recordFormDraftFromPayload(fields, created.payload),
            },
          ];
        }
        const updated = row.recordId !== null ? updatedByRecordId.get(row.recordId) : undefined;
        if (updated) {
          return [
            {
              key: row.key,
              recordId: updated.id,
              draft: recordFormDraftFromPayload(fields, updated.payload),
            },
          ];
        }
        return [row];
      }),
    );
    reportWarning(`已保存 ${committed.length} 条，失败 ${failedCount} 条`);
    void props.runtime.macro.kick().catch(reportError);
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

  function resizeRowHeight(rowKey: string, px: number): void {
    setHeights((prev) => ({ ...prev, [rowKey]: clampGridRowHeight(px) }));
  }

  async function deleteRecord(record: MemoryRecord): Promise<void> {
    if (!confirmDiscardIfDirty()) return;
    if (!window.confirm("确定删除这条记录吗？删除后不可恢复。")) return;
    const deleteScope = dataScopeRef.current;
    setDeletingRecord(true);
    try {
      await props.runtime.records.delete(
        currentSpaceId,
        record.tableId,
        record.id,
        record.revisionId,
        "user",
      );
      if (
        dataScopeRef.current.spaceId !== deleteScope.spaceId ||
        dataScopeRef.current.dataVersion !== deleteScope.dataVersion
      )
        return;
      reportSuccess("记录已删除");
      setEditor(null);
      setDetailRecordId(null);
      bumpData();
    } catch (error) {
      reportError(error);
    } finally {
      setDeletingRecord(false);
    }
  }

  return (
    <div
      className={`stm-record-view${showingRecord ? " stm-record-view--detail" : ""}`}
      ref={viewRef}
    >
      {detailRecordId && !editor ? (
        <PageChrome
          header={
            <PanelBar
              variant="record"
              title={currentTable.name}
              leading={
                <PanelBarAction
                  icon="fa-chevron-left"
                  label="返回记录"
                  data-action="back-to-records"
                  disabled={deletingRecord}
                  onClick={() => setDetailRecordId(null)}
                />
              }
              trailing={
                detailRecord ? (
                  <>
                    <PanelBarAction
                      icon="fa-trash-can"
                      label="删除记录"
                      danger
                      data-action="delete-record"
                      disabled={deletingRecord}
                      onClick={() => void deleteRecord(detailRecord)}
                    />
                    <PanelBarAction
                      icon="fa-pen"
                      label="编辑记录"
                      data-action="edit-record"
                      disabled={deletingRecord}
                      onClick={() => openEditor(detailRecord)}
                    />
                  </>
                ) : null
              }
            />
          }
        />
      ) : null}
      <div className="stm-record-toolbar" hidden={detailRecordId !== null || editor !== null}>
        <div className="stm-record-tables" role="tablist" aria-label="选择表格">
          {tables.map((table) => {
            const selected = table.id === selectedTableId;
            return (
              <button
                key={table.id}
                type="button"
                role="tab"
                className={`stm-record-chip${selected ? " stm-record-chip--active" : ""}${!table.enabled ? " stm-record-chip--disabled" : ""}`}
                data-action="select-table"
                data-table-id={table.id}
                aria-selected={selected}
                title={!table.enabled ? `${table.name}（已停用）` : table.name}
                onClick={() => selectTable(table.id)}
              >
                {table.name}
              </button>
            );
          })}
        </div>
        <div className="stm-record-selector-row">
          {searchOpen ? (
            <input
              type="search"
              className="stm-input stm-record-search"
              data-action="record-search"
              data-stm-field="record-search"
              aria-label="搜索记录"
              placeholder="搜索记录…"
              autoFocus
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setSearchOpen(false);
              }}
            />
          ) : (
            <div className="stm-record-table-meta">
              {recordPage?.total ?? 0} 条记录{search ? ` · “${search}”` : ""}
            </div>
          )}
          <div
            className="stm-bar-group stm-record-view-switch"
            role="group"
            aria-label="记录显示方式"
          >
            <button
              type="button"
              className="stm-bar-action"
              aria-label="列表"
              title="列表"
              aria-pressed={viewMode === "list"}
              data-action="records-list-view"
              onClick={() => {
                if (confirmDiscardIfDirty()) {
                  discardGrid();
                  setViewMode("list");
                }
              }}
            >
              <i className="fa-solid fa-list" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="stm-bar-action"
              aria-label="批量编辑"
              title="批量编辑"
              aria-pressed={viewMode === "grid"}
              data-action="records-grid-view"
              onClick={() => setViewMode("grid")}
            >
              <i className="fa-solid fa-table-cells" aria-hidden="true" />
            </button>
          </div>
          <div className="stm-bar-group">
            {searchOpen ? (
              <button
                type="button"
                className="stm-bar-action stm-record-search-toggle"
                aria-label="关闭搜索"
                title="关闭搜索"
                onClick={() => setSearchOpen(false)}
              >
                <i className="fa-solid fa-xmark" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="stm-bar-action stm-record-search-toggle"
                data-action="record-search-toggle"
                aria-label="搜索记录"
                title="搜索记录"
                onClick={() => setSearchOpen(true)}
              >
                <i className="fa-solid fa-magnifying-glass" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
        {viewMode === "grid" ? (
          <div className="stm-record-actions">
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
              disabled={savingGrid || !dirty}
              onClick={() => void saveGrid()}
            >
              {savingGrid ? "保存中…" : "保存修改"}
            </button>
          </div>
        ) : null}
      </div>
      {editor ? (
        <form
          id={editorFormId}
          className="stm-record-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveRecord();
          }}
        >
          <PageChrome
            header={
              <PanelBar
                variant="record"
                title={editor.original ? "编辑记录" : "新建记录"}
                leading={
                  <PanelBarAction
                    icon="fa-xmark"
                    label="取消"
                    data-action="cancel-record"
                    disabled={savingRecord || deletingRecord}
                    onClick={() => {
                      if (confirmDiscardIfDirty()) setEditor(null);
                    }}
                  />
                }
                trailing={
                  <>
                    {editor.original ? (
                      <PanelBarAction
                        icon="fa-trash-can"
                        label="删除记录"
                        danger
                        data-action="delete-record"
                        disabled={savingRecord || deletingRecord}
                        onClick={() => void deleteRecord(editor.original!)}
                      />
                    ) : null}
                    <PanelBarAction
                      icon={savingRecord ? "fa-spinner" : "fa-check"}
                      label={savingRecord ? "保存中…" : "保存"}
                      type="submit"
                      form={editorFormId}
                      emphasis
                      data-action="save-record"
                      disabled={savingRecord || deletingRecord || !formChanged}
                    />
                  </>
                }
              />
            }
          />
          <fieldset className="stm-record-form-fields" disabled={savingRecord || deletingRecord}>
            {fields.map((field) => (
              <div
                key={field.id}
                className="stm-record-form-field"
                role="group"
                aria-label={field.name}
              >
                <span className="stm-record-field-name">
                  {field.name}
                  {field.required ? <span className="stm-field-required"> *</span> : null}
                  {!field.enabled ? "（已停用）" : ""}
                </span>
                {field.enabled ? (
                  renderFieldInput(
                    field,
                    editor.draft,
                    referenceRecords,
                    (fieldId, value) =>
                      setEditor((current) =>
                        current
                          ? {
                              ...current,
                              draft: { values: { ...current.draft.values, [fieldId]: value } },
                            }
                          : current,
                      ),
                    false,
                  )
                ) : (
                  <span className="stm-record-field-value">
                    {recordFieldValueText(
                      field,
                      editor.original?.payload[field.id],
                      referenceLabels,
                    )}
                  </span>
                )}
                {formErrors[field.id] ? (
                  <span className="stm-grid-row-error" role="alert">
                    {formErrors[field.id]}
                  </span>
                ) : null}
              </div>
            ))}
          </fieldset>
          {formError ? (
            <p className="stm-grid-row-error" role="alert">
              {formError}
            </p>
          ) : null}
        </form>
      ) : detailRecordId ? (
        detailRecord ? (
          <RecordDetail
            record={detailRecord}
            displayText={detailDisplayText}
            fields={fields}
            history={history}
            referenceLabels={referenceLabels}
            unsavedDraft={detailDirty}
            onJumpFloor={(floor) => props.runtime.st.scrollToFloor(floor)}
            getMessageAt={(floor) => props.runtime.st.getMessageAt(floor)}
            vector={props.runtime.vector}
            memorySpaceId={currentSpaceId}
            tableId={currentTable.id}
          />
        ) : (
          <div className="stm-empty" role="status">
            正在加载…
          </div>
        )
      ) : null}
      <div className="stm-record-results" hidden={detailRecordId !== null || editor !== null}>
        {loadError ? <Placeholder title="记录加载失败" hint={loadError} /> : null}
        {!loadError && loading && gridRows.length === 0 ? (
          <div className="stm-empty" role="status">
            正在加载…
          </div>
        ) : null}
        {!loadError && !loading ? (
          <>
            {gridRows.length === 0 ? (
              <div className="stm-empty">
                <div className="stm-empty-title">{search ? "没有匹配记录" : "还没有记录"}</div>
                <button
                  type="button"
                  className="stm-button"
                  onClick={() => {
                    if (search) setSearchInput("");
                    else if (viewMode === "grid") addGridRow();
                    else openEditor(null);
                  }}
                >
                  {search ? "清除搜索" : "新建记录"}
                </button>
              </div>
            ) : null}
            {viewMode === "list" ? (
              <RecordSummaryList
                records={recordPage?.records ?? []}
                fields={fields}
                referenceLabels={referenceLabels}
                vectorSummaries={vectorSummaries}
                onOpenRecord={openRecord}
              />
            ) : (
              <GridEditor
                vectorSummaries={vectorSummaries}
                fields={fields}
                rows={gridRows}
                errors={gridErrors}
                commitErrors={commitErrors}
                widths={widths}
                heights={heights}
                editingKey={editingKey}
                focusFieldId={focusFieldId}
                dirtyRowKeys={dirtyRowKeys}
                savingRowKeys={new Set(savingRows)}
                referenceRecords={referenceRecords}
                onValueChange={updateRowValue}
                onOpenRecord={openRecord}
                onEditRow={editRow}
                onRevertRow={revertRow}
                onResizeRowNumber={resizeRowNumber}
                onResizeField={resizeField}
                onResizeRowHeight={resizeRowHeight}
              />
            )}
            {!showingRecord ? (
              <PageChrome
                footer={
                  <PanelBottomBar
                    label="记录分页"
                    trailing={
                      <PanelBarAction
                        icon="fa-plus"
                        label={viewMode === "grid" ? "新行" : "新建记录"}
                        emphasis
                        data-action="add-grid-row"
                        disabled={savingGrid}
                        onClick={() => (viewMode === "grid" ? addGridRow() : openEditor(null))}
                      />
                    }
                  >
                    <PanelBarAction
                      icon="fa-chevron-left"
                      label="上一页"
                      data-action="record-page-prev"
                      disabled={(recordPage?.page ?? 1) <= 1}
                      onClick={() => {
                        if (confirmDiscardIfDirty()) {
                          listScrollTop.current = 0;
                          viewRef.current!.closest(".stm-panel-body")!.scrollTop = 0;
                          setPage((recordPage?.page ?? 1) - 1);
                        }
                      }}
                    />
                    <span className="stm-pagination-info" aria-live="polite" aria-atomic="true">
                      {recordPage && recordPage.totalPages > 0 ? recordPage.page : 0} /{" "}
                      {recordPage?.totalPages ?? 0}
                    </span>
                    <PanelBarAction
                      icon="fa-chevron-right"
                      label="下一页"
                      data-action="record-page-next"
                      disabled={(recordPage?.page ?? 0) >= (recordPage?.totalPages ?? 0)}
                      onClick={() => {
                        if (confirmDiscardIfDirty()) {
                          listScrollTop.current = 0;
                          viewRef.current!.closest(".stm-panel-body")!.scrollTop = 0;
                          setPage((recordPage?.page ?? 0) + 1);
                        }
                      }}
                    />
                  </PanelBottomBar>
                }
              />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

export function RecordSummaryList(props: {
  readonly records: readonly MemoryRecord[];
  readonly fields: readonly MemoryField[];
  readonly referenceLabels: ReadonlyMap<string, string>;
  readonly vectorSummaries: ReadonlyMap<MemoryRecordId, string>;
  readonly onOpenRecord: (recordId: MemoryRecordId) => void;
}) {
  return (
    <div className="stm-record-summary-list" aria-label="记录列表">
      {props.records.map((record) => {
        const previewFields = props.fields
          .filter((field) => field.enabled)
          .map((field) => ({
            field,
            text: recordFieldValueText(field, record.payload[field.id], props.referenceLabels),
          }))
          .filter(({ text }) => text !== "—" && text.trim() !== record.displayText.trim())
          .slice(0, 2);
        const vectorSummary = props.vectorSummaries.get(record.id);
        return (
          <button
            type="button"
            key={record.id}
            className="stm-record-summary"
            data-action="open-record"
            data-record-id={record.id}
            onClick={() => props.onOpenRecord(record.id)}
          >
            <span className="stm-record-summary-title">{record.displayText}</span>
            {previewFields.length > 0 ? (
              <span className="stm-record-summary-values">
                {previewFields.map(({ field, text }, index) => (
                  <span key={field.id}>
                    {index > 0 ? " · " : ""}
                    {text}
                  </span>
                ))}
              </span>
            ) : null}
            {vectorSummary ? (
              <span className="stm-record-summary-status">{vectorSummary}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// ---- 记录详情（字段值 + 字段证据 + 来源/修订徽标） ----

function RecordDetail(props: {
  readonly vector: VectorIndexService;
  readonly memorySpaceId: MemorySpaceId;
  readonly tableId: MemoryTableId;
  readonly record: MemoryRecord;
  readonly displayText: string;
  readonly fields: readonly MemoryField[];
  readonly history: readonly MemoryRecordHistory[];
  /** 引用字段值标签（id → 目标记录显示文本）；缺省时引用字段回退显示原 id */
  readonly referenceLabels: ReadonlyMap<string, string>;
  /** 该记录在网格中有未保存草稿（详情显示的是已提交值） */
  readonly unsavedDraft: boolean;
  readonly onJumpFloor: (floor: number) => FloorJumpOutcome;
  readonly getMessageAt: (floor: number) => StChatMessage | undefined;
}) {
  const noEvidence = !recordHasEvidence(props.record.fieldEvidence);
  return (
    <div className="stm-record-detail">
      {props.unsavedDraft ? (
        <span
          className="stm-record-detail-unsaved"
          title="该记录在网格中有未保存的修改，详情显示的是已保存值"
        >
          有未保存修改
        </span>
      ) : null}
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
          更新于 {formatDisplayTime(props.record.updatedAt)}
        </span>
      </div>
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
              <div className="stm-record-field-value">
                {recordFieldValueText(field, value, props.referenceLabels)}
              </div>
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
      {props.history.length > 0 ? (
        <Disclosure
          className="stm-record-history"
          icon="fa-clock-rotate-left"
          title="修订历史"
          meta={props.history.length}
        >
          {props.history.map((entry) => (
            <div key={entry.id} className="stm-record-history-entry">
              <span className="stm-record-meta-time">
                {formatDisplayTime(entry.archivedAt)} ·{" "}
                {entry.revisionSource === "user" ? "手动修订" : "Agent 修订"}
              </span>
              {props.fields.map((field) => (
                <div key={field.id}>
                  <span className="stm-record-summary-label">{field.name}</span>
                  {recordFieldValueText(field, entry.payload[field.id], props.referenceLabels)}
                </div>
              ))}
            </div>
          ))}
        </Disclosure>
      ) : null}
      <VectorRecordStatus
        vector={props.vector}
        memorySpaceId={props.memorySpaceId}
        tableId={props.tableId}
        recordId={props.record.id}
      />
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
