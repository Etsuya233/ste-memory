import { describe, expect, it } from "vitest";
import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { LogEntry, LogLevel } from "../logging/log.ts";
import { FILL_RUN_LOG_TYPE } from "../fill-tasks/fill-run-log.ts";
import {
  applyLogFilters,
  buildLogListViewModel,
  defaultLogFilters,
  logEntrySummary,
  logQueryKind,
  type LogPanelFilters,
} from "./log-panel-model.ts";

const SPACE = "space-1" as MemorySpaceId;

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: 1,
    type: FILL_RUN_LOG_TYPE,
    key: "run-1",
    spaceId: SPACE,
    level: "info",
    data: {
      taskRunId: "run-1",
      block: { from: 0, to: 1 },
      status: "succeeded",
      errorMessage: null,
      systemPrompt: "system",
      rounds: [{ request: { messages: [] }, output: {}, toolResults: [] }],
      startedAt: "2026-07-30T01:00:00.000Z",
      endedAt: "2026-07-30T01:00:05.000Z",
      durationMs: 5000,
    },
    createdAt: "2026-07-30T01:00:00.000Z",
    ...overrides,
  };
}

function filters(overrides: Partial<LogPanelFilters> = {}): LogPanelFilters {
  return { type: null, spaceId: SPACE, level: null, key: "", ...overrides };
}

describe("log panel model", () => {
  it("defaultLogFilters：绑定当前空间，无类型/级别/搜索限制", () => {
    expect(defaultLogFilters(SPACE)).toEqual({
      type: null,
      spaceId: SPACE,
      level: null,
      key: "",
    });
    expect(defaultLogFilters(null)).toEqual({
      type: null,
      spaceId: null,
      level: null,
      key: "",
    });
  });

  it("logQueryKind：key 搜索优先，其次空间，最后全局最近", () => {
    expect(logQueryKind(filters({ key: "run-9" }))).toBe("key");
    expect(logQueryKind(filters({ key: "  " }))).toBe("space");
    expect(logQueryKind(filters({ spaceId: null }))).toBe("recent");
    expect(logQueryKind(filters({ spaceId: null, key: "run-9" }))).toBe("key");
  });

  it("applyLogFilters：按类型/空间/级别/key 子串叠加过滤，顺序保持（时间倒序由仓库保证）", () => {
    const rows: LogEntry[] = [
      entry({ id: 3, type: FILL_RUN_LOG_TYPE, key: "run-2", level: "error", spaceId: SPACE }),
      entry({ id: 2, type: FILL_RUN_LOG_TYPE, key: "run-1", level: "info", spaceId: SPACE }),
      entry({ id: 1, type: "sync", key: "sync-1", level: "warn", spaceId: null }),
    ];

    expect(applyLogFilters(rows, filters())).toEqual([rows[0], rows[1]]);
    // sync 行 spaceId 为 null，默认空间过滤下不可见
    expect(applyLogFilters(rows, filters({ type: "sync" }))).toEqual([]);
    expect(applyLogFilters(rows, filters({ level: "error" }))).toEqual([rows[0]]);
    // key 子串匹配（大小写不敏感）
    expect(applyLogFilters(rows, filters({ key: "RUN-1" }))).toEqual([rows[1]]);
    // 空间过滤排除 null-space 行
    expect(applyLogFilters(rows, filters({ spaceId: null }))).toEqual(rows);
    expect(applyLogFilters(rows, filters({ type: "sync", spaceId: SPACE }))).toEqual([]);
  });

  it("logEntrySummary：fill 类型摘要（楼层范围 · 轮数 · 状态），未知类型为空串", () => {
    expect(logEntrySummary(entry())).toBe("楼层 0–1 · 1 轮 · 成功");
    expect(
      logEntrySummary(
        entry({
          data: {
            block: { from: 4, to: 7 },
            status: "failed",
            rounds: [{}, {}],
          },
        }),
      ),
    ).toBe("楼层 4–7 · 2 轮 · 失败");
    expect(
      logEntrySummary(
        entry({
          data: { block: { from: 2, to: 3 }, status: "interrupted", rounds: [] },
        }),
      ),
    ).toBe("楼层 2–3 · 0 轮 · 中断");
    expect(logEntrySummary(entry({ type: "sync" }))).toBe("");
    // 数据损坏时防御性降级为空串（查看器不因旧/坏数据崩溃）
    expect(logEntrySummary(entry({ data: "garbage" }))).toBe("");
    expect(logEntrySummary(entry({ data: null }))).toBe("");
  });

  it("buildLogListViewModel：过滤 + 视图字段（时间格式化，级别透传）", () => {
    const rows: LogEntry[] = [
      entry({
        id: 2,
        key: "run-2",
        level: "error" as LogLevel,
        createdAt: "2026-07-30T12:34:56.000Z",
        data: { block: { from: 0, to: 1 }, status: "failed", rounds: [{}] },
      }),
      entry({ id: 1, key: "run-1", level: "info", createdAt: "2026-07-30T01:02:03.000Z" }),
    ];

    expect(buildLogListViewModel(rows, filters({ level: "error" }))).toEqual([
      {
        id: 2,
        type: FILL_RUN_LOG_TYPE,
        key: "run-2",
        level: "error",
        timeText: "2026-07-30 12:34",
        summary: "楼层 0–1 · 1 轮 · 失败",
      },
    ]);
  });
});
