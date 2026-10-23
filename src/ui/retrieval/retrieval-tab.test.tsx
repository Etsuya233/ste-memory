import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MemorySpaceId } from "../../features/memory/index.ts";
import type { RetrievalState } from "../../features/vector-retrieval/vector-retrieval-service.ts";
import { RetrievalTab } from "./retrieval-tab.tsx";

function renderSearch(state: Partial<RetrievalState> = {}) {
  const snapshot: RetrievalState = {
    epoch: 0,
    dataVersion: 0,
    status: "idle",
    result: null,
    error: null,
    indexUpdated: false,
    request: null,
    calls: 0,
    startedAt: null,
    elapsedMs: null,
    ...state,
  };
  return renderToString(
    <RetrievalTab
      service={{
        getState: () => snapshot,
        subscribe: () => () => {},
        ranges: vi.fn(async () => []),
        search: vi.fn(async () => {}),
        cancel: vi.fn(),
      }}
      spaceId={"space-1" as MemorySpaceId}
      connection={undefined}
      onRecord={vi.fn()}
      onIndex={vi.fn()}
      onSettings={vi.fn()}
    />,
  );
}

describe("检索页信息层级", () => {
  it("默认展示查询，搜索选项折叠且保留参数控件", () => {
    const html = renderSearch();
    expect(html.indexOf('data-action="retrieval-query"')).toBeLessThan(
      html.indexOf("data-retrieval-options"),
    );
    expect(html).toMatch(/<details[^>]*data-retrieval-options="true"[^>]*>/);
    expect(html.match(/<details[^>]*data-retrieval-options="true"[^>]*>/)?.[0]).not.toContain(
      " open",
    );
    expect(html).toContain('data-action="retrieval-top-k"');
    expect(html).toContain('data-action="retrieval-threshold"');
    expect(html).toContain('data-action="retrieval-search"');
  });

  it("结果区域保留，诊断折叠且索引不完整提示可见", () => {
    const html = renderSearch({
      status: "done",
      result: {
        request: { query: "渡口", topK: 10, minimumScore: null, selection: null },
        ranges: [],
        profile: "test-profile",
        hits: [],
        message: "没有匹配记录",
        calls: 1,
        coverage: {
          checkedAt: "2026-10-23",
          records: 1,
          expected: 2,
          ready: 1,
          empty: 0,
          missing: 1,
          stale: 0,
          invalid: 0,
          issues: [],
          taskStates: [],
        },
        timing: { check: 1, remote: 2, sort: 1, total: 4 },
      },
    });
    expect(html).toContain("data-retrieval-results");
    expect(html).toContain("部分索引可用，结果可能遗漏。");
    const diagnostic = html.match(/<details[^>]*data-retrieval-diagnostics="true"[^>]*>/)?.[0];
    expect(diagnostic).toBeDefined();
    expect(diagnostic).not.toContain(" open");
    expect(html).toContain("test-profile");
    expect(html).toContain("没有匹配记录");
  });
});
