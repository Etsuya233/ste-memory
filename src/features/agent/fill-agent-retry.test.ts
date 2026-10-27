import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import { runFillAgentWithRetry } from "./fill-agent-retry.ts";
import {
  assistantMessage,
  fakeModel,
  scriptedStreamFn,
  textMessage,
  toolCallMessage,
} from "./stream-fn-support.ts";

describe("填表 Agent 按轮重试", () => {
  it("保留断流草稿的独立事件和日志上下文，重试不重放成功工具，每轮独立预算", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "已写入" }],
      details: {},
    }));
    const contexts: unknown[] = [];
    let calls = 0;
    const streamFn = scriptedStreamFn((context) => {
      contexts.push(structuredClone(context.messages));
      calls++;
      if (calls === 1 || calls === 3)
        return assistantMessage(
          [textMessage("未完成的输出"), toolCallMessage("broken", "write", {})],
          "error",
          "500 Internal Server Error",
        );
      return calls === 2
        ? assistantMessage([toolCallMessage("ok", "write", {})], "toolUse")
        : assistantMessage([textMessage("完成")], "stop");
    });
    const agent = new Agent({
      initialState: {
        model: fakeModel(),
        tools: [
          {
            name: "write",
            label: "写入",
            description: "写入",
            parameters: Type.Object({}),
            execute,
          },
        ],
      },
      streamFn,
    });
    const events: AgentEvent[] = [];
    const scheduled = vi.fn();
    const result = await runFillAgentWithRetry(
      agent,
      [{ role: "user", content: "填写", timestamp: 1 }],
      { onEvent: (event) => events.push(event) },
      1000,
      { enabled: true, maxRetries: 1, baseDelayMs: 1 },
      { onRetryScheduled: scheduled },
    );
    expect(result.stopReason).toBe("stop");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(calls).toBe(4);
    expect(scheduled.mock.calls.map((call) => call[0])).toEqual([1, 1]);
    expect(contexts[1]).toEqual(contexts[0]);
    expect(contexts[3]).toEqual(contexts[2]);
    expect(JSON.stringify(contexts)).not.toContain("未完成的输出");
    expect(events.filter((event) => event.type === "turn_end")).toHaveLength(4);
    expect(events.filter((event) => event.type === "agent_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    expect(result.messages.filter((message) => message.role === "assistant")).toHaveLength(4);
  });

  it.each(["500 Internal Server Error", "401 Unauthorized", "insufficient_quota"])(
    "耗尽或不可重试时保留最终错误：%s",
    async (error) => {
      let calls = 0;
      const agent = new Agent({
        initialState: { model: fakeModel(), tools: [] },
        streamFn: scriptedStreamFn(() => {
          calls++;
          return assistantMessage([textMessage("半截")], "error", error);
        }),
      });
      const result = await runFillAgentWithRetry(
        agent,
        [{ role: "user", content: "填写", timestamp: 1 }],
        {},
        1000,
        { enabled: true, maxRetries: 2, baseDelayMs: 1 },
      );
      expect(result.errorMessage).toBe(error);
      expect(calls).toBe(error.startsWith("500") ? 3 : 1);
    },
  );

  it.each(["取消", "总超时"])("%s 能打断重试等待", async (reason) => {
    const controller = new AbortController();
    let calls = 0;
    const agent = new Agent({
      initialState: { model: fakeModel(), tools: [] },
      streamFn: scriptedStreamFn(() => {
        calls++;
        return assistantMessage([], "error", "500 Internal Server Error");
      }),
    });
    const result = await runFillAgentWithRetry(
      agent,
      [{ role: "user", content: "填写", timestamp: 1 }],
      { signal: controller.signal },
      reason === "总超时" ? 30 : 1000,
      { enabled: true, maxRetries: 2, baseDelayMs: 10000 },
      {
        onRetryScheduled: () => {
          if (reason === "取消") controller.abort();
        },
      },
    );
    expect(result.stopReason).toBe("aborted");
    expect(calls).toBe(1);
  });
});
