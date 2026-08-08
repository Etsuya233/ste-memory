/**
 * 「按楼层跳转 ST 消息」的纯判定部分（证据楼层 chip 的底层能力，spec 决策 11）。
 *
 * 同步楼层 = ST 消息数组下标（ADR 0003），只对「存在于当前已加载对话」的楼层有效：
 * 越界（含空对话、负数、非整数、NaN）一律 out-of-range，由宿主决定提示文案。
 * 宿主（StChatAdapter.scrollToFloor）在判定通过后才做 DOM 滚动与高亮——ST DOM 不测
 * （测试决策），判定逻辑在这里独立测试。
 */

export type FloorJumpDecision =
  | { readonly kind: "ok" }
  | { readonly kind: "out-of-range"; readonly chatLength: number };

export function resolveFloorJump(floor: number, chatLength: number): FloorJumpDecision {
  const inRange =
    Number.isInteger(floor) &&
    floor >= 0 &&
    Number.isInteger(chatLength) &&
    floor < chatLength;
  return inRange ? { kind: "ok" } : { kind: "out-of-range", chatLength };
}
