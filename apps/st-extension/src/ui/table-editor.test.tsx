/**
 * 表格/字段定义编辑器冒烟测试（renderToString，无 jsdom——沿用面板测试先例）。
 * 编辑器是纯受控表单：本地校验在 model（已单测），这里只验证「草稿 → 标记」投影：
 * 标题/输入字段/类型下拉（含禁用态与提示）/类型相关的配置区切换。
 */
import type {
  MemoryField,
  MemoryFieldId,
  MemoryTable,
  MemoryTableId,
} from "@ste-memory/core/memory";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyFieldDraft, fieldDraftFromField } from "./field-editor-model.ts";
import { EMPTY_TABLE_DRAFT } from "./table-editor-model.ts";
import { FieldEditorForm, TableEditorForm } from "./table-editor.tsx";

function makeTable(id: string, name: string, kind: MemoryTable["kind"] = "custom"): MemoryTable {
  return {
    id: id as MemoryTableId,
    memorySpaceId: "space-1" as MemoryTable["memorySpaceId"],
    key: `key-${id}` as MemoryTable["key"],
    kind,
    name,
    description: "",
    prompt: "",
    enabled: true,
    displayStrategy: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function makeField(overrides: Partial<MemoryField> = {}): MemoryField {
  return {
    id: "field-1" as MemoryFieldId,
    memorySpaceId: "space-1" as MemoryField["memorySpaceId"],
    tableId: "table-1" as MemoryField["tableId"],
    key: "name" as MemoryField["key"],
    name: "名称",
    type: "single_select",
    required: false,
    prompt: "",
    enabled: true,
    position: 0,
    options: ["甲", "乙"],
    referenceTableId: null,
    maxChars: null,
    valuePattern: null,
    valuePatternMessage: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("TableEditorForm（建表/编辑表表单投影）", () => {
  it("渲染标题、四个输入区与保存/取消按钮", () => {
    const html = renderToString(
      <TableEditorForm
        title="新建表格"
        initial={EMPTY_TABLE_DRAFT}
        submitLabel="创建表格"
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("新建表格");
    expect(html).toContain('data-stm-field="table-key"');
    expect(html).toContain('data-stm-field="table-name"');
    expect(html).toContain('data-stm-field="table-description"');
    expect(html).toContain('data-stm-field="table-prompt"');
    expect(html).toContain(">Key <em");
    expect(html).toContain(">名称 <em");
    expect(html).toContain("创建表格");
    expect(html).toContain('data-action="editor-submit"');
    expect(html).toContain('data-action="editor-cancel"');
    expect(html).toContain('data-stm-editor="table"');
  });
});

describe("FieldEditorForm（字段定义编辑器投影）", () => {
  it("新建：渲染 key/名称/12 种类型下拉/必填/启用与 Prompt 区", () => {
    const html = renderToString(
      <FieldEditorForm
        title="新增字段"
        initial={emptyFieldDraft("short_text")}
        existingKeys={[]}
        referenceTables={[makeTable("table-2", "角色档案")]}
        typeLocked={false}
        submitLabel="创建字段"
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("新增字段");
    expect(html).toContain('data-stm-field="field-key"');
    expect(html).toContain('data-stm-field="field-name"');
    expect(html).toContain('data-stm-field="field-type"');
    expect(html).toContain('data-stm-field="field-required"');
    expect(html).toContain('data-stm-field="field-enabled"');
    expect(html).toContain('data-stm-field="field-prompt"');
    // 12 种类型全部出现在下拉里
    for (const label of [
      "短文本",
      "长文本",
      "短文本列表",
      "整数",
      "小数",
      "布尔",
      "日期",
      "日期时间",
      "单选",
      "多选",
      "单引用",
      "多引用",
    ]) {
      expect(html).toContain(label);
    }
    // 新建模式类型可选（不带 disabled）
    const typeSelect = html.match(/<select[^>]*data-stm-field="field-type"[^>]*>/)?.[0] ?? "";
    expect(typeSelect).not.toContain("disabled");
    expect(html).toContain('data-stm-editor="field"');
  });

  it("编辑：类型选择器禁用并提示创建后不可修改", () => {
    const html = renderToString(
      <FieldEditorForm
        title="编辑字段"
        initial={fieldDraftFromField(makeField({ type: "short_text", options: [] }))}
        existingKeys={["age"]}
        referenceTables={[]}
        typeLocked
        submitLabel="保存字段"
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    const typeSelect = html.match(/<select[^>]*data-stm-field="field-type"[^>]*>/)?.[0] ?? "";
    expect(typeSelect).toContain("disabled");
    expect(html).toContain("创建后不可修改");
  });

  it("单选类型：显示固定选项编辑区（每行一个）", () => {
    const html = renderToString(
      <FieldEditorForm
        title="新增字段"
        initial={emptyFieldDraft("single_select")}
        existingKeys={[]}
        referenceTables={[]}
        typeLocked={false}
        submitLabel="创建字段"
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('data-stm-field="field-options"');
    expect(html).toContain("每行一个选项");
    expect(html).not.toContain('data-stm-field="field-reference-table"');
  });

  it("单引用类型：显示引用目标表下拉且包含候选表", () => {
    const html = renderToString(
      <FieldEditorForm
        title="新增字段"
        initial={emptyFieldDraft("single_reference")}
        existingKeys={[]}
        referenceTables={[
          makeTable("table-2", "角色档案"),
          makeTable("table-3", "记忆索引", "system"),
        ]}
        typeLocked={false}
        submitLabel="创建字段"
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('data-stm-field="field-reference-table"');
    expect(html).toContain("角色档案");
    expect(html).toContain("记忆索引");
    expect(html).toContain("（系统表）");
    expect(html).toContain("只能引用当前记忆空间内的表");
    expect(html).not.toContain('data-stm-field="field-options"');
  });

  it("停用必填字段时显示警告文案（本地即时反馈）", () => {
    const html = renderToString(
      <FieldEditorForm
        title="编辑字段"
        initial={{
          ...emptyFieldDraft("short_text"),
          key: "name",
          name: "名称",
          required: true,
          enabled: false,
        }}
        existingKeys={[]}
        referenceTables={[]}
        typeLocked
        submitLabel="保存字段"
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("停用必填字段后，Agent 可能无法创建合法记录");
  });
});
