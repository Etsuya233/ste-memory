import type { LogAppendInput, LogLevel } from "../logging/log.ts";
import type { FillTask } from "./fill-task.ts";

/**
 * 填表行流日志（ADR 0016）：通用日志 type 常量与行构造（key = 任务 runId，
 * text = Pretty JSON）。查询侧零解析，行内容作为不透明文本原样展示。
 */
export const FILL_TASK_LOG_TYPE = "fill-task";
export const FILL_RUN_LOG_TYPE = "fill-run";
export const FILL_AGENT_LOG_TYPE = "fill-agent";

/** 批/任务结束行的终态（级别映射：succeeded/failed/interrupted = info/error/warn）。 */
export type FillLifecycleEndStatus = "succeeded" | "failed" | "interrupted";

const FILL_END_LEVEL: Record<FillLifecycleEndStatus, LogLevel> = {
  succeeded: "info",
  failed: "error",
  interrupted: "warn",
};

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

/**
 * 任务结束行：status/errorMessage（无错误为 null）/endedAt/durationMs
 * （任务耗时 = 结束时刻 − 任务开始时刻）。级别按终态映射。
 */
export function fillTaskEndLog(input: {
  readonly task: FillTask;
  readonly status: FillLifecycleEndStatus;
  readonly errorMessage: string | null;
  readonly endedAt: string;
}): LogAppendInput {
  return {
    type: FILL_TASK_LOG_TYPE,
    key: input.task.runId,
    level: FILL_END_LEVEL[input.status],
    text: JSON.stringify(
      {
        phase: "end",
        status: input.status,
        errorMessage: input.errorMessage,
        endedAt: input.endedAt,
        durationMs: Date.parse(input.endedAt) - Date.parse(input.task.createdAt),
      },
      null,
      2,
    ),
  };
}

/**
 * 每批开始行（紧凑参数对象）：batch 序号（1 基）、block 楼层区间
 * （初始化任务省略，无楼层）、startedAt。级别恒为 info。
 */
export function fillRunStartLog(input: {
  readonly task: FillTask;
  readonly batch: number;
  readonly from: number;
  readonly to: number;
  readonly startedAt: string;
}): LogAppendInput {
  return {
    type: FILL_RUN_LOG_TYPE,
    key: input.task.runId,
    level: "info",
    text: JSON.stringify(
      {
        phase: "start",
        batch: input.batch,
        ...(input.task.kind === "floor" ? { block: { from: input.from, to: input.to } } : {}),
        startedAt: input.startedAt,
      },
      null,
      2,
    ),
  };
}

/**
 * 每批结束行：batch/block（初始化任务省略）/status/errorMessage（无错误为 null）/
 * endedAt/durationMs（批耗时 = 结束时刻 − 批开始时刻）。级别按终态映射。
 */
export function fillRunEndLog(input: {
  readonly task: FillTask;
  readonly batch: number;
  readonly from: number;
  readonly to: number;
  readonly status: FillLifecycleEndStatus;
  readonly errorMessage: string | null;
  readonly startedAt: string;
  readonly endedAt: string;
}): LogAppendInput {
  return {
    type: FILL_RUN_LOG_TYPE,
    key: input.task.runId,
    level: FILL_END_LEVEL[input.status],
    text: JSON.stringify(
      {
        phase: "end",
        batch: input.batch,
        ...(input.task.kind === "floor" ? { block: { from: input.from, to: input.to } } : {}),
        status: input.status,
        errorMessage: input.errorMessage,
        endedAt: input.endedAt,
        durationMs: Date.parse(input.endedAt) - Date.parse(input.startedAt),
      },
      null,
      2,
    ),
  };
}
