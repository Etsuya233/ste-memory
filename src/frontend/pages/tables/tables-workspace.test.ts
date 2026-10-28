import { describe, expect, it, vi } from "vitest";
import {
  MemoryCommitPersistenceError,
  type MemoryTable,
  type MemorySpaceId,
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
    },
    assertContext: vi.fn(),
    onChanged: vi.fn(),
    retryMemorySave: vi.fn().mockResolvedValue(undefined),
  };
  return { services, workspace: new TablesWorkspace(services) };
}
describe("TablesWorkspace", () => {
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
