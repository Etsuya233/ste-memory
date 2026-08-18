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
import type {
  MemoryFieldDigest,
  MemorySpaceReader,
  MemorySpaceTableDigest,
  MemoryTableDigest,
} from "@ste-memory/core/memory/agent";
import { describe, expect, it, vi } from "vitest";
import type { MemoryView } from "../settings/memory-views.ts";
import { planMemoryViewQuery, resolveViewReferenceLabels } from "./memory-view-query.ts";

/** 合法视图工厂（各测试只覆盖自己要变的字段） */
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

function digest(overrides: Partial<MemorySpaceTableDigest> = {}): MemorySpaceTableDigest {
  const table: MemoryTableDigest = {
    id: "table-plots" as MemoryTableId,
    key: "plots" as MemoryTableKey,
    name: "伏笔",
    description: "",
    fields: [
      field("name", { name: "名称" }),
      field("status", {
        name: "状态",
        type: "single_select",
        options: ["埋设中", "已触发", "已回收"],
      }),
      field("owner", {
        name: "关联人物",
        type: "single_reference",
        referenceTableKey: "characters" as MemoryTableKey,
      }),
    ],
  };
  return {
    memorySpaceId: "space-1" as MemorySpaceId,
    tables: [
      table,
      {
        id: "table-characters" as MemoryTableId,
        key: "characters" as MemoryTableKey,
        name: "人物",
        description: "",
        fields: [field("name", { name: "名称" })],
      },
    ],
    ...overrides,
  };
}

describe("planMemoryViewQuery（视图 → 记忆查询）", () => {
  it("投影映射 fieldIds、筛选恒用 in、$updated_at desc、pageSize = limit", () => {
    const plan = planMemoryViewQuery(view(), digest());
    expect(plan?.query).toEqual({
      tableId: "table-plots",
      fieldIds: ["field-name", "field-status"],
      conditions: [{ fieldId: "field-status", operator: "in", value: ["埋设中", "已触发"] }],
      order: { fieldId: "$updated_at", direction: "desc" },
      paging: { page: 1, pageSize: 50 },
    });
  });

  it("单值筛选 = 单元素数组（恒用 in）", () => {
    const plan = planMemoryViewQuery(
      view({ condition: { fieldKey: "status", values: ["已回收"] } }),
      digest(),
    );
    expect(plan?.query.conditions).toEqual([
      { fieldId: "field-status", operator: "in", value: ["已回收"] },
    ]);
  });

  it("无筛选/无投影：conditions 省略、fieldIds 省略（返回全部启用字段）", () => {
    const plan = planMemoryViewQuery(view({ condition: null, projection: [] }), digest());
    expect(plan?.query).toEqual({
      tableId: "table-plots",
      order: { fieldId: "$updated_at", direction: "desc" },
      paging: { page: 1, pageSize: 50 },
    });
  });

  it("无条数上限：pageSize 取契约上限 100", () => {
    const plan = planMemoryViewQuery(view({ limit: null }), digest());
    expect(plan?.query.paging).toEqual({ page: 1, pageSize: 100 });
  });

  it("缺表：翻译失败（undefined）", () => {
    expect(planMemoryViewQuery(view({ tableKey: "ghost" }), digest())).toBeUndefined();
    // 表存在但停用：digest 不收录 → 同样失败
    const disabled: MemorySpaceTableDigest = {
      ...digest(),
      tables: digest().tables.filter((t) => t.key !== "plots"),
    };
    expect(planMemoryViewQuery(view(), disabled)).toBeUndefined();
  });

  it("缺字段（含字段 Key 被改名）：翻译失败", () => {
    expect(
      planMemoryViewQuery(view({ condition: { fieldKey: "ghost", values: ["x"] } }), digest()),
    ).toBeUndefined();
    expect(planMemoryViewQuery(view({ projection: ["ghost"] }), digest())).toBeUndefined();
    // 字段停用：digest 不收录 → 同样失败
    const disabled: MemorySpaceTableDigest = {
      ...digest(),
      tables: digest().tables.map((t) => ({
        ...t,
        fields: t.fields.filter((f) => f.key !== "status"),
      })),
    };
    expect(planMemoryViewQuery(view(), disabled)).toBeUndefined();
  });

  it("筛选字段类型不支持（非 single_select/short_text）：翻译失败", () => {
    expect(
      planMemoryViewQuery(view({ condition: { fieldKey: "owner", values: ["x"] } }), digest()),
    ).toBeUndefined();
  });
});

