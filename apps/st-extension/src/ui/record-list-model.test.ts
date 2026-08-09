import { describe, expect, it } from "vitest";
import type {
  MemoryRecord,
  MemoryRecordSource,
  MemoryRevisionSource,
} from "@ste-memory/core/memory";
import {
  buildRecordRowViewModels,
  recordSourceLabel,
  revisionSourceLabel,
  revisionSummaryLine,
} from "./record-list-model.ts";

function source(type: "manual" | "source"): MemoryRecordSource {
  return type === "manual"
    ? { type: "manual" }
    : { type: "source", sourceTime: null, sourceLocation: null };
}

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "record-1" as MemoryRecord["id"],
    memorySpaceId: "space-1" as MemoryRecord["memorySpaceId"],
    tableId: "table-1" as MemoryRecord["tableId"],
    payload: {},
    fieldEvidence: {},
    displayText: "显示文本",
    source: { type: "manual" },
    revisionId: "rev-1" as MemoryRecord["revisionId"],
    revisionSource: "user",
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T01:02:03.000Z",
    ...overrides,
  };
}

describe("recordSourceLabel / revisionSourceLabel（来源徽标文案）", () => {
  it("manual=手动，source=Agent", () => {
    expect(recordSourceLabel({ type: "manual" })).toBe("手动");
    expect(recordSourceLabel({ type: "source", sourceTime: null, sourceLocation: null })).toBe(
      "Agent",
    );
  });

  it("修订来源：user=手动修订，agent=Agent 修订", () => {
    expect(revisionSourceLabel("user" as MemoryRevisionSource)).toBe("手动修订");
    expect(revisionSourceLabel("agent" as MemoryRevisionSource)).toBe("Agent 修订");
  });
});

describe("buildRecordRowViewModels（列表行视图模型）", () => {
  it("显示文本优先读时计算表，缺表降级存储 displayText", () => {
    const records = [record({ id: "r1" as MemoryRecord["id"] })];
    const rows = buildRecordRowViewModels(
      records,
      new Map([["r1" as MemoryRecord["id"], "读时文本"]]),
    );
    expect(rows[0]!.displayText).toBe("读时文本");

    const fallback = buildRecordRowViewModels(records, new Map());
    expect(fallback[0]!.displayText).toBe("显示文本");
  });

  it("来源徽标文案与更新时间映射", () => {
    const rows = buildRecordRowViewModels(
      [record({ id: "r1" as MemoryRecord["id"], source: source("source") })],
      new Map(),
    );
    expect(rows[0]!.sourceLabel).toBe("Agent");
    expect(rows[0]!.updatedAt).toBe("2026-08-09T01:02:03.000Z");
    expect(rows[0]!.id).toBe("r1");
  });
});

describe("revisionSummaryLine（详情修订摘要）", () => {
  it("无历史 → null", () => {
    expect(revisionSummaryLine([])).toBeNull();
  });

  it("取最新一条（数组首位）的来源与时间，并带修订总数", () => {
    const line = revisionSummaryLine([
      { revisionSource: "user" as MemoryRevisionSource, archivedAt: "2026-08-09T02:00:00.000Z" },
      { revisionSource: "agent" as MemoryRevisionSource, archivedAt: "2026-08-08T10:00:00.000Z" },
    ]);
    expect(line).toBe("手动修订 · 2026-08-09 02:00 · 共 2 次修订");
  });
});
