import {
  MemoryCommitPersistenceError,
  type MemoryTableService,
  type MemoryFieldService,
  type MemoryRecordService,
  type MemoryTable,
  type MemoryField,
  type MemoryTableId,
  type MemoryFieldId,
  type MemoryRecord,
  type MemoryRecordId,
  type MemoryRecordPage,
  type VectorIndexConfiguration,
} from "../../../features/memory/index.ts";
import type { VectorIndexService } from "../../../features/vector-index/vector-index-service.ts";
import type { VectorPreview } from "../../../features/vector-index/types.ts";
import type { RecordsContext } from "../records-workspace.ts";
import {
  emptyFieldDraft,
  fieldDraftFromField,
  parseOptionsText,
  validateFieldDraft,
  type FieldDraft,
} from "../../../ui/memory/field-editor-model.ts";
import {
  emptyDisplayStrategyDraft,
  displayStrategyFromDraft,
  validateDisplayStrategyDraft,
  type DisplayStrategyDraft,
} from "../../../ui/memory/display-strategy-model.ts";
export interface TablesServices {
  tables: Pick<MemoryTableService, "list" | "create" | "update" | "delete">;
  fields: Pick<MemoryFieldService, "list" | "create" | "update" | "delete" | "setDisplayStrategy">;
  records: Pick<MemoryRecordService, "list" | "previewDisplayText">;
  vectorIndex: Pick<
    VectorIndexService,
    "submit" | "clear" | "getTableSummary" | "previewDraftSummary" | "preview" | "previewDraft"
  >;
  assertContext(context: RecordsContext): void;
  onChanged(context: RecordsContext): Promise<void> | void;
  retryMemorySave(): Promise<void>;
}
export interface TableDraft {
  key: string;
  name: string;
  description: string;
  prompt: string;
  enabled: boolean;
}
export interface FieldEditorDraft extends FieldDraft {
  maxChars: string;
  valuePattern: string;
  valuePatternMessage: string;
}
export type TableEditor =
  | { kind: "table"; original: MemoryTable | null; draft: TableDraft; dirty: boolean }
  | { kind: "field"; original: MemoryField | null; draft: FieldEditorDraft; dirty: boolean }
  | { kind: "display"; draft: DisplayStrategyDraft; dirty: boolean }
  | { kind: "vector"; draft: VectorIndexConfiguration; dirty: boolean };
