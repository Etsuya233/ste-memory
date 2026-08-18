/**
 * 记忆视图管理器冒烟测试（react-dom/server renderToString，无 jsdom——沿用 spec
 * 测试决策）：异步表/字段读取（useEffect）在 SSR 不执行，只验证初始态投影契约
 * （标题/折叠行摘要/新建入口/无空间提示）与编辑器表单（直接渲染组件）的关键
 * data-stm-field / data-action；交互逻辑在 memory-views-manager-model 测试覆盖。
 */
import type { MemoryField, MemoryTable, MemorySpaceId } from "@ste-memory/core/memory";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MemoryView } from "../settings/memory-views.ts";
import { MemoryViewEditor, MemoryViewsManager } from "./memory-views-manager.tsx";
import { memoryViewDraftFromView } from "./memory-views-manager-model.ts";

function view(overrides: Partial<MemoryView> = {}): MemoryView {
  return {
    name: "未完成伏笔",
    tableKey: "plots",
    condition: { fieldKey: "status", values: ["埋设中", "已触发"] },
    limit: 50,
    projection: ["name", "status"],
    ...overrides,
  };
}

function table(key: string, name: string): MemoryTable {
  return {
    id: `table-${key}` as MemoryTable["id"],
    memorySpaceId: "space-1" as MemorySpaceId,
    key: key as MemoryTable["key"],
    kind: "custom",
    name,
    description: "",
    prompt: "",
    displayStrategy: null,
    enabled: true,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

function field(
  key: string,
  type: MemoryField["type"] = "short_text",
  options: readonly string[] = [],
): MemoryField {
  return {
    id: `field-${key}` as MemoryField["id"],
    memorySpaceId: "space-1" as MemorySpaceId,
    tableId: "table-plots" as MemoryTable["id"],
    key: key as MemoryField["key"],
    name: key,
    type,
    required: false,
    prompt: "",
    enabled: true,
    position: 0,
    options,
    referenceTableId: null,
    maxChars: null,
    valuePattern: null,
    valuePatternMessage: null,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

/** renderToString 在相邻文本节点间插入 <!-- --> 分隔注释；剥离后断言可读。 */
function text(html: string): string {
  return html.replaceAll("<!-- -->", "");
}

describe("MemoryViewsManager（记忆视图列表冒烟）", () => {
  it("初始渲染：视图折叠行（名称 + 摘要）+ 新建入口 + 提示就位", () => {
    const html = text(
      renderToString(
        <MemoryViewsManager
          spaceId="space-1"
          readTables={async () => []}
          readFields={async () => []}
          views={[view()]}
          onChange={() => undefined}
        />,
      ),
    );
    expect(html).toContain('data-stm-section="memory-views"');
    expect(html).toContain("未完成伏笔");
    expect(html).toContain("筛选 status ∈ 埋设中、已触发 · 最多 50 条 · 显示 name、status");
    expect(html).toContain('data-action="add-memory-view"');
    expect(html).toContain('data-action="delete-memory-view"');
    expect(html).toContain('data-action="edit-memory-view"');
    expect(html).toContain("{{宏名::视图名}}");
  });

  it("无活动空间：列表可看但新建禁用 + 提示", () => {
    const html = text(
      renderToString(
        <MemoryViewsManager
          spaceId={undefined}
          readTables={async () => []}
          readFields={async () => []}
          views={[view()]}
          onChange={() => undefined}
        />,
      ),
    );
    expect(html).toContain('data-stm-field="memory-views-no-space"');
    expect(html).toContain("当前没有活动记忆空间");
    expect(html).toContain('data-action="add-memory-view" disabled=""');
  });

  it("空视图列表：无行渲染，只有新建入口", () => {
    const html = text(
      renderToString(
        <MemoryViewsManager
          spaceId="space-1"
          readTables={async () => []}
          readFields={async () => []}
          views={[]}
          onChange={() => undefined}
        />,
      ),
    );
    expect(html).not.toContain('data-stm-field="memory-view-');
    expect(html).toContain('data-action="add-memory-view"');
  });
});

describe("MemoryViewEditor（编辑器表单冒烟）", () => {
  it("全部控件就位：名称/表/筛选字段/值（枚举多选）/条数/投影/错误/保存取消", () => {
    const html = text(
      renderToString(
        <MemoryViewEditor
          draft={memoryViewDraftFromView(view())}
          tables={[table("plots", "伏笔")]}
          fields={[field("name"), field("status", "single_select", ["埋设中", "已触发", "已回收"])]}
          error={undefined}
          onDraftChange={() => undefined}
          onSave={() => undefined}
          onCancel={() => undefined}
        />,
      ),
    );
    expect(html).toContain('data-stm-field="memory-view-name"');
    expect(html).toContain('data-stm-field="memory-view-table"');
    expect(html).toContain('data-stm-field="memory-view-condition-field"');
    expect(html).toContain('data-stm-field="memory-view-condition-values"');
    expect(html).toContain('data-action="toggle-condition-value"');
    expect(html).toContain("埋设中");
    expect(html).toContain('data-stm-field="memory-view-limit"');
    expect(html).toContain('data-stm-field="memory-view-projection"');
    expect(html).toContain('data-action="toggle-projection-field"');
    expect(html).toContain('data-action="save-memory-view"');
    expect(html).toContain('data-action="cancel-memory-view"');
    // 已选筛选值勾选态
    expect(html).toContain('checked=""');
  });

  it("short_text 筛选字段：值手输输入框（非多选）", () => {
    const html = text(
      renderToString(
        <MemoryViewEditor
          draft={{ ...memoryViewDraftFromView(view()), conditionFieldKey: "title" }}
          tables={[]}
          fields={[field("title", "short_text")]}
          error={undefined}
          onDraftChange={() => undefined}
          onSave={() => undefined}
          onCancel={() => undefined}
        />,
      ),
    );
    expect(html).toContain('data-stm-field="memory-view-condition-values"');
    expect(html).not.toContain('data-action="toggle-condition-value"');
    expect(html).toContain("逗号分隔");
  });

  it("校验错误文案渲染", () => {
    const html = text(
      renderToString(
        <MemoryViewEditor
          draft={memoryViewDraftFromView(view({ name: "非法 名" }))}
          tables={[]}
          fields={[]}
          error="视图名不能包含空白"
          onDraftChange={() => undefined}
          onSave={() => undefined}
          onCancel={() => undefined}
        />,
      ),
    );
    expect(html).toContain('data-stm-field="memory-view-error"');
    expect(html).toContain("视图名不能包含空白");
  });
});
