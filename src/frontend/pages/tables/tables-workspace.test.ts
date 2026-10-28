import { describe, expect, it, vi } from "vitest";
import {
  MemoryCommitPersistenceError,
  type MemoryTable,
  type MemorySpaceId,
  type MemoryRecord,
  type MemoryRecordPage,
} from "../../../features/memory/index.ts";
import { TablesWorkspace, type TablesServices } from "./tables-workspace.ts";
import type { RecordsContext } from "../records-workspace.ts";
const a: RecordsContext = { chatKey: "a", spaceId: "space-a" as MemorySpaceId, title: "A" };
const b: RecordsContext = { chatKey: "b", spaceId: "space-b" as MemorySpaceId, title: "B" };
const table: MemoryTable = {
  id: "table" as MemoryTable["id"],
  memorySpaceId: a.spaceId,
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
function setup() {
  const services: TablesServices = {
    tables: {
      list: vi.fn().mockResolvedValue([table]),
      create: vi.fn().mockResolvedValue(table),
      update: vi.fn().mockResolvedValue(table),
      delete: vi.fn().mockResolvedValue(true),
    },
    fields: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      setDisplayStrategy: vi.fn(),
    },
    records: { list: vi.fn(), previewDisplayText: vi.fn() },
    vectorIndex: {
      submit: vi.fn(),
      clear: vi.fn(),
      getTableSummary: vi.fn(),
      previewDraftSummary: vi.fn(),
      preview: vi.fn().mockResolvedValue([]),
      previewDraft: vi.fn().mockResolvedValue([]),
    },
    assertContext: vi.fn(),
    onChanged: vi.fn(),
    retryMemorySave: vi.fn().mockResolvedValue(undefined),
  };
  return { services, workspace: new TablesWorkspace(services) };
}
describe("TablesWorkspace", () => {
  const record = {
    id: "r1",
    tableId: table.id,
    memorySpaceId: a.spaceId,
    displayText: "爱丽丝",
  } as MemoryRecord;
  const page = (records: readonly MemoryRecord[] = [record], number = 1): MemoryRecordPage => ({
    records,
    page: number,
    pageSize: 20,
    total: 21,
    totalPages: 2,
  });
  async function previewSetup() {
    const h = setup();
    vi.mocked(h.services.records.list).mockResolvedValue(page());
    await h.workspace.setContext(a);
    await h.workspace.selectTable(table.id);
    return h;
  }
  it("pages record choices and previews saved vector inputs without submitting work", async () => {
    const { services, workspace } = await previewSetup();
    await workspace.openVectorPreview();
    expect(services.records.list).toHaveBeenLastCalledWith(a.spaceId, table.id, {
      page: 1,
      pageSize: 20,
      search: "",
    });
    await workspace.selectVectorRecord(record.id);
    expect(services.vectorIndex.preview).toHaveBeenCalledWith({
      memorySpaceId: a.spaceId,
      tableId: table.id,
      recordId: record.id,
    });
    expect(services.vectorIndex.previewDraft).not.toHaveBeenCalled();
    expect(services.vectorIndex.submit).not.toHaveBeenCalled();
    await workspace.selectVectorRecord(null);
    vi.mocked(services.records.list).mockResolvedValueOnce(page([], 2));
    await workspace.loadVectorRecords(2);
    expect(workspace.getSnapshot().vectorPreview?.page).toBe(2);
    await workspace.loadVectorRecords(1, "爱丽丝");
    expect(services.records.list).toHaveBeenLastCalledWith(a.spaceId, table.id, {
      page: 1,
      pageSize: 20,
      search: "爱丽丝",
    });
  });
  it("previews an unsaved configuration snapshot and returns to the untouched dirty editor", async () => {
    const { services, workspace } = await previewSetup();
    workspace.begin("vector");
    const editor = workspace.getSnapshot().editor!;
    if (editor.kind !== "vector") throw Error("vector editor required");
    workspace.change({
      ...editor,
      draft: {
        ...editor.draft,
        enabled: true,
        source: "custom",
        groups: [{ id: "g", key: "g", name: "人物", fieldIds: [] }],
      },
    });
    const draft = workspace.getSnapshot().editor;
    await workspace.openVectorPreview();
    await workspace.selectVectorRecord(record.id);
    expect(services.vectorIndex.previewDraft).toHaveBeenCalledWith(
      { memorySpaceId: a.spaceId, tableId: table.id, recordId: record.id },
      draft!.draft,
    );
    workspace.closeVectorPreview();
    expect(workspace.getSnapshot().editor).toBe(draft);
    expect(workspace.getSnapshot().editor?.dirty).toBe(true);
    expect(services.tables.update).not.toHaveBeenCalled();
  });
  it("rejects obsolete record-list responses across an A to B to A switch", async () => {
    const { services, workspace } = await previewSetup();
    let finish!: (value: MemoryRecordPage) => void;
    vi.mocked(services.records.list).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = workspace.openVectorPreview();
    await workspace.setContext(b);
    await workspace.setContext(a);
    finish(page([{ ...record, displayText: "过期记录" }]));
    await pending;
    expect(workspace.getSnapshot().vectorPreview?.records?.records[0]?.displayText).toBe("爱丽丝");
    expect(workspace.getSnapshot().vectorPreview?.loading).toBe(false);
  });
  it("ignores a pending group preview when closing or changing its configuration", async () => {
    const { services, workspace } = await previewSetup();
    await workspace.openVectorPreview();
    let finish!: (value: Awaited<ReturnType<TablesServices["vectorIndex"]["preview"]>>) => void;
    vi.mocked(services.vectorIndex.preview).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = workspace.selectVectorRecord(record.id);
    workspace.closeVectorPreview();
    workspace.begin("vector");
    finish([
      {
        groupId: "stale",
        groupName: "旧组",
        input: "旧结果",
        fingerprint: "",
        status: "ready",
        error: null,
      },
    ]);
    await pending;
    expect(workspace.getSnapshot().vectorPreview).toBeNull();
    expect(workspace.getSnapshot().editor?.kind).toBe("vector");
  });
  it("invalidates pending group inputs when the table configuration changes", async () => {
    const { services, workspace } = await previewSetup();
    await workspace.openVectorPreview();
    let finish!: (value: Awaited<ReturnType<TablesServices["vectorIndex"]["preview"]>>) => void;
    vi.mocked(services.vectorIndex.preview).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = workspace.selectVectorRecord(record.id);
    vi.mocked(services.tables.list).mockResolvedValueOnce([
      {
        ...table,
        vectorIndex: { enabled: true, source: "automatic", updateMode: "manual", groups: [] },
      },
    ]);
    await workspace.refresh();
    finish([
      {
        groupId: "old",
        groupName: "旧组",
        input: "过期输入",
        fingerprint: "",
        status: "ready",
        error: null,
      },
    ]);
    await pending;
    expect(workspace.getSnapshot().vectorPreview).toBeNull();
    expect(workspace.getSnapshot().notice).toContain("配置已变化");
  });
  it("retains a failed group preview for retry", async () => {
    const { services, workspace } = await previewSetup();
    await workspace.openVectorPreview();
    vi.mocked(services.vectorIndex.preview).mockRejectedValueOnce(new Error("引用已删除"));
    await workspace.selectVectorRecord(record.id);
    expect(workspace.getSnapshot().vectorPreview?.error).toBe("引用已删除");
    await workspace.selectVectorRecord(record.id);
    expect(workspace.getSnapshot().vectorPreview?.error).toBeNull();
    expect(workspace.getSnapshot().vectorPreview?.groups).toEqual([]);
  });
  it("preserves original schema across chat switches and rejects saving a stale editor", async () => {
    const { services, workspace } = setup();
    await workspace.setContext(a);
    await workspace.selectTable(table.id);
    workspace.begin("table");
    const editor = workspace.getSnapshot().editor!;
    if (editor.kind !== "table") throw new Error("table editor required");
    workspace.change({ ...editor, draft: { ...editor.draft, name: "新名称" } });
    await workspace.setContext(b);
    vi.mocked(services.tables.list).mockResolvedValue([
      { ...table, description: "由其他入口修改" },
    ]);
    await workspace.setContext(a);
    expect(workspace.getSnapshot().editor?.dirty).toBe(true);
    await workspace.save();
    expect(services.tables.update).not.toHaveBeenCalled();
    expect(workspace.getSnapshot().error).toContain("表结构已变化");
  });
  it("does not replay creation after a committed persistence failure", async () => {
    const { services, workspace } = setup();
    await workspace.setContext(a);
    workspace.begin("table");
    vi.mocked(services.tables.create).mockRejectedValue(
      new MemoryCommitPersistenceError(new Error("文件保存失败")),
    );
    await workspace.save();
    expect(workspace.getSnapshot().editor).toBeNull();
    expect(workspace.getSnapshot().persistenceError).toBe("文件保存失败");
    await workspace.retryPersistence();
    await workspace.save();
    expect(services.tables.create).toHaveBeenCalledTimes(1);
    expect(services.retryMemorySave).toHaveBeenCalledTimes(1);
  });
  it("ignores old A reads after an A to B to A switch", async () => {
    const { services, workspace } = setup();
    let resolve!: (value: MemoryTable[]) => void;
    vi.mocked(services.tables.list).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = workspace.setContext(a);
    await workspace.setContext(b);
    await workspace.setContext(a);
    resolve([{ ...table, name: "过期结果" }]);
    await first;
    expect(workspace.getSnapshot().tables[0]?.name).toBe("人物");
  });
  it("checks the live context again after async schema reads before writing", async () => {
    const { services, workspace } = setup();
    await workspace.setContext(a);
    workspace.begin("table");
    let reads = 0;
    vi.mocked(services.assertContext).mockImplementation(() => {
      if (++reads === 2) throw new Error("对话已切换");
    });
    await workspace.save();
    expect(services.tables.create).not.toHaveBeenCalled();
    expect(workspace.getSnapshot().editor).not.toBeNull();
    expect(workspace.getSnapshot().error).toBe("对话已切换");
  });
  it("reports refresh hook failure as committed and closes the editor", async () => {
    const { services, workspace } = setup();
    await workspace.setContext(a);
    workspace.begin("table");
    vi.mocked(services.onChanged).mockRejectedValue(new Error("宏刷新失败"));
    await workspace.save();
    expect(workspace.getSnapshot().editor).toBeNull();
    expect(workspace.getSnapshot().notice).toContain("修改已提交");
    expect(workspace.getSnapshot().error).toBeNull();
  });
});
