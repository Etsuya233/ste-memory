import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "../api/memory-records.ts";
import { formatMemoryFieldValue } from "./memory-record-value.ts";

const reference = {
  id: "record-1",
  displayText: "港口",
} as MemoryRecord;

describe("formatMemoryFieldValue", () => {
  it("renders reference display text while preserving its stable ID", () => {
    expect(formatMemoryFieldValue("record-1", "未填写", [reference])).toBe("港口 · record-1");
    expect(formatMemoryFieldValue(["record-1"], "未填写", [reference])).toBe("港口 · record-1");
  });

  it("keeps a historical reference ID visible when its current target is gone", () => {
    expect(formatMemoryFieldValue("record-deleted", "未填写", [])).toBe("record-deleted");
  });
});
