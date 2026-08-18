import type {
  MemoryFieldId,
  MemoryFieldKey,
  MemoryRecord,
  MemoryRecordId,
  MemoryRecordPayload,
  MemorySpaceId,
  MemoryTableId,
  MemoryTableKey,
} from "@ste-memory/core/memory";
import type { MemoryFieldDigest } from "@ste-memory/core/memory/agent";
import { describe, expect, it } from "vitest";
import type { MemoryView } from "../settings/memory-views.ts";
import { renderMemoryViewSnapshot, sanitizeMacroSyntax } from "./memory-view-render.ts";

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

function field(key: string, overrides: Partial<MemoryFieldDigest> = {}): MemoryFieldDigest {
  return {
    id: `field-${key}` as MemoryFieldId,
    key: key as MemoryFieldKey,
    name: key,
    type: "short_text",
    required: false,
    options: [],
    referenceTableKey: null,
    maxChars: null,
    valuePatternMessage: null,
    ...overrides,
  };
}

const FIELDS: readonly MemoryFieldDigest[] = [
  field("name", { name: "名称" }),
  field("status", { name: "状态", type: "single_select", options: ["埋设中", "已触发"] }),
  field("owner", {
    name: "关联人物",
    type: "single_reference",
    referenceTableKey: "characters" as MemoryTableKey,
  }),
  field("cast", {
    name: "登场角色",
    type: "multi_reference",
    referenceTableKey: "characters" as MemoryTableKey,
  }),
  field("notes", { name: "备注", type: "long_text" }),
];

function record(id: string, displayText: string, payload: MemoryRecordPayload = {}) {
  return {
    id: id as MemoryRecordId,
    memorySpaceId: "space-1" as MemorySpaceId,
    tableId: "table-plots" as MemoryTableId,
    payload,
    fieldEvidence: {},
    displayText,
    source: { type: "manual" as const },
    revisionId: "r" as never,
    revisionSource: "user" as const,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  } satisfies MemoryRecord;
}

const REFERENCE_LABELS = new Map<MemoryRecordId, string>([
  ["char-1" as MemoryRecordId, "张三"],
  ["char-2" as MemoryRecordId, "李四"],
]);

function render(input: Partial<Parameters<typeof renderMemoryViewSnapshot>[0]> = {}): string {
  return renderMemoryViewSnapshot({
    view: view(),
    fields: FIELDS,
    records: [
      record("r1", "伏笔一", {
        "field-name": "深夜的钟声",
        "field-status": "埋设中",
        "field-owner": "char-1",
        "field-notes": "第一行\n第二行",
      }),
      record("r2", "伏笔二", {
        "field-name": "断剑",
        "field-status": "",
        "field-owner": "char-missing",
      }),
    ],
    referenceLabels: REFERENCE_LABELS,
    limit: 2000,
    ...input,
  });
}

describe("renderMemoryViewSnapshot（视图快照渲染）", () => {
  it("有投影：「字段名：值」按视图字段顺序拼接，空值省略", () => {
    const text = render();
    expect(text).toBe("名称：深夜的钟声，状态：埋设中\n名称：断剑");
    expect(text).not.toContain("备注"); // 未投影字段不出现
  });

  it("引用字段：显示为目标记录显示文本（未知 id 显示原 id）", () => {
    const text = render({ view: view({ projection: ["owner"] }) });
    expect(text).toBe("关联人物：张三\n关联人物：char-missing");
  });

  it("多引用字段：顿号拼接目标显示文本", () => {
    const text = render({
      records: [record("r1", "x", { "field-cast": ["char-1", "char-2", "char-missing"] })],
      view: view({ projection: ["cast"] }),
    });
    expect(text).toBe("登场角色：张三、李四、char-missing");
  });

  it("长文本值单行化；布尔是/否；列表顿号拼接", () => {
    const text = render({
      view: view({ projection: ["notes", "done", "tags"] }),
      fields: [
        field("notes", { name: "备注", type: "long_text" }),
        field("done", { name: "完成", type: "boolean" }),
        field("tags", { name: "标签", type: "short_text_list" }),
      ],
      records: [
        record("r1", "x", {
          "field-notes": "多行\n文本",
          "field-done": true,
          "field-tags": ["a", "b"],
        }),
        record("r2", "x", { "field-done": false }),
      ],
    });
    expect(text).toBe("备注：多行 文本，完成：是，标签：a、b\n完成：否");
  });

  it("无投影：显示文本单行化（无「字段名：」前缀、无分组标题）", () => {
    const text = render({
      view: view({ projection: [] }),
      records: [record("r1", "伏笔一\n（细节）", {}), record("r2", "伏笔二", {})],
    });
    expect(text).toBe("伏笔一 （细节）\n伏笔二");
    expect(text).not.toContain("【");
  });

  it("全部值空白的记录：省略该行（不产生空行）", () => {
    const text = render({
      records: [record("r1", "x", { "field-name": "", "field-status": null })],
      view: view({ projection: ["name", "status"] }),
    });
    expect(text).toBe("");
  });

  it("字符上限：全局 macroLimit 兜底尾部截断 + 标记", () => {
    const text = render({ limit: 8 });
    expect(text.endsWith("……（已截断）")).toBe(true);
    expect([...text].length).toBe(8);
  });

  it("输出不含 {{...}}（宏语法消毒，避免二次 substituteParams）", () => {
    const text = render({
      records: [
        record("r1", "含 {{char}} 的显示文本", { "field-name": "含 {{user}} 的值" }),
        record("r2", "尾部 }} 残留", {}),
      ],
    });
    expect(text).not.toContain("{{");
    expect(text).not.toContain("}}");
  });
});

describe("sanitizeMacroSyntax", () => {
  it("替换 {{ 与 }} 序列，其余字符原样", () => {
    expect(sanitizeMacroSyntax("a {{x}} b")).toBe("a 〔{x}〕 b");
    expect(sanitizeMacroSyntax("普通文本 {单括号}")).toBe("普通文本 {单括号}");
  });
});
