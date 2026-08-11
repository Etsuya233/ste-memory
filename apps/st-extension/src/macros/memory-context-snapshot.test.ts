import type {
  MemoryRecord,
  MemoryRecordId,
  MemoryRevisionId,
  MemorySpaceId,
  MemoryTableId,
} from "@ste-memory/core/memory";
import { describe, expect, it } from "vitest";
import {
  assembleMemoryContextSnapshot,
  TRUNCATION_MARKER,
  truncateWithMarker,
  type MemoryContextTableInput,
} from "./memory-context-snapshot.ts";

/**
 * 快照组装纯函数测试（ticket 15，spec 输出格式契约）：
 * 按启用表分组（表名标题行 + 记录显示文本一行）、空表省略、停用表不参与、
 * 组内最新在前、上限尾部截断 + 标记。
 */

const BASE = "2026-07-28T00:00:00.000Z";

function record(
  id: string,
  displayText: string,
  updatedAt: string = BASE,
): MemoryRecord {
  return {
    id: id as MemoryRecordId,
    memorySpaceId: "space-1" as MemorySpaceId,
    tableId: "table-1" as MemoryTableId,
    payload: {},
    fieldEvidence: {},
    displayText,
    source: { type: "manual" },
    revisionId: "r" as MemoryRevisionId,
    revisionSource: "user",
    createdAt: BASE,
    updatedAt,
  };
}

function table(name: string, records: readonly MemoryRecord[], enabled = true): MemoryContextTableInput {
  return { name, enabled, records };
}

describe("assembleMemoryContextSnapshot", () => {
  it("格式契约：按启用表分组，表名标题行 + 每条记录一行，组间空行", () => {
    const input = [
      table("人物", [
        record("a", "张三：身份/定位…", "2026-07-28T02:00:00.000Z"),
        record("b", "李四：…", "2026-07-28T01:00:00.000Z"),
      ]),
      table("地点", [record("c", "王城")]),
    ];
    expect(assembleMemoryContextSnapshot(input, 2000)).toBe(
      "【人物】\n张三：身份/定位…\n李四：…\n\n【地点】\n王城",
    );
  });

  it("空表省略；停用表不参与（含停用表有记录）", () => {
    const input = [
      table("空表", []),
      table("停用表", [record("x", "不应出现")], false),
      table("启用表", [record("a", "出现")]),
    ];
    expect(assembleMemoryContextSnapshot(input, 2000)).toBe("【启用表】\n出现");
  });

  it("组内最新在前（updatedAt 倒序，id 兜底确定性）", () => {
    const input = [
      table("人物", [
        record("a", "旧", "2026-07-28T00:00:00.000Z"),
        record("b", "新", "2026-07-28T02:00:00.000Z"),
        record("c", "中", "2026-07-28T01:00:00.000Z"),
      ]),
    ];
    expect(assembleMemoryContextSnapshot(input, 2000)).toBe("【人物】\n新\n中\n旧");
  });

  it("记录显示文本/表名含换行：单行化（格式契约「每条记录一行」）", () => {
    const input = [
      table("人物\n表", [record("a", "第一行\n第二行")]),
    ];
    expect(assembleMemoryContextSnapshot(input, 2000)).toBe("【人物 表】\n第一行 第二行");
  });

  it("无启用表/全空 → 空串", () => {
    expect(assembleMemoryContextSnapshot([], 2000)).toBe("");
    expect(assembleMemoryContextSnapshot([table("空表", [])], 2000)).toBe("");
    expect(assembleMemoryContextSnapshot([table("停用表", [record("a", "x")], false)], 2000)).toBe(
      "",
    );
  });

  it("超上限：尾部截断并附标记（内容保留头部最新记忆）", () => {
    const input = [
      table("人物", [
        record("a", "第一条记录", "2026-07-28T02:00:00.000Z"),
        record("b", "第二条记录", "2026-07-28T01:00:00.000Z"),
      ]),
    ];
    // 整段 = 「【人物】\n第一条记录\n第二条记录」= 16 字符；上限 15 → 截断到第一条记录行内
    const result = assembleMemoryContextSnapshot(input, 15);
    expect(result).toBe(`【人物】\n第一条${TRUNCATION_MARKER}`);
    expect(result.length).toBe(15);
  });

  it("恰好等于上限：不截断", () => {
    const text = "【人物】\n第一条记录";
    const input = [table("人物", [record("a", "第一条记录")])];
    expect(assembleMemoryContextSnapshot(input, text.length)).toBe(text);
  });

  it("上限小于标记长：输出仅标记（截断语义仍表达）", () => {
    const input = [table("人物", [record("a", "第一条记录")])];
    expect(assembleMemoryContextSnapshot(input, 3)).toBe(TRUNCATION_MARKER);
  });

  it("上限 0：输出仅标记", () => {
    const input = [table("人物", [record("a", "第一条记录")])];
    expect(assembleMemoryContextSnapshot(input, 0)).toBe(TRUNCATION_MARKER);
  });
});

describe("truncateWithMarker", () => {
  it("未超限原样返回", () => {
    expect(truncateWithMarker("abc", 3)).toBe("abc");
    expect(truncateWithMarker("abc", 100)).toBe("abc");
  });

  it("超限截断 + 标记；总长 = 上限（上限不小于标记长）", () => {
    const result = truncateWithMarker("abcdefghij", 9);
    expect(result).toBe(`ab${TRUNCATION_MARKER}`);
    expect(result.length).toBe(9);
  });
});
