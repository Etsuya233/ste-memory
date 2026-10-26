import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  MacroExecutionResult,
  MacroMigrationConflict,
  MemoryMacroService,
} from "../../features/macros/memory-macro-service.ts";
import type { MemoryMacro } from "../../features/macros/macro-expression.ts";
import { ExpressionMacroEditor } from "./expression-macro-editor.tsx";
import { ExpressionMacrosManager } from "./expression-macros-manager.tsx";
import { PresetMacrosEditor } from "./preset-macros-editor.tsx";
const macro: MemoryMacro = {
  id: "m1",
  name: "相关记忆",
  enabled: false,
  expression: {
    language: "query",
    query: {
      table: "events",
      fields: ["summary", "$similarity"],
      semantic: { groups: ["event_memory"], query: { context: "last_user_message" } },
      orderBy: { field: "$similarity", direction: "desc" },
      limit: 10,
    },
  },
  output: { format: "json", maxChars: 4000 },
};
const actual: MacroExecutionResult = {
  id: "m1",
  name: macro.name,
  scope: "chat",
  status: "success",
  text: "真实生成的已保存结果",
  error: null,
  startedAt: "2026-10-26T00:00:00Z",
  elapsedMs: 123,
  resultRows: 3,
  outputRows: 2,
  truncated: true,
  diagnostics: [{ coverage: { ready: 4, expected: 6 }, calls: 1 }],
};
function service() {
  return {
    subscribe: vi.fn(() => () => undefined),
    skip: vi.fn(),
    getRecentResults: vi.fn(() => [actual]),
    testMacro: vi.fn(async () => actual),
    getMigrationError: vi.fn((): string | null => null),
    getMigrationConflicts: vi.fn((): readonly MacroMigrationConflict[] => []),
    resolveMigrationConflict: vi.fn(async () => undefined),
  } satisfies Pick<
    MemoryMacroService,
    | "subscribe"
    | "skip"
    | "getRecentResults"
    | "testMacro"
    | "getMigrationError"
    | "getMigrationConflicts"
    | "resolveMigrationConflict"
  >;
}
function readable(html: string) {
  return html.replaceAll("<!-- -->", "");
}
describe("表达式宏界面", () => {
  it("打开最近结果只读，保持真实执行诊断并提示网络成本和作用域覆盖", () => {
    const port = service();
    const readTables = vi.fn(async () => []);
    const html = readable(
      renderToString(
        <ExpressionMacrosManager
          scope="chat"
          prefix="ste"
          spaceId="space"
          macros={[macro]}
          otherNames={[macro.name]}
          service={port}
          readTables={readTables}
          readFields={async () => []}
          onChange={() => undefined}
        />,
      ),
    );
    expect(html).toContain("真实生成的已保存结果");
    expect(html).toContain("123.0 ms");
    expect(html).toContain("查询 3 行");
    expect(html).toContain("输出 2 行");
    expect(html).toContain("coverage");
    expect(html).toContain("覆盖同名全局宏");
    expect(html).toContain("停用高优先级同名宏后仍占位");
    expect(html).toContain("请求 embedding");
    expect(port.testMacro).not.toHaveBeenCalled();
    expect(readTables).not.toHaveBeenCalled();
  });
  it("SQL 源声明与正文同页编辑，测试输入显式填写且不自动执行", () => {
    const onTest = vi.fn(async () => actual);
    const sqlMacro: MemoryMacro = {
      ...macro,
      expression: {
        language: "sql",
        sources: [
          {
            name: "related",
            table: "events",
            groups: ["event_memory"],
            query: { context: "last_user_message" },
          },
        ],
        sql: "SELECT summary, score FROM events JOIN related ON events.id = related.record_id ORDER BY score DESC LIMIT 10",
      },
    };
    const html = readable(
      renderToString(
        <ExpressionMacroEditor
          initial={sqlMacro}
          names={[macro.name]}
          tables={[
            {
              key: "events",
              name: "事件",
              fields: [{ key: "summary", name: "摘要" }],
              groups: [{ key: "event_memory", name: "事件组" }],
            },
          ]}
          scope="global"
          onSave={() => undefined}
          onCancel={() => undefined}
          onTest={onTest}
          recent={actual}
        />,
      ),
    );
    expect(html).toContain("语义源 sources JSON");
    expect(html).toContain("SQL 正文");
    expect(html).toContain("ORDER BY score DESC LIMIT 10");
    expect(html).toContain("last_user_message 测试文本");
    expect(html).toContain("显式测试结果");
    expect(html).toContain("真实生成的已保存结果");
    expect(html).toContain("event_memory");
    expect(html).toContain("$similarity");
    expect(html).not.toContain("Top K");
    expect(onTest).not.toHaveBeenCalled();
  });
  it("迁移冲突保留来源与两份定义，提供保留、覆盖、改名入口", () => {
    const port = service();
    port.getMigrationConflicts = vi.fn(() => [
      {
        name: macro.name,
        source: "旧对话 A",
        existing: macro,
        legacy: { ...macro, id: "old", enabled: true },
      },
    ]);
    const html = renderToString(
      <ExpressionMacrosManager
        scope="chat"
        prefix="ste"
        spaceId="space"
        macros={[macro]}
        otherNames={[]}
        service={port}
        readTables={async () => []}
        readFields={async () => []}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("旧对话 A");
    expect(html).toContain("保留空间定义");
    expect(html).toContain("覆盖为旧定义");
    expect(html).toContain("改名导入");
    expect(html).toContain("此对话的该名称在处理前展开为空");
    expect(port.resolveMigrationConflict).not.toHaveBeenCalled();
  });
  it("预设只读展示宏表达式和新副本语义默认停用说明", () => {
    const html = renderToString(
      <PresetMacrosEditor
        validate={vi.fn(async () => {})}
        macros={[macro]}
        tables={[]}
        readonly
        onChange={() => undefined}
        onDirtyChange={() => undefined}
      />,
    );
    expect(html).toContain("预设对话宏");
    expect(html).toContain("event_memory");
    expect(html).toContain("新副本中默认停用");
    expect(html).toMatch(/disabled=""[^>]*>编辑宏/);
  });
  it("损坏的旧宏明确显示迁移暂停，执行中提供跳过入口", () => {
    const port = service();
    port.getMigrationError.mockReturnValue("旧宏版本无法识别");
    port.getRecentResults.mockReturnValue([{ ...actual, status: "running", text: "" }]);
    const html = renderToString(
      <ExpressionMacrosManager
        scope="chat"
        prefix="ste"
        spaceId="space"
        macros={[macro]}
        otherNames={[]}
        service={port}
        readTables={async () => []}
        readFields={async () => []}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("旧宏版本无法识别");
    expect(html).toContain("原始数据保持原值");
    expect(html).toContain("此对话的命名宏暂停展开");
    expect(html).toContain("跳过本次计算");
    expect(port.skip).not.toHaveBeenCalled();
  });
});
