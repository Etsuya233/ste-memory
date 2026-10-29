import { describe, expect, it } from "vitest";
import {
  BUILTIN_AGENT_PRESET_ID,
  type AgentPresetSettings,
} from "../../../features/agent-presets/preset-model.ts";
import type { CleaningRule } from "../../../features/cleaning/cleaning-rules.ts";
import type { FillTaskView, FloorLedgerEntry } from "../../../features/fill-tasks/fill-task.ts";
import {
  agentPresetLabel,
  buildFillSubmitSummary,
  cleaningRuleLabel,
  isAgentPresetOverrideStale,
  isCleaningRuleDisabled,
} from "./task-submit-summary.ts";

const ledger: readonly FloorLedgerEntry[] = [
  { floor: 1, status: "processed" },
  { floor: 2, status: "processed" },
  { floor: 3, status: "error" },
];

function task(overrides: Partial<FillTaskView> = {}): FillTaskView {
  return {
    runId: "run-1",
    memorySpaceId: "space-a",
    kind: "floor",
    initText: null,
    from: 2,
    to: 5,
    blockSize: 2,
    chatId: "chat-a",
    status: "queued",
    errorMessage: null,
    createdAt: "2026-10-28T09:00:00.000Z",
    updatedAt: "2026-10-28T09:00:00.000Z",
    processedCount: 0,
    totalCount: 4,
    ...overrides,
  } as FillTaskView;
}

const rules: readonly CleaningRule[] = [
  {
    id: "rule-1",
    name: "去思考",
    enabled: true,
    keepTags: [],
    excludeTags: [{ pre: "<think>", post: "</think>" }],
  },
  {
    id: "rule-2",
    name: "已停用",
    enabled: false,
    keepTags: [],
    excludeTags: [],
  },
];

const presets: AgentPresetSettings = {
  activePresetId: "preset-global",
  presets: [
    { id: "preset-global", name: "全局预设", messages: [] },
    { id: "preset-chat", name: "对话预设", messages: [] },
  ],
};

describe("buildFillSubmitSummary", () => {
  it("汇总楼层、批次、已处理和排队覆盖数量", () => {
    expect(
      buildFillSubmitSummary({
        fromText: "1",
        toText: "6",
        blockText: "2",
        chatLength: 10,
        ledger,
        pending: [task({ from: 2, to: 4 })],
      }),
    ).toEqual({
      kind: "ok",
      summary: {
        from: 1,
        to: 6,
        floorCount: 6,
        blockSize: 2,
        batchCount: 3,
        processedCount: 2,
        errorCount: 1,
        plannedCount: 3,
      },
    });
  });

  it("沿用范围与批次校验文案", () => {
    expect(
      buildFillSubmitSummary({
        fromText: "0",
        toText: "10",
        blockText: "2",
        chatLength: 10,
        ledger,
        pending: [],
      }),
    ).toMatchObject({ kind: "error", message: expect.stringContaining("超出范围") });
    expect(
      buildFillSubmitSummary({
        fromText: "0",
        toText: "3",
        blockText: "0",
        chatLength: 10,
        ledger,
        pending: [],
      }),
    ).toMatchObject({ kind: "error", message: expect.stringContaining(">= 1") });
  });

  it("空输入按整段与默认批次处理", () => {
    const result = buildFillSubmitSummary({
      fromText: "",
      toText: "",
      blockText: "",
      chatLength: 10,
      ledger: [],
      pending: [],
    });
    expect(result).toMatchObject({
      kind: "ok",
      summary: { from: 0, to: 9, floorCount: 10, blockSize: 20, batchCount: 1 },
    });
  });
});

describe("chat config labels", () => {
  it("清洗规则显示未选择、启用与停用", () => {
    expect(cleaningRuleLabel(rules, undefined)).toBe("不使用清洗规则");
    expect(cleaningRuleLabel(rules, "rule-1")).toBe("去思考");
    expect(cleaningRuleLabel(rules, "rule-2")).toContain("已停用");
    expect(cleaningRuleLabel(rules, "missing")).toContain("已不存在");
    expect(isCleaningRuleDisabled(rules, "rule-2")).toBe(true);
    expect(isCleaningRuleDisabled(rules, "rule-1")).toBe(false);
  });

  it("Agent 预设显示跟随全局、本对话指定与失效回退", () => {
    expect(agentPresetLabel(presets, undefined)).toBe("跟随全局：全局预设");
    expect(agentPresetLabel(presets, BUILTIN_AGENT_PRESET_ID)).toBe("系统默认");
    expect(agentPresetLabel(presets, "preset-chat")).toBe("本对话：对话预设");
    expect(agentPresetLabel(presets, "missing")).toContain("跟随全局：全局预设");
    expect(isAgentPresetOverrideStale(presets, "missing")).toBe(true);
    expect(isAgentPresetOverrideStale(presets, "preset-chat")).toBe(false);
    expect(isAgentPresetOverrideStale(presets, BUILTIN_AGENT_PRESET_ID)).toBe(false);
  });
});
