import { describe, expect, it } from "vitest";
import { EMPTY_TABLE_DRAFT, validateTableDraft, type TableDraft } from "./table-editor-model.ts";

describe("validateTableDraft（建表/编辑表本地校验）", () => {
  it("空 key 与空名称给出中文错误", () => {
    const errors = validateTableDraft(EMPTY_TABLE_DRAFT);
    expect(errors.key).toBe("表格 Key 不能为空");
    expect(errors.name).toBe("表格名称不能为空");
  });

  it("仅空白字符同样视为空", () => {
    const errors = validateTableDraft({
      key: "   ",
      name: "\t",
      description: "",
      prompt: "",
    });
    expect(errors.key).toBeDefined();
    expect(errors.name).toBeDefined();
  });

  it("key 与名称非空时无错误", () => {
    const draft: TableDraft = {
      key: "characters",
      name: "角色",
      description: "描述",
      prompt: "提示",
    };
    expect(validateTableDraft(draft)).toEqual({});
  });
});
