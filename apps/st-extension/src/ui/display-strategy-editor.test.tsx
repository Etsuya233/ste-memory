/**
 * 显示策略编辑器冒烟测试（react-dom/server renderToString，无 jsdom）。
 * useEffect 在 SSR 不执行 → 预览区渲染「无记录/加载失败/策略无效」静态态；
 * 校验与摘要等纯逻辑在 display-strategy-model.test 覆盖。
 */
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  MemoryField,
  MemoryFieldId,
  MemoryFieldKey,
  MemoryRecord,
  MemorySpaceId,
  MemoryTableId,
} from "@ste-memory/core/memory";
import { emptyDisplayStrategyDraft } from "./display-strategy-model.ts";
import { DisplayStrategyEditor } from "./display-strategy-editor.tsx";

function field(id: string, type: MemoryField["type"] = "short_text"): MemoryField {
  return {
    id: id as MemoryFieldId,
    memorySpaceId: "space-1" as MemorySpaceId,
    tableId: "table-1" as MemoryTableId,
    key: id as MemoryFieldKey,
    name: id,
    type,
    required: false,
    prompt: "",
    enabled: true,
    position: 0,
    options: [],
    referenceTableId: null,
    maxChars: null,
    valuePattern: null,
    valuePatternMessage: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  } as MemoryField;
}

function record(id: string): MemoryRecord {
  return {
    id: id as MemoryRecord["id"],
    memorySpaceId: "space-1" as MemorySpaceId,
    tableId: "table-1" as MemoryTableId,
    payload: { "field-name": "顾川" },
    fieldEvidence: {},
    displayText: "顾川",
    source: { type: "manual" },
    revisionId: "revision-1" as MemoryRecord["revisionId"],
    revisionSource: "user",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

function renderEditor(
  overrides: Partial<Parameters<typeof DisplayStrategyEditor>[0]> = {},
): string {
  const props: Parameters<typeof DisplayStrategyEditor>[0] = {
    title: "显示策略",
    initial: emptyDisplayStrategyDraft({ type: "field", fieldId: "field-name" as MemoryFieldId }),
    fields: [field("field-name"), field("field-note", "long_text")],
    previewRecords: [],
    previewError: null,
    computePreview: vi.fn(async () => ""),
    saving: false,
    onSave: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  return renderToString(<DisplayStrategyEditor {...props} />);
}

describe("DisplayStrategyEditor（显示策略编辑器投影）", () => {
  it("field 策略：类型选择 + 短文本字段下拉 + 保存按钮（无记录时预览空状态）", () => {
    const html = renderEditor();
    expect(html).toContain('data-stm-editor="display-strategy"');
    expect(html).toContain('data-stm-field="display-strategy-type"');
    expect(html).toContain('data-stm-field="display-strategy-field"');
    expect(html).toContain("field-name");
    expect(html).toContain('data-action="editor-submit"');
    expect(html).toContain("该表还没有记录");
  });

  it("template 策略：模板输入 + 插入引用 chip + 预览区", () => {
    const html = renderEditor({
      initial: emptyDisplayStrategyDraft({ type: "template", template: "{field-name}" }),
    });
    expect(html).toContain('data-stm-field="display-strategy-template"');
    expect(html).toContain('data-action="insert-field-ref"');
    expect(html).toContain("{field-name}");
    expect(html).toContain("显示效果预览");
  });

  it("有记录但草稿无效：预览区显示「策略无效，无法预览」", () => {
    const html = renderEditor({
      initial: emptyDisplayStrategyDraft(null),
      previewRecords: [record("record-1")],
    });
    expect(html).toContain('data-stm-field="display-strategy-preview-invalid"');
    expect(html).toContain("当前策略无效，无法预览");
    // 无效草稿：保存按钮禁用
    expect(html).toContain('data-action="editor-submit"');
    expect(html).toContain("disabled");
  });

  it("预览加载失败：显示错误提示而非空状态", () => {
    const html = renderEditor({ previewError: "记录加载失败" });
    expect(html).toContain('data-stm-field="display-strategy-preview-error"');
    expect(html).toContain("记录加载失败");
  });

  it("校验错误文案可见（未选显示字段）", () => {
    const html = renderEditor({ initial: emptyDisplayStrategyDraft(null) });
    expect(html).toContain('data-stm-field="display-strategy-error"');
    expect(html).toContain("请选择当前表中已启用的短文本字段");
  });
});
