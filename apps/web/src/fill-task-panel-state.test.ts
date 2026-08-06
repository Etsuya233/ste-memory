import { describe, expect, it } from "vitest";
import { availableFillTaskControls } from "./fill-task-panel-state.ts";

describe("availableFillTaskControls", () => {
  it("运行中可暂停或中止", () => {
    expect(availableFillTaskControls("running", null)).toEqual(["pause", "cancel"]);
  });

  it("已暂停可恢复或中止", () => {
    expect(availableFillTaskControls("paused", null)).toEqual(["resume", "cancel"]);
  });

  it("暂停请求中只能中止（不能重复暂停），中止请求中不可再请求", () => {
    expect(availableFillTaskControls("pause_requested", null)).toEqual(["cancel"]);
    expect(availableFillTaskControls("queued", null)).toEqual(["cancel"]);
    expect(availableFillTaskControls("cancel_requested", null)).toEqual([]);
  });

  it("终态任务没有任何控制动作", () => {
    for (const status of ["cancelled", "succeeded", "failed", "interrupted"] as const) {
      expect(availableFillTaskControls(status, null)).toEqual([]);
    }
  });

  it("请求进行中禁用全部控制（避免重复提交）", () => {
    for (const status of ["running", "paused", "pause_requested"] as const) {
      expect(availableFillTaskControls(status, "pause")).toEqual([]);
      expect(availableFillTaskControls(status, "resume")).toEqual([]);
      expect(availableFillTaskControls(status, "cancel")).toEqual([]);
    }
  });
});
