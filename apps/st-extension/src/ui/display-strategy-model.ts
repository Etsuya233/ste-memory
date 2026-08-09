/**
 * 显示策略编辑器（ticket 10）的纯逻辑 seam：草稿构造 / 本地校验 / 摘要文案 /
 * 策略依赖字段集合 / 预览行字段值摘要。保存时的最终规则由 core
 * MemoryFieldService.setDisplayStrategy 强制（DomainError humanMsg 经 toastr
 * 展示），这里做「与 core 同规则」的即时反馈与前置禁用（双保险）。
 */
import {
  derivedDisplayTemplate,
  memoryTableDisplayFieldIds,
  type MemoryField,
  type MemoryFieldId,
  type MemoryRecordPayload,
  type MemoryTableDisplayStrategy,
} from "@ste-memory/core/memory";

/** 策略编辑器草稿（受控表单状态；两个字段都保留，切类型不丢已填内容） */
export interface DisplayStrategyDraft {
  readonly type: "field" | "template";
  /** field 策略：选中的短文本字段 id */
  readonly fieldId: string;
  /** template 策略：模板文本（{fieldId} 占位符） */
  readonly template: string;
}

/** 从已保存策略构造初始草稿（无策略 = 默认 field 类型，待选字段） */
export function emptyDisplayStrategyDraft(
  strategy: MemoryTableDisplayStrategy | null,
): DisplayStrategyDraft {
  return strategy
    ? strategy.type === "field"
      ? { type: "field", fieldId: strategy.fieldId, template: "" }
      : { type: "template", fieldId: "", template: strategy.template }
    : { type: "field", fieldId: "", template: "" };
}

export interface DisplayStrategyDraftError {
  readonly message: string;
}

/**
 * 草稿校验（与 core setDisplayStrategy 同规则）：
 * - field：选中的字段必须是当前表中「启用」的 short_text 字段；
 * - template：至少一个 {字段引用} 占位符，且所有被引用字段必须存在并启用。
 */
export function validateDisplayStrategyDraft(
  draft: DisplayStrategyDraft,
  fields: readonly MemoryField[],
): DisplayStrategyDraftError | null {
  if (draft.type === "field") {
    const field = fields.find(
      (candidate) =>
        candidate.id === draft.fieldId && candidate.type === "short_text" && candidate.enabled,
    );
    return field ? null : { message: "请选择当前表中已启用的短文本字段" };
  }
  let fieldIds: readonly MemoryFieldId[];
  try {
    fieldIds = derivedDisplayTemplate(draft.template).fieldIds;
  } catch {
    return { message: "显示模板必须用 {字段引用} 引用至少一个字段" };
  }
  const enabledIds = new Set(fields.filter((field) => field.enabled).map((field) => field.id));
  if (fieldIds.some((fieldId) => !enabledIds.has(fieldId))) {
    return { message: "显示模板只能引用当前表中已启用的字段" };
  }
  return null;
}

/** 表格可选的显示策略（草稿 → core 策略对象；仅在校验通过后由调用方调用） */
export function displayStrategyFromDraft(draft: DisplayStrategyDraft): MemoryTableDisplayStrategy {
  return draft.type === "field"
    ? { type: "field", fieldId: draft.fieldId as MemoryFieldId }
    : { type: "template", template: draft.template };
}

/** 摘要文案（表格卡片 meta 行 / 编辑器标题）：未配置 / 显示字段 / 显示模板 */
export function displayStrategySummary(
  strategy: MemoryTableDisplayStrategy | null,
  fields: readonly MemoryField[],
): string {
  if (!strategy) return "未配置显示策略";
  if (strategy.type === "field") {
    const field = fields.find((candidate) => candidate.id === strategy.fieldId);
    return `显示字段：${field?.name ?? "未知字段"}`;
  }
  return `显示模板：${strategy.template}`;
}

/** 策略依赖的字段 id 集合（field 策略 = 显示字段；template 策略 = 全部引用）。
 * 模板无占位符时 derivedDisplayTemplate 抛错（正常保存路径不可能产生，仅畸形备份
 * 恢复可能带入）——渲染期必须防御：降级为空集合（不产生错误保护，显示不受阻）。 */
export function displayStrategyDependentFieldIds(
  strategy: MemoryTableDisplayStrategy | null,
): ReadonlySet<MemoryFieldId> {
  if (!strategy) return new Set();
  try {
    return new Set(memoryTableDisplayFieldIds(strategy));
  } catch {
    return new Set();
  }
}

/** 预览行的字段值摘要（“名称: 值 · 角色: 值…”，超长截断） */
export function payloadSummary(
  payload: MemoryRecordPayload,
  fields: readonly MemoryField[],
  maxLength = 40,
): string {
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const parts: string[] = [];
  for (const [fieldId, value] of Object.entries(payload)) {
    const field = fieldsById.get(fieldId as MemoryFieldId);
    if (!field) continue;
    const text = Array.isArray(value) ? value.join("、") : value === null ? "" : String(value);
    if (text.length === 0) continue;
    parts.push(`${field.name}: ${text}`);
  }
  const joined = parts.join(" · ");
  return joined.length > maxLength ? `${joined.slice(0, maxLength)}…` : joined;
}

/** 模板策略引用插入片段：{fieldId}（供「插入字段引用」chip 使用） */
export function templateFieldRef(fieldId: MemoryFieldId): string {
  return `{${fieldId}}`;
}

/** 当前表中可作为 field 策略候选的字段：启用 + 短文本 */
export function displayFieldCandidates(fields: readonly MemoryField[]): readonly MemoryField[] {
  return fields.filter((field) => field.enabled && field.type === "short_text");
}
