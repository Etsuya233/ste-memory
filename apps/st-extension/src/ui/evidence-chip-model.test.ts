import { describe, expect, it } from "vitest";
import type { MemoryEvidence } from "@ste-memory/core/memory";
import {
  buildMessageExcerpt,
  evidenceChipViewModels,
  floorJumpHint,
  recordHasEvidence,
  type FloorJumpOutcome,
} from "./evidence-chip-model.ts";

function floorEvidence(sourceId: string | number): MemoryEvidence {
  return {
    evidence_id: `ev-${sourceId}` as MemoryEvidence["evidence_id"],
    source_type: "sync_floor",
    source_id: sourceId,
    storage_mode: "reference",
    extraProps: {},
  };
}

describe("evidenceChipViewModels（证据 → chip 视图模型）", () => {
  it("sync_floor 数字/数字字符串 → 楼层 chip", () => {
    expect(evidenceChipViewModels([floorEvidence(7)])).toEqual([{ kind: "floor", floor: 7 }]);
    expect(evidenceChipViewModels([floorEvidence("3")])).toEqual([{ kind: "floor", floor: 3 }]);
  });

  it("sync_floor 非法 id / 未知来源类型 → 中性徽标", () => {
    expect(evidenceChipViewModels([floorEvidence("abc")])).toEqual([
      { kind: "generic", sourceType: "sync_floor" },
    ]);
    expect(evidenceChipViewModels([floorEvidence(-2)])).toEqual([
      { kind: "generic", sourceType: "sync_floor" },
    ]);
    expect(
      evidenceChipViewModels([
        {
          evidence_id: "ev-x" as MemoryEvidence["evidence_id"],
          source_type: "message",
          source_id: 5,
          storage_mode: "snapshot",
          content: "原文",
          extraProps: {},
        },
      ]),
    ).toEqual([{ kind: "generic", sourceType: "message" }]);
  });

  it("空数组 → 空", () => {
    expect(evidenceChipViewModels([])).toEqual([]);
  });
});

describe("floorJumpHint（跳转结果 → 提示文案）", () => {
  it("成功无提示，越界/未加载有中文 warning", () => {
    expect(floorJumpHint({ kind: "jumped" })).toBeNull();
    expect(floorJumpHint({ kind: "out-of-range", chatLength: 12 })).toBe(
      "楼层已越界（当前对话共 12 条消息）",
    );
    expect(floorJumpHint({ kind: "not-loaded" })).toBe("对应消息尚未加载，无法跳转");
  });
});

describe("buildMessageExcerpt（原文摘录）", () => {
  it("超长截断附省略号并标记 truncated", () => {
    const excerpt = buildMessageExcerpt(
      { floor: 3, content: "一二三四五六", name: "爱丽丝", isUser: false },
      4,
    );
    expect(excerpt).toEqual({
      floor: 3,
      name: "爱丽丝",
      isUser: false,
      content: "一二三四…",
      truncated: true,
    });
  });

  it("未超长原样返回", () => {
    const excerpt = buildMessageExcerpt(
      { floor: 0, content: "短消息", name: "User", isUser: true },
      120,
    );
    expect(excerpt.content).toBe("短消息");
    expect(excerpt.truncated).toBe(false);
    expect(excerpt.isUser).toBe(true);
  });
});

describe("recordHasEvidence（无证据标注判定）", () => {
  it("任意字段有证据 = true", () => {
    expect(recordHasEvidence({ f1: [floorEvidence(1)] })).toBe(true);
  });

  it("空对象 / undefined / 全空数组 = false", () => {
    expect(recordHasEvidence({})).toBe(false);
    expect(recordHasEvidence(undefined)).toBe(false);
    expect(recordHasEvidence({ f1: [] })).toBe(false);
  });
});

// 类型层面保证 FloorJumpOutcome 与适配器返回同构（编译期校验）
const outcome: FloorJumpOutcome = { kind: "jumped" };
void outcome;
