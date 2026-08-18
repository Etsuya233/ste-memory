/**
 * 记录网格冒烟测试（react-dom/server renderToString，无 jsdom——沿用 spec 测试
 * 决策）：验证「状态 → DOM」投影契约——表头（字段名/必填标记/停用徽标/行号列）、
 * 行号列（已有记录按钮 + 新行 + 号、保存中转圈、行高把手）、查看模式文本单元格、
 * 编辑模式输入 data-stm-field、行底错误条；完整交互（拖拽调宽高/批量保存/校验）
 * 由真机验收脚本 verify-record-crud.mjs 覆盖。
 */
import type { MemoryField, MemoryRecord } from "@ste-memory/core/memory";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GridEditor } from "./grid-editor.tsx";
import {
  defaultGridColumnWidths,
  emptyGridRow,
  gridRowsFromRecords,
  type GridColumnWidths,
  type GridRowHeights,
} from "./grid-editor-model.ts";
import type { GridRowErrors } from "./grid-editor-model.ts";
function field(
  overrides: Partial<Omit<MemoryField, "id" | "key">> & { readonly key?: string },
): MemoryField {
  return {
    id: `field-${overrides.key ?? "x"}` as MemoryField["id"],
    memorySpaceId: "space-1" as MemoryField["memorySpaceId"],
    tableId: "table-1" as MemoryField["tableId"],
    key: (overrides.key ?? "name") as MemoryField["key"],
    name: "名称",
    type: "short_text",
    required: false,
    prompt: "",
    enabled: true,
    position: 0,
    options: [],
    referenceTableId: null,
    maxChars: null,
    valuePattern: null,
    valuePatternMessage: null,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    ...(overrides as object),
  };
}

const fields: readonly MemoryField[] = [
  field({ key: "name", name: "名字", required: true }),
  field({ key: "note", name: "备注", type: "long_text", enabled: false }),
];

const widths: GridColumnWidths = defaultGridColumnWidths(fields);

function render(props: Partial<Parameters<typeof GridEditor>[0]> = {}) {
  return renderToString(
    <GridEditor
      fields={fields}
      rows={[]}
      errors={{}}
      commitErrors={{}}
      widths={widths}
      heights={{} as GridRowHeights}
      editingKey={null}
      focusFieldId={null}
      dirtyRowKeys={new Set()}
      savingRowKeys={new Set()}
      referenceRecords={new Map()}
      onValueChange={() => {}}
      onOpenRecord={() => {}}
      onEditRow={() => {}}
      onRevertRow={() => {}}
      onResizeRowNumber={() => {}}
      onResizeField={() => {}}
      onResizeRowHeight={() => {}}
      {...props}
    />,
  );
}

const sampleRecord: MemoryRecord = {
  id: "record-1" as MemoryRecord["id"],
  memorySpaceId: "space-1" as MemoryRecord["memorySpaceId"],
  tableId: "table-1" as MemoryRecord["tableId"],
  payload: { "field-name": "阿尔法" },
  fieldEvidence: {},
  displayText: "阿尔法",
  source: { type: "manual" },
  revisionId: "rev-1" as MemoryRecord["revisionId"],
  revisionSource: "user",
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
};

describe("GridEditor（记录网格投影）", () => {
  it("表头：行号列 + 字段名 + 必填标记 + 停用徽标 + 列宽把手", () => {
    const html = render();
    expect(html).toContain("stm-grid-rownum");
    expect(html).toContain("名字");
    expect(html).toContain("stm-field-required");
    expect(html).toContain("备注");
    expect(html).toContain("停用");
    // 行号列 + 每个字段列都有可调宽把手（可访问性 label）
    expect(html.match(/role="separator"/g)).toHaveLength(3);
    expect(html).toContain("调整行号列宽");
    expect(html).toContain("调整列宽：名字");
    // 列宽进入 grid 模板（SSR 序列化为 kebab-case）
    expect(html).toContain("grid-template-columns");
  });

  it("数据行（查看模式默认）：行号按钮 + 查看文本单元格（含 data-stm-field），无输入控件", () => {
    const rows = gridRowsFromRecords(fields, [sampleRecord]);
    const html = render({ rows });
    expect(html).toContain('data-action="open-record"');
    expect(html).toContain('data-record-id="record-1"');
    expect(html).toContain("查看记录 1");
    expect(html).toContain("stm-grid-cell--view");
    expect(html).toContain('data-stm-field="record-value-name"');
    expect(html).toContain("阿尔法");
    // 查看文本行数按行高计算：默认行高 60px → -webkit-line-clamp: 3（拖高后递增）
    expect(html).toContain("-webkit-line-clamp:3");
    // 停用字段单元格：查看文本（无输入控件）
    expect(html).not.toContain("stm-grid-readonly");
    expect(html).not.toContain("<textarea");
    // 查看模式不渲染编辑控件
    expect(html).not.toContain('type="text"');
  });

  it("数据行（编辑模式）：单元格渲染输入控件 + 行高把手", () => {
    const rows = gridRowsFromRecords(fields, [sampleRecord]);
    const html = render({ rows, editingKey: "record-1", focusFieldId: "field-name" });
    expect(html).toContain('data-stm-field="record-value-name"');
    expect(html).toContain("stm-grid-cell--input");
    expect(html).toContain("stm-grid-row-resize");
    // 点击进编辑的那个字段自动聚焦（其余控件不聚焦）
    expect(html).toContain('autofocus=""');
  });

  it("新行：行号列显示 + 号（无 open-record 按钮）", () => {
    const html = render({ rows: [emptyGridRow(fields, "new-1")] });
    expect(html).toContain('data-grid-row="new"');
    expect(html).toContain("stm-grid-rownum--new");
    expect(html).not.toContain('data-action="open-record"');
  });

  it("已修改行：单元格带脏标记类；保存中的行：行号格替换为转圈", () => {
    const rows = gridRowsFromRecords(fields, [sampleRecord]);
    const html = render({
      rows,
      dirtyRowKeys: new Set(["record-1"]),
      savingRowKeys: new Set(["record-1"]),
    });
    expect(html).toContain("stm-grid-cell--dirty");
    expect(html).toContain("stm-grid-rownum-saving");
    expect(html).not.toContain('data-action="open-record"');
    expect(html).toContain("fa-spinner");
  });

  it("校验/提交错误显示在行底错误条（跨整行宽），错误行无单元格内错误", () => {
    const errors: GridRowErrors = { "new-1": { "field-name": "请填写「名字」" } };
    const html = render({
      rows: [emptyGridRow(fields, "new-1")],
      errors,
      commitErrors: { "new-1": "保存失败：记录已在别处更新" },
    });
    expect(html).toContain("stm-grid-row-errors");
    expect(html).toContain("保存失败：记录已在别处更新");
    expect(html).toContain("请填写「名字」");
    expect(html).not.toContain("stm-grid-cell--error");
    expect(html).not.toContain("stm-grid-error");
  });
});
