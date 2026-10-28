import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MemoryRecord, MemoryField } from "../../features/memory/index.ts";
import { RecordSummaryList } from "./record-summary-list.tsx";

const record = {
  id: "record-1",
  displayText: "河边的约定",
  payload: { name: "河边的约定", note: "保留来源与修订历史", disabled: "不应预览" },
} as unknown as MemoryRecord;
const fields = [
  { id: "name", type: "short_text", enabled: true },
  { id: "note", type: "long_text", enabled: true },
  { id: "disabled", type: "short_text", enabled: false },
] as unknown as MemoryField[];

describe("RecordSummaryList", () => {
  it("uses an accessible list with one actual navigation button per record", () => {
    const html = renderToStaticMarkup(
      <RecordSummaryList
        records={[record]}
        fields={fields}
        referenceLabels={new Map()}
        vectorSummaries={new Map([[record.id, "已索引"]])}
        onOpenRecord={() => {}}
      />,
    );
    expect(html).toContain('role="list"');
    expect(html).toContain('role="listitem"');
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    expect(html).toContain('data-action="open-record"');
    expect(html).toContain('data-record-id="record-1"');
    expect(html).toContain("河边的约定");
    expect(html).toContain("保留来源与修订历史");
    expect(html).toContain("已索引");
    expect(html).not.toContain("不应预览");
  });

  it("keeps a blank display value navigable with an accessible fallback", () => {
    const html = renderToStaticMarkup(
      <RecordSummaryList
        records={[{ ...record, displayText: "" }]}
        fields={[]}
        referenceLabels={new Map()}
        vectorSummaries={new Map()}
        onOpenRecord={() => {}}
      />,
    );
    expect(html).toContain("未命名记录");
    expect(html).toContain('data-record-id="record-1"');
  });
});
