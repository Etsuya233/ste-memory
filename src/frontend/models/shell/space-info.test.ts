import { describe, expect, it } from "vitest";
import { formatDisplayTime } from "./space-info.ts";

describe("formatDisplayTime：UTC 确定性切片（YYYY-MM-DD HH:mm）", () => {
  it("毫秒与秒都截断到分钟", () => {
    expect(formatDisplayTime("2026-08-09T14:32:05.123Z")).toBe("2026-08-09 14:32");
    expect(formatDisplayTime("2026-01-02T03:04:00.000Z")).toBe("2026-01-02 03:04");
  });
});
