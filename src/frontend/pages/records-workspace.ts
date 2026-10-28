import type {
  MemoryField,
  MemoryFieldId,
  MemoryFieldService,
  MemoryRecord,
  MemoryRecordHistory,
  MemoryRecordId,
  MemoryRecordPage,
  MemoryRecordService,
  MemoryRecordListOrder,
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
  MemoryTableService,
} from "../../features/memory/index.ts";
import { DEFAULT_RECORD_LIST_ORDER, MemoryRecordSaveError } from "../../features/memory/index.ts";
import {
  loadRecordSort,
  nextRecordSort,
  recordSortOptions,
  saveRecordSort,
} from "../../ui/memory/record-sort-model.ts";
import {
  emptyRecordFormDraft,
  recordFormDraftFromPayload,
  recordFormPatchFromDraft,
  recordPayloadFromDraft,
  validateRecordFormDraft,
  type RecordFormDraft,
  type RecordFormValue,
} from "../../ui/memory/record-form-model.ts";

export interface RecordsContext {
  readonly chatKey: string;
  readonly spaceId: MemorySpaceId;
  readonly title: string;
}

export interface RecordsServices {
  readonly sortStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly tables: Pick<MemoryTableService, "list">;
  readonly fields: Pick<MemoryFieldService, "list">;
  readonly records: Pick<
    MemoryRecordService,
    "list" | "find" | "listHistory" | "create" | "update"
  >;
  /** Read the live host context; throw if the submitted context is no longer active. */
  readonly assertContext: (context: RecordsContext) => void;
  readonly onSaved?: (context: RecordsContext) => Promise<void>;
}

export interface RecordsEditor {
  readonly original: MemoryRecord | null;
  readonly draft: RecordFormDraft;
  /** Keep the schema under which the draft was entered, including after a context switch. */
  readonly fields: readonly MemoryField[];
  readonly dirty: boolean;
  readonly errors: Readonly<Record<string, string>>;
  readonly error: string | null;
  readonly conflict: boolean;
}

export interface RecordsSnapshot {
  readonly context: RecordsContext | null;
  readonly tables: readonly MemoryTable[];
  readonly tableId: MemoryTableId | null;
  readonly fields: readonly MemoryField[];
  readonly page: number;
  readonly pageSize: number;
  readonly search: string;
  readonly viewMode: "list" | "table";
  readonly order: MemoryRecordListOrder;
  readonly records: MemoryRecordPage | null;
  readonly listLoading: boolean;
  readonly listError: string | null;
  readonly detail: MemoryRecord | null;
  readonly detailId: MemoryRecordId | null;
  readonly history: readonly MemoryRecordHistory[];
  readonly detailLoading: boolean;
  readonly detailError: string | null;
  readonly editor: RecordsEditor | null;
  readonly saving: boolean;
  readonly notice: string | null;
  readonly saveWarning: string | null;
  readonly persistenceError: string | null;
  readonly references: ReadonlyMap<MemoryTableId, readonly MemoryRecord[]>;
  readonly retainedDraftCount: number;
}

interface Session {
  state: RecordsSnapshot;
  listRequest: number;
  detailRequest: number;
  refreshRequest: number;
  saveRequest: number;
  editorGeneration: number;
}

function initialSnapshot(context: RecordsContext | null): RecordsSnapshot {
  return {
    context,
    tables: [],
    tableId: null,
    fields: [],
    page: 1,
    pageSize: 20,
    search: "",
    viewMode: "list",
    order: DEFAULT_RECORD_LIST_ORDER,
    records: null,
    listLoading: false,
    listError: null,
    detail: null,
    detailId: null,
    history: [],
    detailLoading: false,
    detailError: null,
    editor: null,
    saving: false,
    notice: null,
    saveWarning: null,
    persistenceError: null,
    references: new Map(),
    retainedDraftCount: 0,
  };
}