describe("resolveViewReferenceLabels（引用解析补充查询）", () => {
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

  it("投影含引用字段：按目标表 $record_id in 查询，收集 id → 显示文本", async () => {
    const reader: MemorySpaceReader = {
      listTables: vi.fn(),
      listFields: vi.fn(),
      queryRecords: vi.fn(async () => ({
        records: [record("char-1", "张三"), record("char-2", "李四")],
        page: 1,
        pageSize: 2,
        total: 2,
        totalPages: 1,
      })),
    };
    const records = [
      record("r1", "伏笔一", { "field-owner": "char-1" }),
      record("r2", "伏笔二", { "field-owner": "char-2" }),
      record("r3", "伏笔三", { "field-owner": "char-1" }),
    ];
    const labels = await resolveViewReferenceLabels(
      reader,
      "space-1" as MemorySpaceId,
      digest(),
      digest().tables[0]!,
      records,
      ["name", "owner"],
    );
    expect(labels).toEqual(
      new Map([
        ["char-1", "张三"],
        ["char-2", "李四"],
      ]),
    );
    expect(reader.queryRecords).toHaveBeenCalledWith("space-1", {
      tableId: "table-characters",
      conditions: [{ fieldId: "$record_id", operator: "in", value: ["char-1", "char-2"] }],
      paging: { page: 1, pageSize: 2 },
    });
  });

  it("目标表缺失/停用：跳过该字段（不查询，渲染层兜底显示原 id）", async () => {
    const reader: MemorySpaceReader = {
      listTables: vi.fn(),
      listFields: vi.fn(),
      queryRecords: vi.fn(),
    };
    const noTarget: MemorySpaceTableDigest = {
      ...digest(),
      tables: digest().tables.filter((t) => t.key !== "characters"),
    };
    const labels = await resolveViewReferenceLabels(
      reader,
      "space-1" as MemorySpaceId,
      noTarget,
      {
        ...digest().tables[0]!,
        fields: [
          field("owner", {
            type: "single_reference",
            referenceTableKey: "characters" as MemoryTableKey,
          }),
        ],
      },
      [record("r1", "x", { "field-owner": "char-1" })],
      ["owner"],
    );
    expect(labels.size).toBe(0);
    expect(reader.queryRecords).not.toHaveBeenCalled();
  });

  it("多引用字段：数组值收集；引用 id 去重", async () => {
    const reader: MemorySpaceReader = {
      listTables: vi.fn(),
      listFields: vi.fn(),
      queryRecords: vi.fn(async () => ({
        records: [record("char-1", "张三")],
        page: 1,
        pageSize: 1,
        total: 1,
        totalPages: 1,
      })),
    };
    const labels = await resolveViewReferenceLabels(
      reader,
      "space-1" as MemorySpaceId,
      digest(),
      {
        ...digest().tables[0]!,
        fields: [
          field("cast", {
            type: "multi_reference",
            referenceTableKey: "characters" as MemoryTableKey,
          }),
        ],
      },
      [record("r1", "x", { "field-cast": ["char-1", "char-1", "char-2"] })],
      ["cast"],
    );
    expect(labels.get("char-1" as MemoryRecordId)).toBe("张三");
    expect(reader.queryRecords).toHaveBeenCalledTimes(1);
  });

  it("引用 id 超 100：按契约 pageSize 上限分片查询", async () => {
    const reader: MemorySpaceReader = {
      listTables: vi.fn(),
      listFields: vi.fn(),
      queryRecords: vi.fn(async () => ({
        records: [],
        page: 1,
        pageSize: 100,
        total: 0,
        totalPages: 0,
      })),
    };
    const ids = Array.from({ length: 150 }, (_, i) => `char-${i}`);
    await resolveViewReferenceLabels(
      reader,
      "space-1" as MemorySpaceId,
      digest(),
      {
        ...digest().tables[0]!,
        fields: [
          field("owner", {
            type: "single_reference",
            referenceTableKey: "characters" as MemoryTableKey,
          }),
        ],
      },
      [record("r1", "x", { "field-owner": ids })],
      ["owner"],
    );
    expect(reader.queryRecords).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(reader.queryRecords).mock.calls;
    expect(calls[0]![1].paging.pageSize).toBe(100);
    expect(calls[1]![1].paging.pageSize).toBe(50);
  });
});
