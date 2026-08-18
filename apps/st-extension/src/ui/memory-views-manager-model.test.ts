import type {
  MemoryField,
  MemoryFieldId,
  MemoryTable,
  MemoryTableId,
  MemorySpaceId,
} from "@ste-memory/core/memory";
import { describe, expect, it } from "vitest";
import type { MemoryView } from "../settings/memory-views.ts";
import {
  emptyMemoryViewDraft,
  isConditionField,
  memoryViewDraftFromView,
  memoryViewFromDraft,
  validateMemoryViewDraft,
  viewConfigErrors,
  viewSummaryText,
} from "./memory-views-manager-model.ts";

function table(key: string, name: string): MemoryTable {
  return {
    id: `table-${key}` as MemoryTableId,
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
    id: `field-${key}` as MemoryFieldId,
    memorySpaceId: "space-1" as MemorySpaceId,
    tableId: "table-plots" as MemoryTableId,
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

describe("memoryViewDraftFromView / emptyMemoryViewDraft / memoryViewFromDraft（草稿往返）", () => {
  it("视图 → 草稿 → 视图：字段无损往返", () => {
    const source = view();
    const draft = memoryViewDraftFromView(source);
    expect(draft).toEqual({
      name: "未完成伏笔",
      tableKey: "plots",
      conditionFieldKey: "status",
      conditionValues: ["埋设中", "已触发"],
      limitText: "50",
      projection: ["name", "status"],
    });
    expect(memoryViewFromDraft(draft)).toEqual(source);
  });

  it("无筛选/无上限/无投影：草稿空值与 null 互转", () => {
    const draft = memoryViewDraftFromView(view({ condition: null, limit: null, projection: [] }));
    expect(draft.conditionFieldKey).toBe("");
    expect(draft.conditionValues).toEqual([]);
    expect(draft.limitText).toBe("");
    expect(draft.projection).toEqual([]);
    expect(memoryViewFromDraft(draft)).toEqual(
      view({ condition: null, limit: null, projection: [] }),
    );
  });

  it("emptyMemoryViewDraft：全部空值", () => {
    expect(emptyMemoryViewDraft()).toEqual({
      name: "",
      tableKey: "",
      conditionFieldKey: "",
      conditionValues: [],
      limitText: "",
      projection: [],
    });
  });
});

describe("validateMemoryViewDraft（草稿校验）", () => {
  const draft = () => memoryViewDraftFromView(view());

  it("合法草稿：无错误", () => {
    expect(validateMemoryViewDraft(draft(), [])).toBeUndefined();
  });

  it("名称非法（空白/::/|/}}/空）与全局重复拒绝", () => {
    expect(validateMemoryViewDraft({ ...draft(), name: "非法 名" }, [])).toBeDefined();
    expect(validateMemoryViewDraft({ ...draft(), name: "a::b" }, [])).toBeDefined();
    expect(validateMemoryViewDraft({ ...draft(), name: "" }, [])).toBeDefined();
    expect(validateMemoryViewDraft({ ...draft(), name: "已存在" }, ["已存在"])).toContain("已存在");
  });

  it("未选表拒绝；选筛选字段但无值拒绝", () => {
    expect(validateMemoryViewDraft({ ...draft(), tableKey: "" }, [])).toContain("表格");
    expect(
      validateMemoryViewDraft({ ...draft(), conditionFieldKey: "status", conditionValues: [] }, []),
    ).toContain("筛选值");
  });

  it("条数：非法（非整数/0/负数/超上限）拒绝，空 = 合法", () => {
    expect(validateMemoryViewDraft({ ...draft(), limitText: "0" }, [])).toContain("1..100");
    expect(validateMemoryViewDraft({ ...draft(), limitText: "101" }, [])).toContain("1..100");
    expect(validateMemoryViewDraft({ ...draft(), limitText: "abc" }, [])).toContain("1..100");
    expect(validateMemoryViewDraft({ ...draft(), limitText: "1.5" }, [])).toContain("1..100");
    expect(validateMemoryViewDraft({ ...draft(), limitText: "" }, [])).toBeUndefined();
    expect(validateMemoryViewDraft({ ...draft(), limitText: "100" }, [])).toBeUndefined();
  });
});

describe("isConditionField（筛选字段类型白名单）", () => {
  it("single_select / short_text 可用，其余不可用", () => {
    expect(isConditionField(field("a", "single_select"))).toBe(true);
    expect(isConditionField(field("b", "short_text"))).toBe(true);
    expect(isConditionField(field("c", "long_text"))).toBe(false);
    expect(isConditionField(field("d", "single_reference"))).toBe(false);
    expect(isConditionField(field("e", "integer"))).toBe(false);
  });
});

describe("viewConfigErrors（面板配置错误检测，与服务翻译层同语义）", () => {
  const tables = [table("plots", "伏笔"), table("characters", "人物")];
  const fieldsByTable = new Map([
    ["plots", [field("name"), field("status", "single_select", ["埋设中"])]],
  ]);

  it("配置正常：无错误", () => {
    expect(viewConfigErrors(view(), tables, fieldsByTable)).toEqual([]);
  });

  it("表不存在（含停用）：表错误（不再检查字段）", () => {
    expect(viewConfigErrors(view({ tableKey: "ghost" }), tables, fieldsByTable)).toEqual([
      "表「ghost」不存在或已停用",
    ]);
  });

  it("筛选字段/显示字段缺失（含 Key 改名）：对应字段错误", () => {
    expect(
      viewConfigErrors(
        view({ condition: { fieldKey: "ghost", values: ["x"] } }),
        tables,
        fieldsByTable,
      ),
    ).toEqual(["筛选字段「ghost」不存在或已停用"]);
    expect(viewConfigErrors(view({ projection: ["ghost"] }), tables, fieldsByTable)).toEqual([
      "显示字段「ghost」不存在或已停用",
    ]);
  });

  it("筛选字段类型不支持（非 single_select/short_text）：类型错误", () => {
    const wrongType = new Map([["plots", [field("name"), field("owner", "single_reference")]]]);
    expect(
      viewConfigErrors(
        view({ condition: { fieldKey: "owner", values: ["x"] }, projection: ["name"] }),
        tables,
        wrongType,
      ),
    ).toEqual(["筛选字段「owner」类型不支持（仅 single_select / short_text）"]);
  });
});

describe("viewSummaryText（折叠行摘要）", () => {
  it("筛选/条数/投影一行展示；空值显示缺省", () => {
    expect(viewSummaryText(view())).toBe(
      "筛选 status ∈ 埋设中、已触发 · 最多 50 条 · 显示 name、status",
    );
    expect(viewSummaryText(view({ condition: null, limit: null, projection: [] }))).toBe(
      "无筛选 · 无条数上限 · 显示文本",
    );
  });
});
