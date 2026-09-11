import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { MemorySpaceId } from "../memory/index.ts";
import {
  createFillAgentTurnCollector,
  fillAgentContextLog,
  fillAgentTurnLog,
} from "./fill-agent-log.ts";
import type { FillTask } from "./fill-task.ts";
import type { LogAppendInput } from "../logging/log.ts";
import {
  assistantMessage,
  textMessage,
  thinkingMessage,
  toolCallMessage,
} from "./stream-fn-support.ts";

/**
 * 采集器单测：直接喂 turn_end 事件（runFillAgent onEvent 通道转发，
 * 与真实循环同一事件契约），断言 turn 行内容、轮次顺序与级别。
 */

const SPACE_ID = "space-1" as MemorySpaceId;

function floorTask(): FillTask {
  return {
    runId: "run-fixed",
    memorySpaceId: SPACE_ID,
    from: 2,
    to: 3,
    blockSize: 2,
    kind: "floor",
    initText: null,
    chatId: "chat-1",
    status: "running",
    errorMessage: null,
    createdAt: "2026-07-30T01:02:03.000Z",
    updatedAt: "2026-07-30T01:02:03.000Z",
  };
}

function turnEndEvent(
  message: AgentMessage,
  toolResults: readonly AgentMessage[] = [],
): AgentEvent {
  return { type: "turn_end", message, toolResults } as AgentEvent;
}

function collector(rows: LogAppendInput[]): ReturnType<typeof createFillAgentTurnCollector> {
  return createFillAgentTurnCollector({
    task: floorTask(),
    batch: 2,
    from: 2,
    to: 3,
    appendLog: async (input) => {
      rows.push(input);
    },
  });
}

describe("createFillAgentTurnCollector（ADR 0016「上下文 + 轮次」形态）", () => {
  it("turn_end 每轮一条 turn 行：思考/输出/停止原因/用量同轮成对（含工具调用参数与结果）", async () => {
    const rows: LogAppendInput[] = [];
    const collected = collector(rows);
    collected.listener(
      turnEndEvent(
        assistantMessage(
          [
            thinkingMessage("先确认现有角色"),
            textMessage("先查询"),
            toolCallMessage("call-1", "query_records", { table: "characters" }),
          ],
          "toolUse",
        ),
        [
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "query_records",
            content: [{ type: "text", text: "未找到匹配记录" }],
            isError: false,
            timestamp: 1,
          },
        ],
      ),
    );
    collected.listener(
      turnEndEvent(assistantMessage([thinkingMessage("无需变更"), textMessage("已确认")], "stop")),
    );
    await collected.flush();

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.type, row.key, row.level])).toEqual([
      ["fill-agent", "run-fixed", "info"],
      ["fill-agent", "run-fixed", "info"],
    ]);
    expect(JSON.parse(rows[0]!.text)).toEqual({
      batch: 2,
      block: { from: 2, to: 3 },
      kind: "turn",
      round: 1,
      thinking: "先确认现有角色",
      output: "先查询",
      stopReason: "toolUse",
      usage: { input: 0, output: 0, totalTokens: 0 },
      tools: [
        {
          id: "call-1",
          name: "query_records",
          args: { table: "characters" },
          result: "未找到匹配记录",
          isError: false,
        },
      ],
    });
    expect(JSON.parse(rows[1]!.text)).toMatchObject({
      round: 2,
      stopReason: "stop",
      tools: [],
    });
  });

  it("失败轮：error 级，errorMessage 与停止原因落行", async () => {
    const rows: LogAppendInput[] = [];
    const collected = collector(rows);
    collected.listener(
      turnEndEvent(assistantMessage([textMessage("模型炸了")], "error", "模型炸了")),
    );
    await collected.flush();

    expect(rows[0]!.level).toBe("error");
    expect(JSON.parse(rows[0]!.text)).toMatchObject({
      stopReason: "error",
      errorMessage: "模型炸了",
      tools: [],
    });
  });

  it("工具调用无结果（中断时工具未执行）：tools 只留调用参数，不带 result 字段", async () => {
    const rows: LogAppendInput[] = [];
    const collected = collector(rows);
    collected.listener(
      turnEndEvent(
        assistantMessage([toolCallMessage("call-1", "mutate", { op: "create" })], "toolUse"),
        [],
      ),
    );
    await collected.flush();

    expect(JSON.parse(rows[0]!.text).tools).toEqual([
      { id: "call-1", name: "mutate", args: { op: "create" } },
    ]);
  });

  it("轮次行按事件到达顺序递增（写入队列保序）", async () => {
    const rows: LogAppendInput[] = [];
    const collected = collector(rows);
    for (let round = 1; round <= 5; round += 1) {
      collected.listener(turnEndEvent(assistantMessage([textMessage(`回答 ${round}`)], "stop")));
    }
    await collected.flush();

    expect(rows.map((row) => JSON.parse(row.text).round)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("fillAgentContextLog / fillAgentTurnLog 行构造", () => {
  it("上下文行：楼层区间、系统提示词、预设与本批消息分列", () => {
    const row = fillAgentContextLog({
      task: floorTask(),
      batch: 1,
      from: 0,
      to: 1,
      systemPrompt: "你是爱丽丝的填表助手",
      preset: [
        { role: "user", text: "请按提示填写" },
        { role: "assistant", text: "明白" },
      ],
      input: [{ role: "user", text: "消息 0：…" }],
    });
    expect(JSON.parse(row.text)).toEqual({
      batch: 1,
      block: { from: 0, to: 1 },
      kind: "context",
      systemPrompt: "你是爱丽丝的填表助手",
      preset: [
        { role: "user", text: "请按提示填写" },
        { role: "assistant", text: "明白" },
      ],
      input: [{ role: "user", text: "消息 0：…" }],
    });
  });

  it("初始化任务：上下文行省略 block（无楼层），turn 行同样省略", () => {
    const task = { ...floorTask(), kind: "init" as const, initText: "设定" };
    const context = fillAgentContextLog({
      task,
      batch: 1,
      from: 0,
      to: 0,
      systemPrompt: "核心默认提示词",
      preset: [],
      input: [{ role: "user", text: "初始化文本" }],
    });
    expect(JSON.parse(context.text)).toMatchObject({
      batch: 1,
      kind: "context",
      preset: [],
    });
    expect(JSON.parse(context.text)).not.toHaveProperty("block");

    const turn = fillAgentTurnLog({
      task,
      batch: 1,
      from: 0,
      to: 0,
      round: 1,
      message: assistantMessage([textMessage("已提交")], "stop"),
      toolResults: [],
    });
    expect(JSON.parse(turn.text)).toMatchObject({ batch: 1, kind: "turn", round: 1 });
    expect(JSON.parse(turn.text)).not.toHaveProperty("block");
  });

  it("思考/文本多块拼接为单一字段", async () => {
    const event = turnEndEvent(
      assistantMessage(
        [
          thinkingMessage("想 1"),
          thinkingMessage("想 2"),
          textMessage("答 1"),
          textMessage("答 2"),
        ],
        "stop",
      ),
    );
    const rows: LogAppendInput[] = [];
    const listener = createFillAgentTurnCollector({
      task: floorTask(),
      batch: 1,
      from: 0,
      to: 1,
      appendLog: async (input) => {
        rows.push(input);
      },
    }).listener;
    listener(event);
    await new Promise((resolve) => setImmediate(resolve));
    expect(JSON.parse(rows[0]!.text)).toMatchObject({
      thinking: "想 1想 2",
      output: "答 1答 2",
    });
  });
});