export interface TablesSnapshot {
  context: RecordsContext | null;
  tables: readonly MemoryTable[];
  tableId: MemoryTableId | null;
  fields: readonly MemoryField[];
  editor: TableEditor | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  notice: string | null;
  persistenceError: string | null;
  previews: readonly string[];
  vectorPreview: VectorRecordPreview | null;
}
export interface VectorRecordPreview {
  configuration: VectorIndexConfiguration | null;
  records: MemoryRecordPage | null;
  page: number;
  search: string;
  record: MemoryRecord | null;
  groups: readonly VectorPreview[];
  loading: boolean;
  error: string | null;
}
interface Session {
  state: TablesSnapshot;
  request: number;
  schema: string | null;
  previewRequest: number;
  vectorRequest: number;
}
const initial = (context: RecordsContext | null): TablesSnapshot => ({
  context,
  tables: [],
  tableId: null,
  fields: [],
  editor: null,
  loading: false,
  saving: false,
  error: null,
  notice: null,
  persistenceError: null,
  previews: [],
  vectorPreview: null,
});
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Each chat retains its editor and the schema against which it was entered. */
export class TablesWorkspace {
  readonly #services: TablesServices;
  readonly #sessions = new Map<string, Session>();
  readonly #listeners = new Set<() => void>();
  #current: Session | null = null;
  #snapshot = initial(null);
  #epoch = 0;
  constructor(services: TablesServices) {
    this.#services = services;
  }
  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  hasUnsavedChanges() {
    return [...this.#sessions.values()].some(({ state }) => state.editor?.dirty || state.saving);
  }
  #update(session: Session, patch: Partial<TablesSnapshot>) {
    session.state = { ...session.state, ...patch };
    if (session === this.#current) {
      this.#snapshot = session.state;
      this.#listeners.forEach((listener) => listener());
    }
  }
  #session() {
    if (!this.#current) throw new Error("请先选择对话");
    return this.#current;
  }
  async setContext(context: RecordsContext | null) {
    if (
      context &&
      this.#current?.state.context?.chatKey === context.chatKey &&
      this.#current.state.context.spaceId === context.spaceId
    )
      return;
    ++this.#epoch;
    if (!context) {
      this.#current = null;
      this.#snapshot = initial(null);
      this.#listeners.forEach((listener) => listener());
      return;
    }
    const key = JSON.stringify([context.chatKey, context.spaceId]);
    let session = this.#sessions.get(key);
    if (!session) {
      session = {
        state: initial(context),
        request: 0,
        schema: null,
        previewRequest: 0,
        vectorRequest: 0,
      };
      this.#sessions.set(key, session);
    }
    this.#current = session;
    this.#update(session, { context });
    const epoch = this.#epoch;
    await this.refresh();
    if (epoch === this.#epoch && session === this.#current && session.state.vectorPreview) {
      const preview = session.state.vectorPreview;
      if (preview.record) await this.selectVectorRecord(preview.record.id);
      else await this.loadVectorRecords(preview.page);
    }
  }
  async refresh() {
    const session = this.#session(),
      epoch = this.#epoch,
      request = ++session.request;
    const { context, tableId } = session.state;
    this.#update(session, { loading: true, error: null });
    try {
      const [tables, fields] = await Promise.all([
        this.#services.tables.list(context!.spaceId),
        tableId ? this.#services.fields.list(context!.spaceId, tableId) : Promise.resolve([]),
      ]);
      if (epoch !== this.#epoch || request !== session.request) return;
      const missing = tableId && !tables.some((table) => table.id === tableId);
      const previewChanged =
        session.state.vectorPreview &&
        JSON.stringify([
          session.state.tables.find((table) => table.id === tableId),
          session.state.fields,
        ]) !== JSON.stringify([tables.find((table) => table.id === tableId), fields]);
      if (previewChanged) session.vectorRequest++;
      this.#update(session, {
        tables,
        fields,
        loading: false,
        ...(missing && !session.state.editor ? { tableId: null } : {}),
        ...(previewChanged
          ? { vectorPreview: null, notice: "表结构或向量配置已变化，请重新打开逐记录预览。" }
          : {}),
      });
    } catch (error) {
      if (epoch === this.#epoch && request === session.request)
        this.#update(session, { loading: false, error: message(error) });
    }
  }
  async selectTable(tableId: MemoryTableId | null) {
    const session = this.#session();
    session.vectorRequest++;
    this.#update(session, { tableId, editor: null, fields: [], previews: [], vectorPreview: null });
    await this.refresh();
  }
  begin(kind: TableEditor["kind"], field?: MemoryField) {
    const session = this.#session(),
      state = session.state,
      table = state.tables.find((item) => item.id === state.tableId) ?? null;
    session.schema = JSON.stringify([table, state.fields]);
    let editor: TableEditor;
    if (kind === "table")
      editor = {
        kind,
        original: table,
        draft: table
          ? {
              key: table.key,
              name: table.name,
              description: table.description,
              prompt: table.prompt,
              enabled: table.enabled,
            }
          : { key: "", name: "", description: "", prompt: "", enabled: true },
        dirty: false,
      };
    else if (kind === "field")
      editor = {
        kind,
        original: field ?? null,
        draft: {
          ...(field ? fieldDraftFromField(field) : emptyFieldDraft("short_text")),
          maxChars: field?.maxChars?.toString() ?? "",
          valuePattern: field?.valuePattern ?? "",
          valuePatternMessage: field?.valuePatternMessage ?? "",
        },
        dirty: false,
      };
    else if (kind === "display")
      editor = { kind, draft: emptyDisplayStrategyDraft(table!.displayStrategy), dirty: false };
    else
      editor = {
        kind,
        draft: table!.vectorIndex ?? {
          enabled: false,
          source: "automatic",
          updateMode: "manual",
          groups: [],
        },
        dirty: false,
      };
    session.vectorRequest++;
    this.#update(session, { editor, error: null, notice: null, previews: [], vectorPreview: null });
  }
  change(editor: TableEditor) {
    const session = this.#session();
    ++session.previewRequest;
    ++session.vectorRequest;
    this.#update(session, {
      editor: { ...editor, dirty: true },
      error: null,
      previews: [],
      vectorPreview: null,
    });
  }
  discard = () => {
    const session = this.#session();
    ++session.previewRequest;
    ++session.vectorRequest;
    this.#update(session, { editor: null, error: null, previews: [], vectorPreview: null });
  };
  async openVectorPreview() {
    const session = this.#session();
    if (!session.state.tableId) throw new Error("请先选择表格");
    const configuration =
      session.state.editor?.kind === "vector" ? structuredClone(session.state.editor.draft) : null;
    this.#update(session, {
      vectorPreview: {
        configuration,
        records: null,
        page: 1,
        search: "",
        record: null,
        groups: [],
        loading: true,
        error: null,
      },
    });
    await this.loadVectorRecords(1, "");
  }
  closeVectorPreview() {
    const session = this.#session();
    session.vectorRequest++;
    this.#update(session, { vectorPreview: null });
  }
  async loadVectorRecords(page: number, search?: string) {
    if (!Number.isInteger(page) || page < 1) throw new Error("页码必须为正整数");
    const session = this.#session();
    const preview = session.state.vectorPreview;
    if (!preview) throw new Error("请先打开向量预览");
    const query = search ?? preview.search;
    const epoch = this.#epoch,
      request = ++session.vectorRequest;
    const context = session.state.context!;
    this.#update(session, {
      vectorPreview: {
        ...preview,
        page,
        search: query,
        record: null,
        groups: [],
        loading: true,
        error: null,
      },
    });
    try {
      this.#services.assertContext(context);
      const records = await this.#services.records.list(context.spaceId, session.state.tableId!, {
        page,
        pageSize: 20,
        search: query,
      });
      this.#services.assertContext(context);
      if (!records) throw new Error("表格或记忆空间已不存在");
      if (epoch === this.#epoch && request === session.vectorRequest && session.state.vectorPreview)
        this.#update(session, {
          vectorPreview: {
            ...session.state.vectorPreview,
            records,
            page: records.page,
            loading: false,
          },
        });
    } catch (error) {
      if (epoch === this.#epoch && request === session.vectorRequest && session.state.vectorPreview)
        this.#update(session, {
          vectorPreview: { ...session.state.vectorPreview, loading: false, error: message(error) },
        });
    }
  }
  async selectVectorRecord(recordId: MemoryRecordId | null) {
    const session = this.#session();
    const preview = session.state.vectorPreview;
    if (!preview) throw new Error("请先打开向量预览");
    const epoch = this.#epoch,
      request = ++session.vectorRequest;
    if (recordId === null) {
      this.#update(session, {
        vectorPreview: { ...preview, record: null, groups: [], loading: false, error: null },
      });
      return;
    }
    const record = preview.records?.records.find((item) => item.id === recordId);
    if (!record) throw new Error("记录列表已变化，请重新选择记录");
    this.#update(session, {
      vectorPreview: { ...preview, record, groups: [], loading: true, error: null },
    });
    const context = session.state.context!;
    try {
      this.#services.assertContext(context);
      const scope = { memorySpaceId: context.spaceId, tableId: session.state.tableId!, recordId };
      const groups = await (preview.configuration
        ? this.#services.vectorIndex.previewDraft(scope, preview.configuration)
        : this.#services.vectorIndex.preview(scope));
      this.#services.assertContext(context);
      if (epoch === this.#epoch && request === session.vectorRequest && session.state.vectorPreview)
        this.#update(session, {
          vectorPreview: { ...session.state.vectorPreview, groups, loading: false },
        });
    } catch (error) {
      if (epoch === this.#epoch && request === session.vectorRequest && session.state.vectorPreview)
        this.#update(session, {
          vectorPreview: { ...session.state.vectorPreview, loading: false, error: message(error) },
        });
    }
  }
  async save() {
    const session = this.#session(),
      { context, tableId, editor } = session.state;
    if (!editor || session.state.saving) return;
    await this.#mutate(session, async () => {
      const tables = await this.#services.tables.list(context!.spaceId);
      const fields = tableId ? await this.#services.fields.list(context!.spaceId, tableId) : [];
      if (
        session.schema !==
        JSON.stringify([tables.find((table) => table.id === tableId) ?? null, fields])
      )
        throw new Error("表结构已变化，请保留所需内容并重新打开编辑器。");
      this.#services.assertContext(context!);
      if (editor.kind === "table") {
        const result = editor.original
          ? await this.#services.tables.update(context!.spaceId, editor.original.id, editor.draft)
          : await this.#services.tables.create(context!.spaceId, {
              ...editor.draft,
              position: Math.max(-1, ...tables.map((table) => table.position)) + 1,
            });
        if (!result) throw new Error("表格或记忆空间已不存在");
        this.#update(session, { tableId: result.id });
      } else if (editor.kind === "field") {
        const errors = Object.values(
          validateFieldDraft(
            editor.draft,
            fields.filter((field) => field.id !== editor.original?.id).map((field) => field.key),
          ),
        );
        if (errors.length) throw new Error(errors.join("；"));
        const draft = editor.draft;
        const input = {
          ...draft,
          options: parseOptionsText(draft.optionsText),
          referenceTableId: draft.referenceTableId
            ? (draft.referenceTableId as MemoryTableId)
            : null,
          maxChars: draft.maxChars === "" ? null : Number(draft.maxChars),
          valuePattern: draft.valuePattern || null,
          valuePatternMessage: draft.valuePatternMessage || null,
        };
        const result = editor.original
          ? await this.#services.fields.update(
              context!.spaceId,
              tableId!,
              editor.original.id,
              input,
            )
          : await this.#services.fields.create(context!.spaceId, tableId!, {
              ...input,
              position: Math.max(-1, ...fields.map((field) => field.position)) + 1,
            });
        if (!result) throw new Error("表格或字段已不存在");
        if ("warnings" in result && result.warnings.length) {
          this.#update(session, { notice: `修改已提交。${result.warnings.join("；")}` });
        }
      } else if (editor.kind === "display") {
        const error = validateDisplayStrategyDraft(editor.draft, fields);
        if (error) throw new Error(error.message);
        if (
          !(await this.#services.fields.setDisplayStrategy(
            context!.spaceId,
            tableId!,
            displayStrategyFromDraft(editor.draft),
          ))
        )
          throw new Error("表格已不存在");
      } else if (
        !(await this.#services.tables.update(context!.spaceId, tableId!, {
          vectorIndex: editor.draft,
        }))
      )
        throw new Error("表格已不存在");
    });
  }
  async #mutate(session: Session, action: () => Promise<void>) {
    if (session.state.saving) return;
    const context = session.state.context!;
    this.#update(session, { saving: true, error: null, notice: null });
    let committed = false;
    try {
      this.#services.assertContext(context);
      await action();
      committed = true;
    } catch (error) {
      if (error instanceof MemoryCommitPersistenceError) {
        committed = true;
        this.#update(session, { persistenceError: message(error) });
      } else this.#update(session, { error: message(error) });
    }
    if (committed) {
      this.#update(session, {
        editor: null,
        notice: session.state.notice ?? "修改已提交",
        previews: [],
      });
      try {
        await this.#services.onChanged(context);
      } catch (error) {
        this.#update(session, { notice: `修改已提交，刷新失败：${message(error)}` });
      }
      if (session === this.#current) await this.refresh();
    }
    this.#update(session, { saving: false });
  }
  async remove(fieldId?: MemoryFieldId) {
    const session = this.#session(),
      { context, tableId } = session.state;
    await this.#mutate(session, async () => {
      const removed = fieldId
        ? await this.#services.fields.delete(context!.spaceId, tableId!, fieldId)
        : await this.#services.tables.delete(context!.spaceId, tableId!);
      if (!removed) throw new Error("要删除的内容已不存在");
      if (!fieldId) this.#update(session, { tableId: null });
    });
    if (session.state.error) throw new Error(session.state.error);
  }
  async preview() {
    const session = this.#session(),
      { context, tableId, editor } = session.state,
      epoch = this.#epoch,
      request = ++session.previewRequest;
    try {
      let previews: string[];
      if (editor?.kind === "display") {
        const error = validateDisplayStrategyDraft(editor.draft, session.state.fields);
        if (error) throw new Error(error.message);
        const page = await this.#services.records.list(context!.spaceId, tableId!, {
          page: 1,
          pageSize: 5,
        });
        previews = page?.records.length
          ? await Promise.all(
              page.records.map((record) =>
                this.#services.records.previewDisplayText(
                  context!.spaceId,
                  tableId!,
                  displayStrategyFromDraft(editor.draft),
                  record.payload,
                ),
              ),
            )
          : ["当前表没有记录，添加记录后可预览真实显示文本。"];
      } else if (editor?.kind === "vector") {
        const result = await this.#services.vectorIndex.previewDraftSummary(
          { memorySpaceId: context!.spaceId, tableId: tableId! },
          editor.draft,
        );
        previews = [
          `${result.records} 条记录 · ${result.vectors} 个向量目标 · ${result.ready} 就绪 · ${result.pending} 待建`,
          `空输入 ${result.empty} · 配置错误 ${result.invalid} · 超长 ${result.tooLong} · 连接不可用 ${result.unavailable}`,
        ];
      } else return;
      if (epoch === this.#epoch && request === session.previewRequest)
        this.#update(session, { previews, error: null });
    } catch (error) {
      if (epoch === this.#epoch && request === session.previewRequest)
        this.#update(session, { error: message(error) });
    }
  }
  async index(action: "build" | "rebuild" | "clear") {
    const session = this.#session(),
      { context, tableId } = session.state;
    if (session.state.saving) return;
    this.#update(session, { saving: true, error: null });
    try {
      this.#services.assertContext(context!);
      const scope = { memorySpaceId: context!.spaceId, tableId: tableId! };
      if (action === "clear") await this.#services.vectorIndex.clear(scope);
      else
        await this.#services.vectorIndex.submit(scope, {
          source: "manual",
          force: action === "rebuild",
        });
      this.#update(session, {
        notice:
          action === "clear" ? "向量已清除，记忆正文保留" : "索引任务已提交，请在任务页查看进度",
      });
    } catch (error) {
      this.#update(session, { error: message(error) });
      throw error;
    } finally {
      this.#update(session, { saving: false });
    }
  }
  async retryPersistence() {
    const session = this.#session();
    this.#update(session, { saving: true });
    try {
      this.#services.assertContext(session.state.context!);
      await this.#services.retryMemorySave();
      this.#update(session, { persistenceError: null, notice: "已重新保存到对话文件" });
    } catch (error) {
      this.#update(session, { persistenceError: message(error) });
    } finally {
      this.#update(session, { saving: false });
    }
  }
}
