/**
 * 表格编辑表单（ticket 09）：草稿与本地校验的纯逻辑 seam。
 * 服务端规则（key 冲突、名称长度等）由 core MemoryTableService 保证（DomainError
 * humanMsg 经 toastr 展示），这里只做「空值」级别的即时反馈，避免无效提交。
 */

export interface TableDraft {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
}

export const EMPTY_TABLE_DRAFT: TableDraft = {
  key: "",
  name: "",
  description: "",
  prompt: "",
};

export interface TableDraftErrors {
  readonly key?: string;
  readonly name?: string;
}

/** 空值校验（与 core memoryTableKey/memoryTableName 的空值语义一致）。 */
export function validateTableDraft(draft: TableDraft): TableDraftErrors {
  const errors: { key?: string; name?: string } = {};
  if (draft.key.trim().length === 0) {
    errors.key = "表格 Key 不能为空";
  }
  if (draft.name.trim().length === 0) {
    errors.name = "表格名称不能为空";
  }
  return errors;
}
