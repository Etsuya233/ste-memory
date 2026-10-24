/**
 * 记忆视图管理器（ticket 02 / ADR 0025）纯逻辑 seam：视图编辑草稿（名称/表/
 * 筛选字段/值/条数/投影）、草稿校验（名称 ST 宏参数语法 + 全局唯一 + 值/条数
 * 合法性）、视图配置错误检测（面板显示「配置错误」，与服务翻译层同语义）。
 * 组件只做「模型 → DOM」投影与事件接线（同 cleaning-rules-manager-model 惯例）。
 */
import type { MemoryField, MemoryTable } from "../../features/memory/index.ts";
import {
  MEMORY_VIEW_CONDITION_FIELD_TYPES,
  MEMORY_VIEW_LIMIT_MAX,
  validateMemoryViewName,
  type MemoryView,
} from "../../features/macros/memory-views.ts";

export interface MemoryViewDraft {
  readonly name: string;
  /** 表 Key；"" = 未选 */
  readonly tableKey: string;
  /** 筛选字段 Key；"" = 无筛选 */
  readonly conditionFieldKey: string;
  /** 筛选值集合（single_select 多选 / short_text 手输逗号分隔） */
  readonly conditionValues: readonly string[];
  /** 条数上限输入文本；"" = 无上限 */
  readonly limitText: string;
  /** 显示字段投影（字段 Key 列表）；空 = 无投影（显示文本） */
  readonly projection: readonly string[];
}

export function emptyMemoryViewDraft(): MemoryViewDraft {
  return {
    name: "",
    tableKey: "",
    conditionFieldKey: "",
    conditionValues: [],
    limitText: "",
    projection: [],
  };
}

export function memoryViewDraftFromView(view: MemoryView): MemoryViewDraft {
  return {
    name: view.name,
    tableKey: view.tableKey,
    conditionFieldKey: view.condition?.fieldKey ?? "",
    conditionValues: view.condition?.values ?? [],
    limitText: view.limit === null ? "" : String(view.limit),
    projection: [...view.projection],
  };
}

/** v1 筛选字段类型白名单（UI 只暴露 single_select / short_text 字段，与翻译层共用同一来源） */
export function isConditionField(field: MemoryField): boolean {
  return MEMORY_VIEW_CONDITION_FIELD_TYPES.has(field.type);
}

/**
 * 草稿校验：返回错误文案；undefined = 合法。
 * 名称（非空/无空白/无 :: | }} + 作用域内唯一，排除自身）、表必选、筛选字段
 * 选了必须给值、条数为空或 1..100 整数。UI 称「宏名」，此处统一转换领域词。
 */
export function validateMemoryViewDraft(
  draft: MemoryViewDraft,
  existingNames: readonly string[],
  conflictMessage = "宏名已存在（全局宏名唯一）",
): string | undefined {
  const nameError = validateMemoryViewName(draft.name);
  if (nameError !== undefined) return nameError.replaceAll("视图名", "宏名");
  if (existingNames.includes(draft.name)) return conflictMessage;
  if (draft.tableKey === "") return "请选择表格";
  if (draft.conditionFieldKey !== "" && draft.conditionValues.length === 0) {
    return "已选筛选字段，请至少填一个筛选值";
  }
  if (draft.limitText !== "") {
    const limit = Number(draft.limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > MEMORY_VIEW_LIMIT_MAX) {
      return `条数上限需为 1..${MEMORY_VIEW_LIMIT_MAX} 的整数（留空 = 最多 ${MEMORY_VIEW_LIMIT_MAX} 条）`;
    }
  }
  return undefined;
}

/** 草稿 → 视图（校验通过后调用；条数空 = null，条件空 = null） */
export function memoryViewFromDraft(draft: MemoryViewDraft): MemoryView {
  return {
    name: draft.name,
    tableKey: draft.tableKey,
    condition:
      draft.conditionFieldKey === ""
        ? null
        : { fieldKey: draft.conditionFieldKey, values: [...draft.conditionValues] },
    limit:
      draft.limitText === ""
        ? null
        : Math.min(Number.parseInt(draft.limitText, 10), MEMORY_VIEW_LIMIT_MAX),
    projection: [...draft.projection],
  };
}

/**
 * 视图配置错误检测（面板展示；与服务翻译层同语义——表/字段不存在或已停用、
 * 筛选字段类型不支持）：返回错误文案列表；空 = 无错误。
 * fieldsByTable 以表 Key 为键（未取到 = 该表字段未知，视为错误）。
 */
export function viewConfigErrors(
  view: MemoryView,
  tables: readonly MemoryTable[],
  fieldsByTable: ReadonlyMap<string, readonly MemoryField[]>,
): readonly string[] {
  const errors: string[] = [];
  const table = tables.find((candidate) => candidate.key === view.tableKey);
  if (!table) {
    return [`表「${view.tableKey}」不存在或已停用`];
  }
  const fields = fieldsByTable.get(view.tableKey) ?? [];
  if (view.condition) {
    const conditionField = fields.find((field) => field.key === view.condition?.fieldKey);
    if (!conditionField) {
      errors.push(`筛选字段「${view.condition.fieldKey}」不存在或已停用`);
    } else if (!isConditionField(conditionField)) {
      errors.push(
        `筛选字段「${view.condition.fieldKey}」类型不支持（仅 single_select / short_text）`,
      );
    }
  }
  for (const key of view.projection) {
    if (!fields.some((field) => field.key === key)) {
      errors.push(`显示字段「${key}」不存在或已停用`);
    }
  }
  return errors;
}

/** 折叠行摘要（筛选/条数/投影；没配置的部分省略，避免每行重复「无筛选」） */
export function viewSelectionSummary(view: MemoryView, conditionFieldName?: string): string {
  const parts: string[] = [];
  if (view.condition) {
    const field = conditionFieldName ?? view.condition.fieldKey;
    parts.push(`${field} ∈ ${view.condition.values.join("、")}`);
  }
  if (view.limit !== null) parts.push(`最多 ${view.limit} 条`);
  if (view.projection.length > 0) parts.push(`显示 ${view.projection.length} 个字段`);
  return parts.join(" · ");
}

/** Chat macros belong to the conversation, even when two chats share one space. */
export function macroEditingContextChanged(
  original: { readonly spaceId: string | undefined; readonly chatIdentity: string | undefined },
  current: { readonly spaceId: string | undefined; readonly chatIdentity: string | undefined },
): boolean {
  return original.spaceId !== current.spaceId || original.chatIdentity !== current.chatIdentity;
}
