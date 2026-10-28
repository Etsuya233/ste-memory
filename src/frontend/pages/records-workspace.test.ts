import { describe, expect, it, vi } from "vitest";
import { MemoryRecordSaveError } from "../../features/memory/index.ts";
import { loadRecordSort, saveRecordSort } from "../../ui/memory/record-sort-model.ts";
import type {
  MemoryField,
  MemoryFieldId,
  MemoryRecord,
  MemoryRecordId,
  MemoryRecordPage,
  MemoryRevisionId,
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
} from "../../features/memory/index.ts";
import {
  RecordsWorkspace,
  type RecordsContext,
  type RecordsServices,
} from "./records-workspace.ts";

const fieldId = "name" as MemoryFieldId;
const tableId = "people" as MemoryTableId;
const recordId = "person" as MemoryRecordId;
const contextA: RecordsContext = {
  chatKey: "chat-a",
  spaceId: "space-a" as MemorySpaceId,
  title: "对话 A",
};
const contextB: RecordsContext = {
  chatKey: "chat-b",
  spaceId: "space-b" as MemorySpaceId,
  title: "对话 B",
};
const field: MemoryField = {
  id: fieldId,
  memorySpaceId: contextA.spaceId,
  tableId,
  key: "name" as MemoryField["key"],
  name: "姓名",
  type: "short_text",
  required: true,
  prompt: "",
  enabled: true,
  position: 0,
  options: [],
  referenceTableId: null,
  maxChars: null,
  valuePattern: null,
  valuePatternMessage: null,
  createdAt: "2026-10-28",
  updatedAt: "2026-10-28",
};
const table: MemoryTable = {
  id: tableId,
  memorySpaceId: contextA.spaceId,
  key: "people" as MemoryTable["key"],
  name: "人物",
  description: "",
  prompt: "",
  enabled: true,
  position: 0,
  displayStrategy: null,
  createdAt: "2026-10-28",
  updatedAt: "2026-10-28",
};
function record(spaceId = contextA.spaceId, name = "原文", revision = "v1"): MemoryRecord {
  return {
    id: recordId,
    memorySpaceId: spaceId,
    tableId,
    payload: { [fieldId]: name, disabled: "保留" },
    displayText: name,
    fieldEvidence: {},
    source: { type: "manual" },
    revisionId: revision as MemoryRevisionId,
    revisionSource: "user",
    createdAt: "2026-10-28",
    updatedAt: "2026-10-28",
  };
}
function page(records: readonly MemoryRecord[], number = 1, totalPages = 1): MemoryRecordPage {
  return { records, page: number, pageSize: 20, total: records.length, totalPages };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  const preferences = new Map<string, string>();
  const sortStorage = {
    getItem: (key: string) => preferences.get(key) ?? null,
    setItem: (key: string, value: string) => {
      preferences.set(key, value);
    },
    removeItem: (key: string) => {
      preferences.delete(key);
    },
  };
  const tables = { list: vi.fn<RecordsServices["tables"]["list"]>().mockResolvedValue([table]) };
  const fields = { list: vi.fn<RecordsServices["fields"]["list"]>().mockResolvedValue([field]) };
  const records = {
    list: vi
      .fn<RecordsServices["records"]["list"]>()
      .mockImplementation(async (spaceId) => page([record(spaceId)])),
    find: vi
      .fn<RecordsServices["records"]["find"]>()
      .mockImplementation(async (spaceId) => record(spaceId)),
    listHistory: vi.fn<RecordsServices["records"]["listHistory"]>().mockResolvedValue([]),
    create: vi.fn<RecordsServices["records"]["create"]>().mockResolvedValue(record()),
    update: vi
      .fn<RecordsServices["records"]["update"]>()
      .mockResolvedValue(record(contextA.spaceId, "修改", "v2")),
  };
  const assertContext = vi.fn<RecordsServices["assertContext"]>();
  const onSaved = vi.fn<NonNullable<RecordsServices["onSaved"]>>().mockResolvedValue(undefined);
  const workspace = new RecordsWorkspace({
    tables,
    fields,
    records,
    assertContext,
    onSaved,
    sortStorage,
  });
  return { workspace, tables, fields, records, assertContext, onSaved, sortStorage };
}
async function edit(workspace: RecordsWorkspace) {
  await workspace.setContext(contextA);
  await workspace.openRecord(recordId);
  workspace.startEdit();
  workspace.setField(fieldId, "修改");
}

