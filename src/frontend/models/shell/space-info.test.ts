import { describe, expect, it } from "vitest";
import { formatDisplayTime, snapshotSaveSummary } from "./space-info.ts";

describe("formatDisplayTime：UTC 确定性切片（YYYY-MM-DD HH:mm）", () => {
  it("毫秒与秒都截断到分钟", () => {
    expect(formatDisplayTime("2026-08-09T14:32:05.123Z")).toBe("2026-08-09 14:32");
    expect(formatDisplayTime("2026-01-02T03:04:00.000Z")).toBe("2026-01-02 03:04");
  });
});

describe("snapshotSaveSummary", () => {
  it("展示已保存时间与已提交未保存错误", () => {
    expect(snapshotSaveSummary({ kind: "idle" })).toBe("尚未写入对话文件");
    expect(
      snapshotSaveSummary({
        kind: "saved",
        identity: "chat",
        lastWrittenAt: "2026-08-10T01:02:03.000Z",
        sizeBytes: 15360,
      }),
    ).toBe("上次写回 2026-08-10 01:02 · 15.0 KB");
    expect(
      snapshotSaveSummary({
        kind: "failed",
        identity: "chat",
        operation: "update",
        error: "disk",
        humanMsg: "已提交、未保存：disk",
      }),
    ).toBe("已提交、未保存：disk");
  });
});
