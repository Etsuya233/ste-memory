/**
 * 世界书扫描（ADR 0007）：把合并剧情文本（构建见 fill-tasks/fill-task-block.ts 的
 * buildMergedStoryText）包成单条消息交给 ST 自己的扫描器——生效书本选择与全部
 * 匹配规则由 ST 处理，插件零匹配代码；旧版 ST 无此函数 → 空串降级。
 */

/** ST getContext 子集：世界书扫描所需字段（getWorldInfoPrompt 可选 = 旧版 ST 降级） */
export interface WorldbookScanContext {
  /** 当前上下文大小（token；ST getContext().maxContext；缺失 = 0 → ST 预算退化为最小） */
  readonly maxContext?: number;
  /** ST 世界书扫描（getContext().getWorldInfoPrompt，release 1.18.0 已核实） */
  readonly getWorldInfoPrompt?: (
    chat: readonly unknown[],
    maxContext: number,
    isDryRun: boolean,
  ) => Promise<{ readonly worldInfoString: string }>;
}

/**
 * 委托 ST 扫描（ADR 0007）：把合并剧情文本包成**单条消息**传给 ST 自己的扫描器——
 * 生效书本选择与全部匹配规则由 ST 处理，插件零匹配代码。
 *
 * 始终 dry run：非 dry run 的定时效果（sticky/cooldown）会写 chat_metadata，
 * 且时间戳按传入 chat 长度计算——合成消息会污染真实对话的定时状态。
 * 旧版 ST 无 getWorldInfoPrompt → 空串（版本守卫，不抛错）。
 */
export async function scanWorldbookText(
  context: WorldbookScanContext,
  mergedText: string,
): Promise<string> {
  if (!context.getWorldInfoPrompt) return "";
  const result = await context.getWorldInfoPrompt([mergedText], context.maxContext ?? 0, true);
  return result.worldInfoString;
}
