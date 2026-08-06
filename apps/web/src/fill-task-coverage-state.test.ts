import { describe, expect, it } from "vitest";
import type { MessageFillState } from "./api/fill-tasks.ts";
import {
  COVERAGE_COLUMNS,
  COVERAGE_STATE_LABELS,
  COVERAGE_STATE_ORDER,
  summarizeCoverage,
} from "./fill-task-coverage-state.ts";

function state(
  sourceId: number,
  state: MessageFillState,
): { sourceId: number; state: MessageFillState } {
  return { sourceId, state };
}

describe("summarizeCoverage", () => {
  it("空列表：四态计数全为 0", () => {
    expect(summarizeCoverage([])).toEqual({
      processed: 0,
      in_task: 0,
      error: 0,
      unplanned: 0,
      total: 0,
    });
  });

  it("四态计数正确，总和等于消息总数", () => {
    const counts = summarizeCoverage([
      state(1, "processed"),
      state(2, "processed"),
      state(3, "processed"),
      state(4, "in_task"),
      state(5, "in_task"),
      state(6, "error"),
      state(7, "unplanned"),
    ]);
    expect(counts).toEqual({
      processed: 3,
      in_task: 2,
      error: 1,
      unplanned: 1,
      total: 7,
    });
  });

  it("图例覆盖全部四态且计数键与状态一一对应", () => {
    expect(COVERAGE_STATE_ORDER).toHaveLength(4);
    expect(new Set(COVERAGE_STATE_ORDER)).toEqual(
      new Set<MessageFillState>(["processed", "in_task", "error", "unplanned"]),
    );
    for (const stateName of COVERAGE_STATE_ORDER) {
      expect(COVERAGE_STATE_LABELS[stateName]).toBeTruthy();
    }
  });

  it("矩阵列数为 50（用户确认的展示密度）", () => {
    expect(COVERAGE_COLUMNS).toBe(50);
  });
});