/** Owns one records flow and retains unsaved editors under their original chat and space. */
export class RecordsWorkspace {
  readonly #services: RecordsServices;
  readonly #listeners = new Set<() => void>();
  readonly #sessions = new Map<string, Session>();
  #current: Session | null = null;
  #snapshot = initialSnapshot(null);
  #epoch = 0;

  constructor(services: RecordsServices) {
    this.#services = services;
  }

  getSnapshot = (): RecordsSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  hasUnsavedChanges(): boolean {
    return [...this.#sessions.values()].some(
      (session) => session.state.editor?.dirty || session.state.saving,
    );
  }

  async setContext(context: RecordsContext | null): Promise<void> {
    const previous = this.#current?.state.context;
    if (context && previous?.chatKey === context.chatKey && previous.spaceId === context.spaceId) {
      this.#update(this.#current!, { context });
      return;
    }
    this.#epoch++;
    if (!context) {
      this.#current = null;
      this.#publish();
      return;
    }
    const key = JSON.stringify([context.chatKey, context.spaceId]);
    let session = this.#sessions.get(key);
    if (!session) {
      session = {
        state: initialSnapshot(context),
        listRequest: 0,
        detailRequest: 0,
        refreshRequest: 0,
        saveRequest: 0,
        editorGeneration: 0,
      };
      this.#sessions.set(key, session);
    }
    this.#current = session;
    this.#update(session, {
      context,
      notice: session.state.editor?.dirty ? "已恢复此对话未保存的修改" : null,
    });
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const session = this.#requireSession();
    const context = session.state.context!;
    const epoch = this.#epoch;
    const request = ++session.refreshRequest;
    this.#update(session, { listLoading: true, listError: null });
    try {
      const tables = await this.#services.tables.list(context.spaceId);
      if (epoch !== this.#epoch || request !== session.refreshRequest) return;
      const oldTable = session.state.tableId;
      const tableId =
        oldTable && tables.some((table) => table.id === oldTable)
          ? oldTable
          : (tables[0]?.id ?? null);
      this.#update(session, { tables, tableId });
      if (session.state.editor && oldTable !== tableId) {
        this.#update(session, {
          editor: {
            ...session.state.editor,
            conflict: true,
            error: "草稿所属表已删除，请复制草稿内容后放弃修改",
          },
        });
      }
      await Promise.all([
        this.#loadList(session),
        session.state.detailId ? this.#loadDetail(session) : Promise.resolve(),
      ]);
    } catch (error) {
      if (epoch === this.#epoch && request === session.refreshRequest)
        this.#update(session, {
          listLoading: false,
          listError: String(error instanceof Error ? error.message : error),
        });
    }
  }

  async selectTable(tableId: MemoryTableId): Promise<void> {
    const session = this.#requireSession();
    if (session.state.tableId === tableId) return;
    if (session.state.saving) throw new Error("记录正在保存，请等待完成");
    session.detailRequest++;
    session.editorGeneration++;
    this.#update(session, {
      tableId,
      page: 1,
      search: "",
      order: DEFAULT_RECORD_LIST_ORDER,
      records: null,
      fields: [],
      references: new Map(),
      detailId: null,
      detail: null,
      history: [],
      editor: null,
      detailError: null,
      detailLoading: false,
      notice: null,
    });
    await this.#loadList(session);
  }

  async setSearch(search: string): Promise<void> {
    const session = this.#requireSession();
    this.#update(session, { search, page: 1 });
    await this.#loadList(session);
  }

  async setSort(fieldId: MemoryRecordListOrder["fieldId"]): Promise<void> {
    const session = this.#requireSession();
    const { context, tableId, fields, order } = session.state;
    if (!tableId) throw new Error("请先选择记忆表格");
    if (session.state.saving) throw new Error("记录正在保存，请等待完成");
    if (!recordSortOptions(fields).some((option) => option.fieldId === fieldId))
      throw new Error("该字段不支持排序，请刷新字段列表");
    const next = nextRecordSort(order, fieldId);
    saveRecordSort(context!.spaceId, tableId, next, this.#services.sortStorage);
    this.#update(session, { order: next, page: 1 });
    await this.#loadList(session);
  }

  async setPage(page: number): Promise<void> {
    if (!Number.isInteger(page) || page < 1) throw new Error("页码必须是正整数");
    const session = this.#requireSession();
    this.#update(session, { page });
    await this.#loadList(session);
  }

  async setPageSize(pageSize: number): Promise<void> {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)
      throw new Error("每页条数必须是 1–100 的整数");
    const session = this.#requireSession();
    if (session.state.pageSize === pageSize) return;
    this.#update(session, { pageSize, page: 1 });
    await this.#loadList(session);
  }

  setViewMode(viewMode: RecordsSnapshot["viewMode"]): void {
    this.#update(this.#requireSession(), { viewMode });
  }

  async openRecord(detailId: MemoryRecordId, mode: "detail" | "edit" = "detail"): Promise<void> {
    const session = this.#requireSession();
    if (session.state.saving) throw new Error("记录正在保存，请等待完成");
    session.editorGeneration++;
    this.#update(session, { detailId, detail: null, history: [], editor: null, notice: null });
    await this.#loadDetail(session, mode);
  }

  closeDetail(): void {
    const session = this.#requireSession();
    if (session.state.saving) throw new Error("记录正在保存，请等待完成");
    session.detailRequest++;
    session.editorGeneration++;
    this.#update(session, {
      detailId: null,
      detail: null,
      history: [],
      editor: null,
      detailLoading: false,
      detailError: null,
      notice: null,
    });
  }

  startEdit(): void {
    const session = this.#requireSession();
    const original = session.state.detail;
    if (!original) throw new Error("请先打开一条记录");
    if (session.state.saving) throw new Error("记录正在保存，请等待完成");
    if (session.state.listLoading || session.state.listError) throw new Error("请先完成字段加载");
    session.editorGeneration++;
    this.#update(session, {
      editor: {
        original,
        draft: recordFormDraftFromPayload(session.state.fields, original.payload),
        fields: session.state.fields,
        dirty: false,
        errors: {},
        error: null,
        conflict: false,
      },
      saveWarning: null,
    });
  }

  startCreate(): void {
    const session = this.#requireSession();
    if (!session.state.tableId) throw new Error("请先选择表格");
    if (session.state.saving) throw new Error("记录正在保存，请等待完成");
    if (session.state.listLoading || session.state.listError) throw new Error("请先完成字段加载");
    session.editorGeneration++;
    this.#update(session, {
      editor: {
        original: null,
        draft: emptyRecordFormDraft(session.state.fields),
        fields: session.state.fields,
        dirty: false,
        errors: {},
        error: null,
        conflict: false,
      },
      saveWarning: null,
    });
  }

  setField(fieldId: MemoryFieldId, value: RecordFormValue): void {
    const session = this.#requireSession();
    const editor = session.state.editor;
    if (!editor) throw new Error("请先进入编辑");
    if (session.state.saving) throw new Error("记录正在保存，请等待完成");
    const field = editor.fields.find((field) => field.id === fieldId);
    if (!field?.enabled) throw new Error("该字段不能编辑");
    const draft = { values: { ...editor.draft.values, [fieldId]: value } };
    const enabled = editor.fields.filter((field) => field.enabled);
    const dirty = editor.original
      ? recordFormPatchFromDraft(enabled, editor.original, draft).changed
      : JSON.stringify(draft) !== JSON.stringify(emptyRecordFormDraft(editor.fields));
    this.#update(session, {
      editor: { ...editor, draft, dirty, errors: {}, error: editor.conflict ? editor.error : null },
    });
  }

  cancelEdit(): void {
    const session = this.#requireSession();
    if (session.state.saving) throw new Error("记录正在保存，请等待完成");
    session.editorGeneration++;
    this.#update(session, { editor: null, notice: null });
  }

  async save(): Promise<void> {
    const session = this.#requireSession();
    const context = session.state.context!;
    const editor = session.state.editor;
    const tableId = session.state.tableId;
    if (!editor || !tableId) throw new Error("没有可保存的记录草稿");
    if (session.state.saving) return;
    if (editor.conflict) return;
    const enabled = editor.fields.filter((field) => field.enabled);
    const errors = validateRecordFormDraft(enabled, editor.draft);
    if (Object.keys(errors).length) {
      this.#update(session, { editor: { ...editor, errors, error: "请检查标记的字段" } });
      return;
    }
    const operation = ++session.saveRequest;
    const editorGeneration = session.editorGeneration;
    const submitted = { ...editor, errors: {}, error: null };
    this.#update(session, { editor: submitted, saving: true, saveWarning: null });
    let record: MemoryRecord;
    let persistenceError: string | null = null;
    try {
      this.#services.assertContext(context);
      const result = editor.original
        ? await this.#services.records.update(context.spaceId, tableId, editor.original.id, {
            expectedRevisionId: editor.original.revisionId,
            revisionSource: "user",
            patch: recordFormPatchFromDraft(enabled, editor.original, editor.draft).patch,
          })
        : await this.#services.records.create(context.spaceId, tableId, {
            payload: recordPayloadFromDraft(enabled, editor.draft),
            source: { type: "manual" },
          });
      if (!result) throw new Error("记录或表格已不存在，草稿已保留");
      record = result;
    } catch (error) {
      if (operation !== session.saveRequest || editorGeneration !== session.editorGeneration)
        return;
      if (error instanceof MemoryRecordSaveError) {
        record = error.record;
        persistenceError = error.message;
      } else {
        const conflict =
          typeof error === "object" &&
          error !== null &&
          "type" in error &&
          error.type === "memory_record_revision_conflict";
        this.#update(session, {
          saving: false,
          editor: {
            ...submitted,
            conflict,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }
    }
    if (operation !== session.saveRequest || editorGeneration !== session.editorGeneration) return;
    this.#update(session, {
      saving: false,
      editor: null,
      detail: record,
      detailId: record.id,
      notice: persistenceError ? "记录已更新，保存尚未完成" : "记录已保存",
      persistenceError,
    });
    // The mutation has committed. Follow-up failures must not turn it into a failed save.
    try {
      await this.#services.onSaved?.(context);
    } catch (error) {
      if (operation === session.saveRequest && editorGeneration === session.editorGeneration)
        this.#update(session, {
          saveWarning: `记录已保存，后续刷新失败：${error instanceof Error ? error.message : String(error)}`,
        });
    }
    if (this.#current === session && editorGeneration === session.editorGeneration)
      await Promise.all([this.#loadList(session), this.#loadDetail(session)]);
  }

  /** Retry the persisted snapshot, never replay the record mutation. */
  async retryPersistence(retry: () => Promise<unknown>): Promise<void> {
    const session = this.#requireSession();
    const operation = session.saveRequest;
    this.#services.assertContext(session.state.context!);
    try {
      await retry();
      if (operation === session.saveRequest)
        this.#update(session, { persistenceError: null, notice: "保存已完成" });
    } catch (error) {
      if (operation === session.saveRequest)
        this.#update(session, {
          persistenceError: error instanceof Error ? error.message : String(error),
        });
    }
  }

  async #loadList(session: Session): Promise<void> {
    const { context, tableId, page, pageSize, search, order: requestedOrder } = session.state;
    const epoch = this.#epoch;
    const request = ++session.listRequest;
    if (!context || !tableId) {
      this.#update(session, {
        records: null,
        fields: [],
        references: new Map(),
        listLoading: false,
      });
      return;
    }
    this.#update(session, { listLoading: true, listError: null });
    try {
      const fields = await this.#services.fields.list(context.spaceId, tableId);
      if (epoch !== this.#epoch || request !== session.listRequest) return;
      const order = loadRecordSort(context.spaceId, tableId, fields, this.#services.sortStorage);
      const changedOrder =
        order.fieldId !== requestedOrder.fieldId || order.direction !== requestedOrder.direction;
      const queryPage = changedOrder ? 1 : page;
      this.#update(session, { fields, order, page: queryPage });
      const records = await this.#services.records.list(context.spaceId, tableId, {
        page: queryPage,
        pageSize,
        search: search.trim() || undefined,
        order,
      });
      if (!records) throw new Error("当前表格已不存在");
      const targetIds = [
        ...new Set(
          fields
            .map((field) => field.referenceTableId)
            .filter((id): id is MemoryTableId => id !== null),
        ),
      ];
      const references = new Map(
        await Promise.all(
          targetIds.map(async (targetId) => {
            const values: MemoryRecord[] = [];
            let targetPage = 1;
            let totalPages: number;
            do {
              const result = await this.#services.records.list(context.spaceId, targetId, {
                page: targetPage,
                pageSize: 100,
              });
              if (!result) throw new Error("引用目标表已不存在");
              values.push(...result.records);
              totalPages = result.totalPages;
              targetPage++;
            } while (targetPage <= totalPages);
            return [targetId, values] as const;
          }),
        ),
      );
      if (epoch !== this.#epoch || request !== session.listRequest) return;
      const editor = session.state.editor;
      const schemaChanged = editor && JSON.stringify(editor.fields) !== JSON.stringify(fields);
      this.#update(session, {
        fields,
        records,
        references,
        listLoading: false,
        ...(schemaChanged
          ? {
              editor: {
                ...editor,
                conflict: true,
                error: "表格字段已变化，草稿保留原字段，请复制内容后重新编辑",
              },
            }
          : {}),
      });
    } catch (error) {
      if (epoch === this.#epoch && request === session.listRequest)
        this.#update(session, {
          listLoading: false,
          listError: error instanceof Error ? error.message : String(error),
        });
    }
  }

  async #loadDetail(session: Session, mode: "detail" | "edit" = "detail"): Promise<void> {
    const { context, tableId, detailId } = session.state;
    if (!context || !tableId || !detailId) return;
    const epoch = this.#epoch;
    const request = ++session.detailRequest;
    this.#update(session, { detailLoading: true, detailError: null });
    try {
      const [detail, history] = await Promise.all([
        this.#services.records.find(context.spaceId, tableId, detailId),
        this.#services.records.listHistory(context.spaceId, { tableId, recordId: detailId }),
      ]);
      if (epoch !== this.#epoch || request !== session.detailRequest) return;
      if (!detail) throw new Error("记录已不存在，已有草稿仍保留");
      const editor = session.state.editor;
      const revisionChanged = editor?.original && editor.original.revisionId !== detail.revisionId;
      this.#update(session, {
        detail,
        history,
        detailLoading: false,
        ...(revisionChanged
          ? {
              editor: {
                ...editor,
                conflict: true,
                error: "记录已被其他操作修改，草稿已保留，请复制内容后重新编辑",
              },
            }
          : {}),
      });
      if (mode === "edit") this.startEdit();
    } catch (error) {
      if (epoch !== this.#epoch || request !== session.detailRequest) return;
      const editor = session.state.editor;
      const message = error instanceof Error ? error.message : String(error);
      this.#update(session, {
        detailLoading: false,
        detailError: message,
        ...(editor ? { editor: { ...editor, conflict: true, error: message } } : {}),
      });
    }
  }

  #requireSession(): Session {
    if (!this.#current) throw new Error("当前没有已绑定的对话");
    return this.#current;
  }

  #update(session: Session, patch: Partial<RecordsSnapshot>): void {
    session.state = { ...session.state, ...patch };
    this.#publish();
  }

  #publish(): void {
    const retainedDraftCount = [...this.#sessions.values()].filter(
      (session) => session !== this.#current && session.state.editor?.dirty,
    ).length;
    this.#snapshot = { ...(this.#current?.state ?? initialSnapshot(null)), retainedDraftCount };
    for (const listener of this.#listeners) listener();
  }
}
