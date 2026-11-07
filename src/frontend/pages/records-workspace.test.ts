import { describe, expect, it, vi } from "vitest";
import {
  MemoryCommitPersistenceError,
  MemoryRecordSaveError,
} from "../../features/memory/index.ts";
import { loadRecordSort, saveRecordSort } from "../models/memory/record-sort-model.ts";
import type {
  MemoryField,
  MemoryFieldId,
  MemoryRecord,
  MemoryRecordId,
  MemoryRecordHistory,
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
    stableId: recordId,
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
    delete: vi.fn<RecordsServices["records"]["delete"]>().mockResolvedValue(true),
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

function historical(
  payload: MemoryRecord["payload"] = { name: "历史姓名", disabled: "旧值" },
): MemoryRecordHistory {
  const original = record();
  return {
    ...original,
    id: "history-1" as MemoryRecordHistory["id"],
    recordId,
    payload,
    previousRevisionId: "v0" as MemoryRevisionId,
    previousRevisionSource: "agent",
    archivedAt: "2026-10-27T12:00:00.000Z",
  };
}

describe("revision restoration", () => {
  async function ready(payload?: MemoryRecord["payload"]) {
    const fixture = setup();
    const entry = historical(payload);
    fixture.records.listHistory.mockResolvedValue([entry]);
    fixture.fields.list.mockResolvedValue([
      field,
      { ...field, id: "disabled" as MemoryFieldId, enabled: false },
    ]);
    await fixture.workspace.setContext(contextA);
    await fixture.workspace.openRecord(recordId);
    return { ...fixture, entry };
  }

  it("loads a draft without writes, then saves a user patch against the current revision", async () => {
    const { workspace, records, entry } = await ready();
    workspace.restoreRevision(entry.id);
    expect(workspace.getSnapshot().editor).toMatchObject({
      original: { revisionId: "v1" },
      draft: { values: { name: "历史姓名", disabled: "保留" } },
      dirty: true,
      restoredFrom: entry.archivedAt,
    });
    expect(records.update).not.toHaveBeenCalled();
    expect(records.create).not.toHaveBeenCalled();
    await workspace.save();
    expect(records.update).toHaveBeenCalledWith(contextA.spaceId, tableId, recordId, {
      expectedRevisionId: "v1",
      revisionSource: "user",
      patch: { name: "历史姓名" },
    });
  });

  it("keeps identical values clean and cancelling leaves committed data alone", async () => {
    const { workspace, records, entry } = await ready({ name: "原文", removed: "已删除" });
    workspace.restoreRevision(entry.id);
    expect(workspace.getSnapshot().editor?.dirty).toBe(false);
    expect(workspace.getSnapshot().notice).toBe("所选修订与当前内容一致");
    workspace.cancelEdit();
    expect(workspace.getSnapshot().detail?.payload.name).toBe("原文");
    expect(records.update).not.toHaveBeenCalled();
  });

  it("blocks incompatible historical types until that field is explicitly edited", async () => {
    const { workspace, records, entry } = await ready({ name: ["旧列表"] });
    workspace.restoreRevision(entry.id);
    expect(workspace.getSnapshot().editor?.errors.name).toContain("旧列表");
    await workspace.save();
    expect(records.update).not.toHaveBeenCalled();
    workspace.setField(fieldId, "修正后的姓名");
    await workspace.save();
    expect(records.update).toHaveBeenCalledOnce();
  });

  it("validates fields added since the historical revision", async () => {
    const { workspace, records, entry } = await ready({ removed: "旧字段" });
    workspace.restoreRevision(entry.id);
    expect(workspace.getSnapshot().editor?.errors.name).toBe("请填写「姓名」");
    await workspace.save();
    expect(records.update).not.toHaveBeenCalled();
  });

  it("retains restored drafts across chats and preserves conflicts on save", async () => {
    const { workspace, records, entry } = await ready();
    workspace.restoreRevision(entry.id);
    await workspace.setContext(contextB);
    await workspace.setContext(contextA);
    expect(workspace.getSnapshot().editor?.draft.values.name).toBe("历史姓名");
    records.update.mockRejectedValue(
      Object.assign(new Error("记录已变化"), { type: "memory_record_revision_conflict" }),
    );
    await workspace.save();
    expect(workspace.getSnapshot().editor).toMatchObject({
      conflict: true,
      dirty: true,
      draft: { values: { name: "历史姓名" } },
    });
  });

  it("blocks stale references and options on restoration and rechecks before saving", async () => {
    const { workspace, records, fields, entry } = await ready({ name: "missing" });
    fields.list.mockResolvedValue([
      { ...field, type: "single_reference", referenceTableId: tableId },
    ]);
    await workspace.refresh();
    workspace.restoreRevision(entry.id);
    expect(workspace.getSnapshot().editor?.errors.name).toContain("已失效的引用");
    workspace.setField(fieldId, "still-missing");
    await workspace.save();
    expect(records.update).not.toHaveBeenCalled();
    workspace.cancelEdit();
    fields.list.mockResolvedValue([{ ...field, type: "single_select", options: ["有效"] }]);
    await workspace.refresh();
    workspace.restoreRevision(entry.id);
    expect(workspace.getSnapshot().editor?.errors.name).toContain("选项无效");
    await workspace.save();
    expect(records.update).not.toHaveBeenCalled();
  });
});

describe("RecordsWorkspace", () => {
  it("deletes with the displayed revision, clears the draft and returns from an empty last page", async () => {
    const { workspace, records, onSaved } = setup();
    await edit(workspace);
    await workspace.setPage(2);
    records.list.mockResolvedValue(page([]));
    await workspace.deleteRecord(record());
    expect(records.delete).toHaveBeenCalledWith(contextA.spaceId, tableId, recordId, "v1", "user");
    expect(onSaved).toHaveBeenCalledWith(contextA);
    expect(workspace.getSnapshot()).toMatchObject({
      saving: false,
      detailId: null,
      detail: null,
      editor: null,
      page: 1,
      notice: "记录已删除",
    });
  });

  it("retains the record and draft after a rejected deletion and blocks stale host writes", async () => {
    const { workspace, records, assertContext } = setup();
    await edit(workspace);
    records.delete.mockRejectedValueOnce(new Error("记录仍被引用"));
    await expect(workspace.deleteRecord(record())).rejects.toThrow("仍被引用");
    expect(workspace.getSnapshot()).toMatchObject({
      saving: false,
      detailId: recordId,
      editor: { dirty: true },
    });
    assertContext.mockImplementation(() => {
      throw new Error("对话已切换");
    });
    await expect(workspace.deleteRecord(record())).rejects.toThrow("对话已切换");
    expect(records.delete).toHaveBeenCalledTimes(1);
  });

  it("treats a committed deletion with failed persistence as completed", async () => {
    const { workspace, records } = setup();
    await edit(workspace);
    records.delete.mockRejectedValueOnce(
      new MemoryCommitPersistenceError(new Error("文件写回失败")),
    );
    await workspace.deleteRecord(record());
    expect(workspace.getSnapshot()).toMatchObject({
      saving: false,
      detailId: null,
      editor: null,
      notice: "记录已删除",
    });
    expect(records.delete).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "failure"])(
    "isolates an in-flight deletion %s from another chat and prevents duplicate writes",
    async (outcome) => {
      const { workspace, records } = setup();
      await edit(workspace);
      const slow = deferred<boolean>();
      records.delete.mockReturnValueOnce(slow.promise);
      const pending = workspace.deleteRecord(record());
      await workspace.deleteRecord(record());
      expect(records.delete).toHaveBeenCalledTimes(1);
      expect(() => workspace.closeDetail()).toThrow("正在保存");
      await workspace.setContext(contextB);
      await workspace.openRecord(recordId, "edit");
      workspace.setField(fieldId, "B 草稿");
      if (outcome === "success") slow.resolve(true);
      else slow.reject(new Error("删除失败"));
      if (outcome === "success") await pending;
      else await expect(pending).rejects.toThrow("删除失败");
      expect(workspace.getSnapshot()).toMatchObject({
        context: contextB,
        saving: false,
        editor: { draft: { values: { name: "B 草稿" } } },
      });
    },
  );

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
      if (outcome === "resolve") {
        slow.resolve(record(contextA.spaceId, "过期内容"));
      } else {
        slow.reject(new Error("过期失败"));
      }
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
  it("ends creation after a committed write error without copying file save state", async () => {
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
      notice: "记录修改已提交",
    });
    await expect(workspace.save()).rejects.toThrow("没有可保存的记录草稿");
    expect(records.create).toHaveBeenCalledTimes(1);
    expect(workspace.getSnapshot()).not.toHaveProperty("persistenceError");
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
      if (outcome === "success") {
        slow.resolve(record(contextA.spaceId, "修改", "v2"));
      } else {
        slow.reject(new Error("旧保存失败"));
      }
      await saving;
      expect(workspace.getSnapshot()).toMatchObject({
        context: contextB,
        saving: false,
        editor: { draft: { values: { name: "对话 B 草稿" } }, error: null },
      });
      await workspace.setContext(contextA);
      if (outcome === "failure") {
        expect(workspace.getSnapshot().editor?.error).toBe("旧保存失败");
      } else {
        expect(workspace.getSnapshot().editor).toBeNull();
      }
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
      saveWarning: "记录修改已提交，后续刷新失败：宏刷新失败",
    });
  });

  it.each(["schema", "revision"])(
    "restores %s conflicts without transforming the saved draft",
    async (kind) => {
      const { workspace, fields, records } = setup();
      await edit(workspace);
      await workspace.setContext(contextB);
      if (kind === "schema") {
        fields.list.mockResolvedValue([{ ...field, type: "integer" }]);
      } else {
        records.find.mockResolvedValue(record(contextA.spaceId, "外部更新", "v2"));
      }
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
