import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MemorySpaceId } from "../../features/memory/index.ts";
import type {
  SqlConsole,
  SqlExecutionResult,
  SqlSchemaEntry,
} from "../../features/sql-console/sql-console.ts";
import { SqlPanel } from "./sql-panel.tsx";
import { SqlResults } from "./sql-results.tsx";
import { SqlSchema } from "./sql-schema.tsx";

const spaceId = "space-1" as MemorySpaceId;
const consoleStub: SqlConsole = {
  execute: vi.fn(async () => ({
    results: [],
    changes: 0,
    transactionOpen: false,
    elapsedMs: 0,
  })),
  schema: vi.fn(async () => []),
};

function renderPanel(overrides: { spaceId?: MemorySpaceId | null } = {}) {
  return renderToString(
    <SqlPanel
      console={consoleStub}
      spaceId={overrides.spaceId === undefined ? spaceId : overrides.spaceId}
      active={false}
      dataVersion={0}
      onExecuted={vi.fn()}
    />,
  );
}

describe("SQL 控制台界面", () => {
  it("编辑器是主区域，表结构栏保留搜索与执行钩子", () => {
    const html = renderPanel();
    expect(html).toContain('data-action="sql-input"');
    expect(html).toContain('data-action="sql-execute"');
    expect(html).toContain("stm-sql-gutter");
    expect(html).toContain("修改仅作用于本次加载，不自动保存为记忆快照。");
    expect(html).toContain("搜索表或字段");
    expect(html.indexOf("stm-sql-editor")).toBeLessThan(html.indexOf("stm-sql-schema"));
  });

  it("未绑定空间时提示原因并禁用执行", () => {
    const html = renderPanel({ spaceId: null });
    expect(html).toContain("请先绑定有效记忆空间。");
    expect(html).toMatch(/<button[^>]*data-action="sql-execute"[^>]*disabled/);
  });

  it("表结构展示字段、建表 SQL 与加载状态", () => {
    const entries: readonly SqlSchemaEntry[] = [
      {
        name: "人物",
        type: "table",
        sql: 'CREATE TABLE "人物"("姓名" TEXT)',
        columns: [
          { name: "姓名", type: "TEXT" },
          { name: "年龄", type: "INTEGER" },
        ],
      },
    ];
    const html = renderToString(
      <SqlSchema
        entries={entries}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
        onInsert={vi.fn()}
        onQuery={vi.fn()}
      />,
    );
    expect(html).toContain("人物");
    expect(html).toContain("姓名");
    expect(html).toMatch(/2(?:<!-- -->)? 列/);
    expect(html).toContain("建表 SQL");
    expect(html).toContain("CREATE TABLE");
    expect(html).toContain('aria-label="刷新表结构"');

    const loading = renderToString(
      <SqlSchema
        entries={[]}
        loading
        error={null}
        onRefresh={vi.fn()}
        onInsert={vi.fn()}
        onQuery={vi.fn()}
      />,
    );
    expect(loading).toContain("正在读取表结构…");

    const failure = renderToString(
      <SqlSchema
        entries={[]}
        loading={false}
        error="读取表结构失败"
        onRefresh={vi.fn()}
        onInsert={vi.fn()}
        onQuery={vi.fn()}
      />,
    );
    expect(failure).toContain("读取表结构失败");
    expect(failure).not.toContain("当前空间没有可浏览的 SQLite 对象。");
  });
});

describe("SQL 执行结果", () => {
  const execution: SqlExecutionResult = {
    results: [
      {
        columns: ["id", "name", "note"],
        rows: [
          [1, "爱丽丝", null],
          [2, "鲍勃", new Uint8Array([1, 2])],
        ],
      },
      { columns: ["total"], rows: [[3]] },
    ],
    changes: 5,
    transactionOpen: true,
    elapsedMs: 12.6,
  };
  const result = {
    sql: "SELECT * FROM 人物;",
    execution,
    version: 1,
    at: "2026-10-24 23:00",
  };

  it("汇总统计并支持多个结果集切换", () => {
    const html = renderToString(<SqlResults result={result} dataVersion={2} />);
    expect(html).toContain("data-sql-results");
    expect(html).toMatch(/结果 (?:<!-- -->)?1/);
    expect(html).toMatch(/结果 (?:<!-- -->)?2/);
    expect(html).toMatch(/3(?:<!-- -->)? 行/);
    expect(html).toMatch(/5(?:<!-- -->)? 行变更/);
    expect(html).toMatch(/13(?:<!-- -->)? ms/);
    expect(html).toContain("NULL");
    expect(html).toContain("0102");
    expect(html).toContain("stm-sql-cell--number");
    expect(html).toContain("复制 JSON");
    expect(html).toContain("本次执行 SQL");
  });

  it("事务未提交与数据变化分别提示", () => {
    const html = renderToString(<SqlResults result={result} dataVersion={2} />);
    expect(html).toContain("事务尚未提交，可继续执行 COMMIT 或 ROLLBACK。");
    expect(html).toContain("数据已变化，请重新执行。");
  });

  it("空结果集保留列头，无返回集时给出完成提示", () => {
    const emptySet = renderToString(
      <SqlResults
        result={{
          sql: "SELECT 1 AS value WHERE 0;",
          execution: {
            results: [{ columns: ["value"], rows: [] }],
            changes: 0,
            transactionOpen: false,
            elapsedMs: 1,
          },
          version: 0,
          at: "2026-10-24 23:00",
        }}
        dataVersion={0}
      />,
    );
    expect(emptySet).toContain("<th");
    expect(emptySet).toContain("没有结果行。");

    const noSets = renderToString(
      <SqlResults
        result={{
          sql: "CREATE TABLE example(value TEXT);",
          execution: { results: [], changes: 0, transactionOpen: false, elapsedMs: 1 },
          version: 0,
          at: "2026-10-24 23:00",
        }}
        dataVersion={0}
      />,
    );
    expect(noSets).toContain("执行完成，无结果集。");
  });
});

it("console accepts ordinary and semantic SQL through one editor and offers vector group examples", () => {
  const html = renderToString(
    <SqlPanel
      console={consoleStub}
      spaceId={spaceId}
      active={false}
      dataVersion={0}
      onExecuted={vi.fn()}
    />,
  );
  expect(html).not.toContain("SQL 执行模式");
  expect(html).toContain("semantic_scores");
  expect(html).not.toContain(":last_user_message");
  expect(html).not.toContain("自动使用当前对话");
  const schema = renderToString(
    <SqlSchema
      entries={[
        {
          name: "facts",
          type: "table",
          sql: null,
          columns: [{ name: "content", type: "TEXT" }],
          vectorGroups: ["event_memory"],
        },
      ]}
      loading={false}
      error={null}
      onRefresh={vi.fn()}
      onInsert={vi.fn()}
      onQuery={vi.fn()}
    />,
  );
  expect(schema).toContain("向量组");
  expect(schema).toContain("event_memory");
});
