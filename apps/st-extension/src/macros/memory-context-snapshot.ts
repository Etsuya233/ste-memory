import type { MemoryRecord } from "@ste-memory/core/memory";

/**
 * 记忆上下文快照组装（纯函数，spec 决策 7 的「输出格式契约」）：
 *
 * 按启用表分组（表名标题行 + 每条记录显示文本一行，复用 core 写入时预计算的
 * displayText），空表省略，停用表不参与；可配置上限（默认 2000 字符），
 * 超出从尾部截断并附「……（已截断）」标记：
 *
 *   【人物】
 *   张三：身份/定位…
 *   李四：…
 *
 *   【地点】
 *   …
 *
 * 记录顺序：组内按更新时间倒序（新的在前）——尾部截断保留的是最新记忆，
 * 对生成上下文最有价值。表格顺序 = 调用方传入顺序（repository 创建时间升序，
 * 系统表在前）。
 */

/** 截断标记（输出格式契约） */
export const TRUNCATION_MARKER = "……（已截断）";

/** 单行化：显示文本/表名里的换行替换为空格（格式契约「每条记录一行」） */
function toSingleLine(text: string): string {
  return text.replace(/\r?\n/g, " ");
}

/** 快照组装输入：一个记忆表格（含启停与记录，displayText 已由 core 预计算） */
export interface MemoryContextTableInput {
  readonly name: string;
  readonly enabled: boolean;
  readonly records: readonly MemoryRecord[];
}

/**
 * 组装记忆上下文快照。输入已含全部表格（含停用表，函数自行过滤），
 * 保证「停用表不参与」的契约在纯函数层可测。
 */
export function assembleMemoryContextSnapshot(
  tables: readonly MemoryContextTableInput[],
  limit: number,
): string {
  const sections: string[] = [];
  for (const table of tables) {
    if (!table.enabled || table.records.length === 0) continue;
    const records = newestFirst(table.records);
    const lines = records.map((record) => toSingleLine(record.displayText));
    sections.push(`【${toSingleLine(table.name)}】\n${lines.join("\n")}`);
  }
  return truncateWithMarker(sections.join("\n\n"), limit);
}

/**
 * 尾部截断（输出格式契约）：总长不超 limit 原样返回；超出时从尾部截断并附
 * 截断标记。截断后内容长 = max(0, limit - 标记长)，标记本身不计入 limit
 * （limit 小于标记长时输出仅标记，仍表达「已截断」语义）。
 */
export function truncateWithMarker(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const keep = limit - TRUNCATION_MARKER.length;
  return keep <= 0 ? TRUNCATION_MARKER : `${text.slice(0, keep)}${TRUNCATION_MARKER}`;
}

/** 组内排序：更新时间倒序（id 兜底，确定性；createdAt 在 updatedAt 相等时兜底） */
function newestFirst(records: readonly MemoryRecord[]): readonly MemoryRecord[] {
  return [...records].sort((left, right) => {
    const byUpdated = right.updatedAt.localeCompare(left.updatedAt);
    if (byUpdated !== 0) return byUpdated;
    const byCreated = right.createdAt.localeCompare(left.createdAt);
    return byCreated !== 0 ? byCreated : right.id.localeCompare(left.id);
  });
}
