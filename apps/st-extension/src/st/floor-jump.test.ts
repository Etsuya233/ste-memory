import { describe, expect, it } from "vitest";
import { resolveFloorJump } from "./floor-jump.ts";

describe("resolveFloorJump（楼层跳转判定）", () => {
  it("楼层在已加载对话范围内 → ok", () => {
    expect(resolveFloorJump(0, 3)).toEqual({ kind: "ok" });
    expect(resolveFloorJump(2, 3)).toEqual({ kind: "ok" });
  });

  it("越界（>= chat 长度）→ out-of-range，带 chatLength 供 UI 提示", () => {
    expect(resolveFloorJump(3, 3)).toEqual({ kind: "out-of-range", chatLength: 3 });
    expect(resolveFloorJump(100, 3)).toEqual({ kind: "out-of-range", chatLength: 3 });
  });

  it("空对话 / 负数 / 非整数 / NaN 一律 out-of-range", () => {
    expect(resolveFloorJump(0, 0)).toEqual({ kind: "out-of-range", chatLength: 0 });
    expect(resolveFloorJump(-1, 3)).toEqual({ kind: "out-of-range", chatLength: 3 });
    expect(resolveFloorJump(1.5, 3)).toEqual({ kind: "out-of-range", chatLength: 3 });
    expect(resolveFloorJump(Number.NaN, 3)).toEqual({ kind: "out-of-range", chatLength: 3 });
    expect(resolveFloorJump(1, Number.NaN)).toEqual({ kind: "out-of-range", chatLength: Number.NaN });
  });
});
