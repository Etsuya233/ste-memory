import { describe, expect, it } from "vitest";
import type { LogEntry, LogLevel } from "../logging/log.ts";
import {
  FILL_AGENT_LOG_TYPE,
  FILL_RUN_LOG_TYPE,
  FILL_TASK_LOG_TYPE,
} from "../fill-tasks/fill-log.ts";
import {
  applyLogFilters,
  buildLogListViewModel,
  defaultLogFilters,
  LOG_TYPE_OPTIONS,
  logQueryKind,
  logTypeLabel,
  type LogPanelFilters,
} from "./log-panel-model.ts";

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: 1,
    type: FILL_TASK_LOG_TYPE,
    key: "run-1",
    level: "info",
    text: '{\n  "phase": "start"\n}',
    createdAt: "2026-07-30T01:00:00.000Z",
    ...overrides,
  };
}

function filters(overrides: Partial<LogPanelFilters> = {}): LogPanelFilters {
  return { type: null, level: null, key: "", ...overrides };
}

describe("日志查询页模型（ADR 0015）", () => {
  it("defaultLogFilters：无类型/级别/Key 限制", () => {
    expect(defaultLogFilters()).toEqual({ type: null, level: null, key: "" });
  });

  it("logQueryKind：Key 非空按 Key 查询，否则取最近", () => {
    expect(logQueryKind(filters({ key: "run-9" }))).toBe("key");
    expect(logQueryKind(filters({ key: "  " }))).toBe("recent");
    expect(logQueryKind(filters())).toBe("recent");
  });

  it("applyLogFilters：类型/级别/Key 子串（大小写不敏感）叠加过滤，顺序保持", () => {
    const rows: LogEntry[] = [
      entry({ id: 3, type: FILL_AGENT_LOG_TYPE, key: "Run-2", level: "error" }),
      entry({ id: 2, type: FILL_RUN_LOG_TYPE, key: "run-1", level: "warn" }),
      entry({ id: 1, type: FILL_TASK_LOG_TYPE, key: "run-1", level: "info" }),
    ];

    expect(applyLogFilters(rows, filters())).toEqual(rows);
    expect(applyLogFilters(rows, filters({ type: FILL_RUN_LOG_TYPE }))).toEqual([rows[1]]);
    expect(applyLogFilters(rows, filters({ level: "error" }))).toEqual([rows[0]]);
    expect(applyLogFilters(rows, filters({ key: "RUN-1" }))).toEqual([rows[1], rows[2]]);
    expect(
      applyLogFilters(rows, filters({ type: FILL_TASK_LOG_TYPE, level: "warn", key: "run" })),
    ).toEqual([]);
  });

  it("类型下拉硬编码三个填表类型 + 全部；未知类型显示原始 type", () => {
    expect(LOG_TYPE_OPTIONS).toEqual([
      { value: FILL_TASK_LOG_TYPE, label: "填表任务" },
      { value: FILL_RUN_LOG_TYPE, label: "填表批" },
      { value: FILL_AGENT_LOG_TYPE, label: "Agent 请求" },
    ]);
    expect(logTypeLabel(FILL_AGENT_LOG_TYPE)).toBe("Agent 请求");
    expect(logTypeLabel("unknown-type")).toBe("unknown-type");
  });

  it("buildLogListViewModel：过滤 + 列表字段（无业务摘要，级别透传，时间格式化）", () => {
    const rows: LogEntry[] = [
      entry({
        id: 2,
        key: "run-2",
        level: "error" as LogLevel,
        createdAt: "2026-07-30T12:34:56.000Z",
      }),
      entry({ id: 1, type: "unknown", key: "run-1", level: "info" }),
    ];

    expect(buildLogListViewModel(rows, filters({ level: "error" }))).toEqual([
      {
        id: 2,
        type: FILL_TASK_LOG_TYPE,
        typeLabel: "填表任务",
        key: "run-2",
        level: "error",
        timeText: "2026-07-30 12:34",
      },
    ]);
    expect(buildLogListViewModel(rows, filters())).toEqual([
      {
        id: 2,
        type: FILL_TASK_LOG_TYPE,
        typeLabel: "填表任务",
        key: "run-2",
        level: "error",
        timeText: "2026-07-30 12:34",
      },
      {
        id: 1,
        type: "unknown",
        typeLabel: "unknown",
        key: "run-1",
        level: "info",
        timeText: "2026-07-30 01:00",
      },
    ]);
  });
});