describe("RecordsWorkspace", () => {
  it("opens a fresh record directly in the editor and preserves the current query", async () => {
    const { workspace, records } = setup();
    await workspace.setContext(contextA);
    workspace.setViewMode("table");
    await workspace.setSearch("原文");
    await workspace.setPage(2);
    records.find.mockResolvedValueOnce(record(contextA.spaceId, "最新内容", "v2"));
    await workspace.openRecord(recordId, "edit");
    expect(workspace.getSnapshot()).toMatchObject({
      viewMode: "table",
      page: 2,
      search: "原文",
      editor: {
        original: { revisionId: "v2" },
        draft: { values: { name: "最新内容" } },
        dirty: false,
      },
    });
    workspace.closeDetail();
    expect(workspace.getSnapshot()).toMatchObject({
      viewMode: "table",
      page: 2,
      search: "原文",
      editor: null,
    });
  });

  it("retains the view mode across chats and isolates chats sharing a space", async () => {
    const { workspace } = setup();
    await workspace.setContext(contextA);
    workspace.setViewMode("table");
    await workspace.setContext({ ...contextB, spaceId: contextA.spaceId });
    expect(workspace.getSnapshot().viewMode).toBe("list");
    await workspace.setContext(contextA);
    expect(workspace.getSnapshot().viewMode).toBe("table");
  });

  it.each(["resolve", "reject"])(
    "ignores obsolete direct-edit %s after A → B → A",
    async (outcome) => {
      const { workspace, records } = setup();
      await workspace.setContext(contextA);
      const slow = deferred<MemoryRecord | undefined>();
      records.find.mockReturnValueOnce(slow.promise);
      const pending = workspace.openRecord(recordId, "edit");
      await workspace.setContext(contextB);
      expect(workspace.getSnapshot().editor).toBeNull();
      await workspace.setContext(contextA);
      if (outcome === "resolve") slow.resolve(record(contextA.spaceId, "过期内容"));
      else slow.reject(new Error("过期失败"));
      await pending;
      expect(workspace.getSnapshot()).toMatchObject({ editor: null, detailError: null });
      expect(workspace.getSnapshot().detail?.displayText).toBe("原文");
    },
  );

  it("does not open an editor after returning to records during loading", async () => {
    const { workspace, records } = setup();
    await workspace.setContext(contextA);
    const slow = deferred<MemoryRecord | undefined>();
    records.find.mockReturnValueOnce(slow.promise);
    const pending = workspace.openRecord(recordId, "edit");
    workspace.closeDetail();
    slow.resolve(record());
    await pending;
    expect(workspace.getSnapshot()).toMatchObject({ editor: null, detailId: null, detail: null });
  });

  it("reports a deleted record without opening a stale editor", async () => {
    const { workspace, records } = setup();
    await workspace.setContext(contextA);
    records.find.mockResolvedValueOnce(undefined);
    await workspace.openRecord(recordId, "edit");
    expect(workspace.getSnapshot()).toMatchObject({
      editor: null,
      detail: null,
      detailError: "记录已不存在，已有草稿仍保留",
    });
  });

  it("loads the persisted sort before fetching the first page", async () => {
    const { workspace, records, sortStorage } = setup();
    saveRecordSort(contextA.spaceId, tableId, { fieldId, direction: "desc" }, sortStorage);
    await workspace.setContext(contextA);
    expect(records.list).toHaveBeenLastCalledWith(contextA.spaceId, tableId, {
      page: 1,
      pageSize: 20,
      search: undefined,
      order: { fieldId, direction: "desc" },
    });
    expect(workspace.getSnapshot().order).toEqual({ fieldId, direction: "desc" });
  });
  it("applies a page size and returns to the first page", async () => {
    const { workspace, records } = setup();
    await workspace.setContext(contextA);
    await workspace.setPage(2);
    await workspace.setPageSize(50);
    expect(workspace.getSnapshot()).toMatchObject({ page: 1, pageSize: 50 });
    expect(records.list).toHaveBeenLastCalledWith(
      contextA.spaceId,
      tableId,
      expect.objectContaining({ page: 1, pageSize: 50 }),
    );
    await expect(workspace.setPageSize(0)).rejects.toThrow("每页条数");
  });
  it("resets paging on a sort selection and keeps its direction for search", async () => {
    const { workspace, records } = setup();
    await workspace.setContext(contextA);
    await workspace.setPage(2);
    await workspace.setSort(fieldId);
    expect(workspace.getSnapshot()).toMatchObject({
      page: 1,
      order: { fieldId, direction: "asc" },
    });
    await workspace.setSort(fieldId);
    await workspace.setSearch("原文");
    expect(records.list).toHaveBeenLastCalledWith(contextA.spaceId, tableId, {
      page: 1,
      pageSize: 20,
      search: "原文",
      order: { fieldId, direction: "desc" },
    });
  });
  it("retains independent preferences per space and table", async () => {
    const { workspace, tables } = setup();
    const otherId = "other" as MemoryTableId;
    tables.list.mockResolvedValue([table, { ...table, id: otherId }]);
    await workspace.setContext(contextA);
    await workspace.setSort(fieldId);
    await workspace.selectTable(otherId);
    expect(workspace.getSnapshot().order.fieldId).toBe("$created_at");
    await workspace.setSort("$updated_at");
    await workspace.selectTable(tableId);
    expect(workspace.getSnapshot().order.fieldId).toBe(fieldId);
    await workspace.setContext(contextB);
    expect(workspace.getSnapshot().order.fieldId).toBe("$created_at");
    await workspace.setContext(contextA);
    expect(workspace.getSnapshot().order.fieldId).toBe(fieldId);
  });
  it.each(["deleted", "unsupported"])(
    "resets a %s sort field before requesting records",
    async (kind) => {
      const { workspace, fields, records, sortStorage } = setup();
      await workspace.setContext(contextA);
      await workspace.setSort(fieldId);
      await workspace.setPage(2);
      fields.list.mockResolvedValue(kind === "deleted" ? [] : [{ ...field, type: "multi_select" }]);
      await workspace.refresh();
      expect(workspace.getSnapshot()).toMatchObject({
        page: 1,
        order: { fieldId: "$created_at", direction: "asc" },
      });
      expect(records.list).toHaveBeenLastCalledWith(
        contextA.spaceId,
        tableId,
        expect.objectContaining({ page: 1, order: { fieldId: "$created_at", direction: "asc" } }),
      );
      expect(loadRecordSort(contextA.spaceId, tableId, [field], sortStorage).fieldId).toBe(
        "$created_at",
      );
    },
  );
  it("ignores an obsolete sorted page after switching A → B → A", async () => {
    const { workspace, records } = setup();
    await workspace.setContext(contextA);
    const slow = deferred<MemoryRecordPage>();
    records.list.mockReturnValueOnce(slow.promise);
    const pending = workspace.setSort(fieldId);
    await Promise.resolve();
    await workspace.setContext(contextB);
    await workspace.setContext(contextA);
    await workspace.setSort(fieldId);
    slow.resolve(page([record(contextA.spaceId, "过期排序页")]));
    await pending;
    expect(workspace.getSnapshot()).toMatchObject({
      order: { fieldId, direction: "desc" },
      listLoading: false,
    });
    expect(workspace.getSnapshot().records?.records[0]?.displayText).toBe("原文");
  });
  it("does not invalidate a saved sort from an obsolete schema read", async () => {
    const { workspace, fields, sortStorage } = setup();
    await workspace.setContext(contextA);
    await workspace.setSort(fieldId);
    const slow = deferred<MemoryField[]>();
    fields.list.mockReturnValueOnce(slow.promise);
    const pending = workspace.setPage(2);
    await workspace.setContext(contextB);
    await workspace.setContext(contextA);
    slow.resolve([]);
    await pending;
    expect(loadRecordSort(contextA.spaceId, tableId, [field], sortStorage)).toEqual({
      fieldId,
      direction: "asc",
    });
    expect(workspace.getSnapshot().order.fieldId).toBe(fieldId);
  });
  it("ends creation after a committed write error and retries persistence without creating again", async () => {
    const { workspace, records } = setup();
    await workspace.setContext(contextA);
    workspace.startCreate();
    workspace.setField(fieldId, "已提交");
    const committed = record(contextA.spaceId, "已提交", "v2");
    records.create.mockRejectedValueOnce(
      new MemoryRecordSaveError(committed, new Error("文件写回失败")),
    );
    records.find.mockResolvedValue(committed);
    await workspace.save();
    expect(workspace.getSnapshot()).toMatchObject({
      editor: null,
      saving: false,
      detail: committed,
      persistenceError: "文件写回失败",
    });
    const retry = vi.fn(async () => {});
    await workspace.retryPersistence(retry);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(records.create).toHaveBeenCalledTimes(1);
    expect(workspace.getSnapshot().persistenceError).toBeNull();
  });
  it("starts with a list and keeps detail and draft while querying another page", async () => {
    const { workspace } = setup();
    await workspace.setContext(contextA);
    expect(workspace.getSnapshot().detailId).toBeNull();
    await workspace.openRecord(recordId);
    workspace.startEdit();
    workspace.setField(fieldId, "草稿");
    await workspace.setSearch("别的内容");
    await workspace.setPage(2);
    expect(workspace.getSnapshot()).toMatchObject({
      page: 2,
      search: "别的内容",
      detailId: recordId,
      editor: { dirty: true, draft: { values: { name: "草稿" } } },
    });
  });

  it("ignores earlier list results across A → B → A", async () => {
    const { workspace, records } = setup();
    await workspace.setContext(contextA);
    const slow = deferred<MemoryRecordPage>();
    records.list.mockReturnValueOnce(slow.promise);
    const first = workspace.setSearch("旧请求");
    await Promise.resolve();
    await workspace.setContext(contextB);
    await workspace.setContext(contextA);
    slow.resolve(page([record(contextA.spaceId, "过期结果")]));
    await first;
    expect(workspace.getSnapshot().records?.records[0]?.displayText).toBe("原文");
    expect(workspace.getSnapshot().listLoading).toBe(false);
  });

  it("retains drafts through null and isolates chats sharing one space", async () => {
    const { workspace } = setup();
    await edit(workspace);
    await workspace.setContext(null);
    expect(workspace.hasUnsavedChanges()).toBe(true);
    expect(workspace.getSnapshot().retainedDraftCount).toBe(1);
    await workspace.setContext({ ...contextB, spaceId: contextA.spaceId });
    expect(workspace.getSnapshot().editor).toBeNull();
    await workspace.setContext(contextA);
    expect(workspace.getSnapshot()).toMatchObject({
      notice: "已恢复此对话未保存的修改",
      editor: { draft: { values: { name: "修改" } } },
    });
  });

  it("title refresh preserves an in-flight load and the editor", async () => {
    const { workspace, records } = setup();
    await edit(workspace);
    const slow = deferred<MemoryRecordPage>();
    records.list.mockReturnValueOnce(slow.promise);
    const loading = workspace.setSearch("姓名");
    await workspace.setContext({ ...contextA, title: "新标题" });
    slow.resolve(page([record(contextA.spaceId, "搜索结果")]));
    await loading;
    expect(workspace.getSnapshot()).toMatchObject({
      context: { title: "新标题" },
      editor: { dirty: true },
    });
    expect(workspace.getSnapshot().records?.records[0]?.displayText).toBe("搜索结果");
  });

  it("saves enabled changes with the original revision and keeps disabled payload untouched", async () => {
    const { workspace, fields, records, onSaved } = setup();
    fields.list.mockResolvedValue([
      field,
      { ...field, id: "disabled" as MemoryFieldId, enabled: false },
    ]);
    await edit(workspace);
    expect(() => workspace.setField("disabled" as MemoryFieldId, "丢失")).toThrow("不能编辑");
    records.find.mockResolvedValue(record(contextA.spaceId, "修改", "v2"));
    await workspace.save();
    expect(records.update).toHaveBeenCalledWith(contextA.spaceId, tableId, recordId, {
      expectedRevisionId: "v1",
      revisionSource: "user",
      patch: { name: "修改" },
    });
    expect(onSaved).toHaveBeenCalledWith(contextA);
    expect(workspace.getSnapshot()).toMatchObject({
      editor: null,
      saving: false,
      detail: { revisionId: "v2" },
    });
  });

  it("checks the live host immediately before writing and preserves a rejected draft", async () => {
    const { workspace, records, assertContext } = setup();
    await edit(workspace);
    assertContext.mockImplementation(() => {
      throw new Error("对话已切换");
    });
    await workspace.save();
    expect(records.update).not.toHaveBeenCalled();
    expect(workspace.getSnapshot()).toMatchObject({
      saving: false,
      editor: { dirty: true, error: "对话已切换" },
    });
  });

  it.each(["success", "failure"])(
    "settles %s for an old chat without updating the current editor",
    async (outcome) => {
      const { workspace, records } = setup();
      await edit(workspace);
      const slow = deferred<MemoryRecord>();
      records.update.mockReturnValueOnce(slow.promise);
      const saving = workspace.save();
      await workspace.setContext(contextB);
      await workspace.openRecord(recordId);
      workspace.startEdit();
      workspace.setField(fieldId, "对话 B 草稿");
      if (outcome === "success") slow.resolve(record(contextA.spaceId, "修改", "v2"));
      else slow.reject(new Error("旧保存失败"));
      await saving;
      expect(workspace.getSnapshot()).toMatchObject({
        context: contextB,
        saving: false,
        editor: { draft: { values: { name: "对话 B 草稿" } }, error: null },
      });
      await workspace.setContext(contextA);
      if (outcome === "failure") expect(workspace.getSnapshot().editor?.error).toBe("旧保存失败");
      else expect(workspace.getSnapshot().editor).toBeNull();
    },
  );

  it("finishes a save even when returning to A refreshes and marks the pending draft", async () => {
    const { workspace, records } = setup();
    await edit(workspace);
    const slow = deferred<MemoryRecord>();
    records.update.mockReturnValueOnce(slow.promise);
    const saving = workspace.save();
    await workspace.setContext(contextB);
    records.find.mockResolvedValue(record(contextA.spaceId, "修改", "v2"));
    await workspace.setContext(contextA);
    slow.resolve(record(contextA.spaceId, "修改", "v2"));
    await saving;
    expect(workspace.getSnapshot()).toMatchObject({ saving: false, editor: null });
  });

  it("keeps a new draft when an earlier save follow-up fails", async () => {
    const { workspace, onSaved, records } = setup();
    await edit(workspace);
    const followup = deferred<void>();
    onSaved.mockReturnValueOnce(followup.promise);
    records.find.mockResolvedValue(record(contextA.spaceId, "修改", "v2"));
    const saving = workspace.save();
    await vi.waitFor(() => expect(workspace.getSnapshot().editor).toBeNull());
    workspace.startEdit();
    workspace.setField(fieldId, "第二份草稿");
    followup.reject(new Error("宏刷新失败"));
    await saving;
    expect(workspace.getSnapshot()).toMatchObject({
      editor: { draft: { values: { name: "第二份草稿" } } },
      saveWarning: null,
    });
  });

  it("separates committed-save warnings from write failure", async () => {
    const { workspace, onSaved } = setup();
    await edit(workspace);
    onSaved.mockRejectedValueOnce(new Error("宏刷新失败"));
    await workspace.save();
    expect(workspace.getSnapshot()).toMatchObject({
      editor: null,
      saveWarning: "记录已保存，后续刷新失败：宏刷新失败",
    });
  });

  it.each(["schema", "revision"])(
    "restores %s conflicts without transforming the saved draft",
    async (kind) => {
      const { workspace, fields, records } = setup();
      await edit(workspace);
      await workspace.setContext(contextB);
      if (kind === "schema") fields.list.mockResolvedValue([{ ...field, type: "integer" }]);
      else records.find.mockResolvedValue(record(contextA.spaceId, "外部更新", "v2"));
      await workspace.setContext(contextA);
      expect(workspace.getSnapshot().editor).toMatchObject({
        conflict: true,
        fields: [field],
        draft: { values: { name: "修改" } },
      });
      await workspace.save();
      expect(records.update).not.toHaveBeenCalled();
    },
  );

  it("loads every page of a reference target and reports reference failures", async () => {
    const { workspace, fields, records } = setup();
    const target = "references" as MemoryTableId;
    fields.list.mockResolvedValue([
      { ...field, type: "single_reference", referenceTableId: target },
    ]);
    records.list.mockImplementation(async (spaceId, id, query) =>
      id === target
        ? page([record(spaceId, `引用 ${query.page}`)], query.page, 2)
        : page([record(spaceId)]),
    );
    await workspace.setContext(contextA);
    expect(
      workspace
        .getSnapshot()
        .references.get(target)
        ?.map((item) => item.displayText),
    ).toEqual(["引用 1", "引用 2"]);
    records.list.mockRejectedValueOnce(new Error("读取失败"));
    await workspace.setSearch("新搜索");
    expect(workspace.getSnapshot().listError).toBe("读取失败");
  });

  it("separates a detail read failure from the usable records list", async () => {
    const { workspace, records } = setup();
    await workspace.setContext(contextA);
    records.find.mockRejectedValueOnce(new Error("详情失败"));
    await workspace.openRecord(recordId);
    expect(workspace.getSnapshot()).toMatchObject({
      detailError: "详情失败",
      listError: null,
      detailLoading: false,
    });
    expect(workspace.getSnapshot().records?.records).toHaveLength(1);
  });
});
