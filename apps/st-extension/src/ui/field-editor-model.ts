/**
 * 字段定义编辑器（ticket 09）的纯逻辑 seam：草稿构造/类型依赖的配置形态/
 * 固定选项解析/本地校验/相邻位置交换。组件只做「草稿 → 表单投影」与事件接线，
 * 服务端规则（key 冲突、引用目标跨空间、类型不可改）由 core 强制，错误经 toastr 展示。
 */
import type { MemoryField, MemoryFieldId, MemoryFieldType } from "@ste-memory/core/memory";

/** 字段草稿（受控表单状态；固定选项以「每行一个」文本编辑，保存时解析） */
export interface FieldDraft {
  readonly key: string;
  readonly name: string;
  readonly type: MemoryFieldType;
  readonly required: boolean;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly optionsText: string;
  readonly referenceTableId: string;
}

export function emptyFieldDraft(type: MemoryFieldType): FieldDraft {
  return {
    key: "",
    name: "",
    type,
    required: false,
    prompt: "",
    enabled: true,
    optionsText: "",
    referenceTableId: "",
  };
}

/** 从既有字段构造草稿（编辑模式；类型锁定由调用方经 typeLocked 传入） */
export function fieldDraftFromField(field: MemoryField): FieldDraft {
  return {
    key: field.key,
    name: field.name,
    type: field.type,
    required: field.required,
    prompt: field.prompt,
    enabled: field.enabled,
    optionsText: field.options.join("\n"),
    referenceTableId: field.referenceTableId ?? "",
  };
}

/** 单选/多选类型需要固定选项编辑区 */
export function fieldTypeNeedsOptions(type: MemoryFieldType): boolean {
  return type === "single_select" || type === "multi_select";
}

/** 单引用/多引用类型需要引用目标表选择区 */
export function fieldTypeNeedsReference(type: MemoryFieldType): boolean {
  return type === "single_reference" || type === "multi_reference";
}

/** 固定选项文本 → 规范化选项数组（每行一个，trim 后去空行） */
export function parseOptionsText(text: string): readonly string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export interface FieldDraftErrors {
  readonly key?: string;
  readonly name?: string;
  readonly options?: string;
  readonly reference?: string;
}

/**
 * 本地校验：空值 / key 冲突 / 选项（互不重复的非空固定选项，与 core
 * memory_field_options_invalid 同规则）/ 引用目标必选。existingKeys 由调用方
 * 传入「同表其他字段的 key」（编辑模式排除自身）。
 */
export function validateFieldDraft(
  draft: FieldDraft,
  existingKeys: readonly string[],
): FieldDraftErrors {
  const errors: {
    key?: string;
    name?: string;
    options?: string;
    reference?: string;
  } = {};
  const key = draft.key.trim();
  if (key.length === 0) {
    errors.key = "字段 Key 不能为空";
  } else if (existingKeys.some((item) => item === key)) {
    errors.key = "同一表格内的字段 Key 不能重复";
  }
  if (draft.name.trim().length === 0) {
    errors.name = "字段名称不能为空";
  }
  if (fieldTypeNeedsOptions(draft.type)) {
    const options = parseOptionsText(draft.optionsText);
    if (options.length === 0 || new Set(options).size !== options.length) {
      errors.options = "单选和多选字段需要互不重复的非空固定选项";
    }
  }
  if (fieldTypeNeedsReference(draft.type) && draft.referenceTableId === "") {
    errors.reference = "请选择引用目标表";
  }
  return errors;
}

export interface FieldPositionChange {
  readonly id: MemoryFieldId;
  readonly position: number;
}

/**
 * 相邻字段交换 position（上移/下移）。fields 需按 position 升序（core list 已保证）；
 * 越界（已在顶部/底部）返回空数组，调用方据此禁用按钮或忽略。
 */
export function swapAdjacentFieldPositions(
  fields: readonly MemoryField[],
  index: number,
  direction: -1 | 1,
): readonly FieldPositionChange[] {
  const target = index + direction;
  if (index < 0 || target < 0 || target >= fields.length) return [];
  const from = fields[index]!;
  const to = fields[target]!;
  return [
    { id: from.id, position: to.position },
    { id: to.id, position: from.position },
  ];
}
