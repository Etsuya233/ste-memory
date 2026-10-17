import type { LogAppendInput } from "../logging/log.ts";
import type { FillTask } from "./fill-task.ts";

/**
 * 填表行流日志（ADR 0016）：通用日志 type 常量与行构造（key = 任务 runId，
 * text = Pretty JSON）。查询侧零解析，行内容作为不透明文本原样展示。
 */
export const FILL_TASK_LOG_TYPE = "fill-task";
export const FILL_RUN_LOG_TYPE = "fill-run";
export const FILL_AGENT_LOG_TYPE = "fill-agent";

/** 任务开始行（ticket 01）：楼层任务含 range，初始化任务省略（无楼层）。 */
export function fillTaskStartLog(task: FillTask): LogAppendInput {
  return {
    type: FILL_TASK_LOG_TYPE,
    key: task.runId,
    level: "info",
    text: JSON.stringify(
      {
        phase: "start",
        kind: task.kind,
        ...(task.kind === "floor" ? { range: { from: task.from, to: task.to } } : {}),
        batchSize: task.blockSize,
        startedAt: task.createdAt,
      },
      null,
      2,
    ),
  };
}
