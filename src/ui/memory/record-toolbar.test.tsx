import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ComponentProps } from "react";
import type { MemoryTable, MemoryTableId } from "../../features/memory/index.ts";
import { RecordToolbar } from "./record-toolbar.tsx";

const props: ComponentProps<typeof RecordToolbar> = {
  tables: [
    { id: "table-1", name: "人物", enabled: true },
    { id: "table-2", name: "归档", enabled: false },
  ] as unknown as MemoryTable[],
  selectedTableId: "table-1" as MemoryTableId,
  onSelectTable() {},
  total: 23,
  search: "",
  searchInput: "",
  searchOpen: false,
  onSearchInput() {},
  onSearchOpen() {},
  sortOptions: [{ fieldId: "$created_at", label: "创建时间" }],
  order: { fieldId: "$created_at", direction: "desc" },
  sortLabel: "创建时间",
  onSort() {},
  loading: false,
  viewMode: "list",
  onViewMode() {},
  dirty: false,
  saving: false,
  onDiscard() {},
  onSave() {},
  hidden: false,
};

describe("RecordToolbar", () => {
  it("keeps table selection, sorting and view controls labeled", () => {
    const html = renderToStaticMarkup(<RecordToolbar {...props} />);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="选择表格"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('data-action="select-table"');
    expect(html).toContain('data-table-id="table-2"');
    expect(html.replace(/<[^>]*>/g, "")).toContain("归档（已停用）");
    expect(html).toContain('aria-label="排序：创建时间 · 降序"');
    expect(html).toContain('aria-label="记录显示方式"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-action="records-grid-view"');
  });

  it("retains the hidden toolbar without stealing editor focus", () => {
    const html = renderToStaticMarkup(<RecordToolbar {...props} hidden />);
    expect(html).toContain('hidden=""');
    expect(html).not.toContain('data-action="record-search"');
  });

  it("does not permit discarding or double-saving during a grid commit", () => {
    const html = renderToStaticMarkup(<RecordToolbar {...props} viewMode="grid" dirty saving />);
    expect(html.match(/<button[^>]*data-action="discard-grid"[^>]*>/)?.[0]).toContain("disabled");
    expect(html.match(/<button[^>]*data-action="save-grid"[^>]*>/)?.[0]).toContain("disabled");
    expect(html).toContain("保存中…");
  });
});
