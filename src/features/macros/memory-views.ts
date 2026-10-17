/**
 * 记忆视图设置模型（ADR 0025 / ticket 02）：插件级命名视图——{名称、表 Key、
 * 筛选条件（v1 单条件：字段 Key + 值集合，single_select/short_text 字段）、
 * 条数上限（可选）、显示字段投影（可选）}。存插件设置（与清洗规则列表同层），
 * 全局生效；经记忆宏按名展开为预计算快照（{{宏名::视图名}}）。
 *
 * 视图名校验与 ST 宏参数语法约束一致（事实调研：参数内仅空白、`::`、`|`、`}}`
 * 特殊，中文可用）；全局唯一。合并持久化数据时非法视图逐项丢弃（保留其余）。
 */

export interface MemoryViewCondition {
  /** 筛选字段 Key（single_select / short_text） */
  readonly fieldKey: string;
  /** 值集合（翻译层恒用 in 算子：单值 = 单元素数组） */
  readonly values: readonly string[];
}

export interface MemoryView {
  /** 视图名（全局唯一；ST 宏参数语法约束内，中文可用） */
  readonly name: string;
  /** 表 Key（经 digest 校验映射为表 id） */
  readonly tableKey: string;
  /** 筛选条件；null = 无筛选 */
  readonly condition: MemoryViewCondition | null;
  /** 条数上限（1..100）；null = 无上限（翻译取契约 pageSize 上限 100） */
  readonly limit: number | null;
  /** 显示字段投影（字段 Key 列表）；空 = 无投影（沿用显示文本） */
  readonly projection: readonly string[];
}

/** 视图条数上限：契约 pageSize 上限（memory-record-query-contract，超限拒绝查询） */
export const MEMORY_VIEW_LIMIT_MAX = 100;

/**
 * v1 筛选字段类型白名单（翻译层与面板 UI 共用同一来源；值集合为字符串）。
 * 其余类型由查询契约按值校验拒绝（ADR 0025 决策 2）。
 */
export const MEMORY_VIEW_CONDITION_FIELD_TYPES = new Set(["single_select", "short_text"]);

/**
 * 视图名校验（ST 宏参数语法约束 + 非空）：
 * 返回错误文案；undefined = 合法。规则：非空、不含空白/`::`/`|`/`}}`（中文可用）。
 */
export function validateMemoryViewName(value: string): string | undefined {
  if (value.trim() === "") return "视图名不能为空";
  if (/\s/.test(value)) return "视图名不能包含空白";
  if (value.includes("::")) return "视图名不能包含 ::";
  if (value.includes("|")) return "视图名不能包含 |";
  if (value.includes("}}")) return "视图名不能包含 }}";
  return undefined;
}

/**
 * 合并持久化的视图列表：形状损坏的视图逐项丢弃（保留其余）；名称非法/重复丢弃；
 * limit 超契约上限钳制到 100（意图「至多 N 条」在契约内保留）；condition 值集合
 * 为空丢弃（空筛选无语义，查询契约也拒绝空数组）。
 */
export function mergeMemoryViews(raw: unknown): readonly MemoryView[] {
  if (!Array.isArray(raw)) return [];
  const views: MemoryView[] = [];
  const names = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const view = mergeMemoryView(item);
    if (!view) continue;
    if (names.has(view.name)) continue;
    names.add(view.name);
    views.push(view);
  }
  return views;
}

function mergeMemoryView(raw: Record<string, unknown>): MemoryView | undefined {
  if (typeof raw.name !== "string" || validateMemoryViewName(raw.name) !== undefined) {
    return undefined;
  }
  if (typeof raw.tableKey !== "string" || raw.tableKey === "") return undefined;
  let condition: MemoryViewCondition | null = null;
  if (raw.condition !== null && raw.condition !== undefined) {
    if (!isRecord(raw.condition)) return undefined;
    if (typeof raw.condition.fieldKey !== "string" || raw.condition.fieldKey === "") {
      return undefined;
    }
    if (
      !Array.isArray(raw.condition.values) ||
      raw.condition.values.length === 0 ||
      !raw.condition.values.every((value) => typeof value === "string")
    ) {
      return undefined;
    }
    condition = { fieldKey: raw.condition.fieldKey, values: [...raw.condition.values] };
  }
  let limit: number | null = null;
  if (raw.limit !== null && raw.limit !== undefined) {
    if (typeof raw.limit !== "number" || !Number.isInteger(raw.limit) || raw.limit < 1) {
      return undefined;
    }
    limit = Math.min(raw.limit, MEMORY_VIEW_LIMIT_MAX);
  }
  let projection: readonly string[] = [];
  if (raw.projection !== undefined) {
    if (!Array.isArray(raw.projection) || !raw.projection.every((key) => typeof key === "string")) {
      return undefined;
    }
    projection = [...raw.projection];
  }
  return { name: raw.name, tableKey: raw.tableKey, condition, limit, projection };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
