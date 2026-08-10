import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { StBackendsModel } from "./st-completion-settings.ts";
import { ST_GENERATE_ENDPOINT, StBackendsLlmAdapter } from "./st-backends-llm.ts";

/**
 * 交叉验证（ticket 12 验收标准「tools 透传可用」的最强证明）：
 * pi-agent-core 的 Agent 以我们的 streamFn 跑完整两轮工具循环——
 * 第一轮模型发 tool_calls（SSE 增量）→ 工具执行 → 第二轮模型输出文本。
 * 全程 mock fetch 提供预排 SSE，不依赖真实模型。
 */

const TEST_CONFIG = {
  source: "openai",
  modelName: "gpt-4o",
  maxTokens: 2048,
  contextWindow: 8192,
};

function testModel(): StBackendsModel {
  return {
    id: "gpt-4o",
    name: "gpt-4o",
    api: "openai-completions",
    provider: "sillytavern",
    baseUrl: "/api/backends/chat-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 300,
    stSource: "openai",
  };
}

function sseEvent(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** 预排 SSE 流：第一轮工具调用，第二轮文本回复 */
function toolThenTextResponses() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body = JSON.parse(init?.body as string) as { messages: unknown[]; tools?: unknown[] };
    const isSecondTurn = body.messages.some((m) => (m as { role?: string }).role === "tool");
    const encoder = new TextEncoder();
    const chunks: string[] = isSecondTurn
      ? [
          sseEvent({ id: "cmpl-2", choices: [{ index: 0, delta: { content: "查好了：共 2 条记录" }, finish_reason: null }] }),
          sseEvent({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] }),
          "data: [DONE]\n\n",
        ]
      : [
          sseEvent({
            id: "cmpl-1",
            choices: [{
              index: 0,
              delta: { content: null, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "query_records", arguments: "" } }] },
              finish_reason: null,
            }],
          }),
          sseEvent({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"table\":" } }] }, finish_reason: null }] }),
          sseEvent({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"characters\"}" } }] }, finish_reason: "tool_calls" }] }),
        ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  return { fn, calls };
}

const queryTool: AgentTool = {
  name: "query_records",
  label: "查询记录",
  description: "按表查询记忆记录",
  parameters: Type.Object({ table: Type.String() }),
  execute: async (toolCallId) => ({
    content: [{ type: "text", text: "云烬、白鹭" }],
    details: { toolCallId },
  }),
};

describe("Agent × StBackendsLlmAdapter（两轮工具循环交叉验证）", () => {
  it("第一轮 tool_calls → 工具执行 → 第二轮文本；请求体 tools 透传 + 工具结果回传", async () => {
    const { fn, calls } = toolThenTextResponses();
    const adapter = new StBackendsLlmAdapter({
      config: TEST_CONFIG,
      fetchImpl: fn,
      getCsrfToken: async () => "csrf-t",
      log: { warn: vi.fn(), error: vi.fn() },
    });

    const agent = new Agent({
      initialState: {
        systemPrompt: "你是记忆助手。",
        model: testModel(),
        tools: [queryTool],
      },
      streamFn: adapter.streamFn,
      convertToLlm: (messages) =>
        messages.filter((m): m is Message => ["user", "assistant", "toolResult"].includes(m.role)),
    });

    const events: string[] = [];
    agent.subscribe((event) => {
      events.push(event.type);
    });

    await agent.prompt("查一下角色表");
    await agent.waitForIdle();

    const transcript = agent.state.messages;
    // 两轮 assistant 消息：工具调用 + 最终回答
    const assistantMessages = transcript.filter((m) => m.role === "assistant");
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0]!.content.some((b) => b.type === "toolCall")).toBe(true);
    const finalText = assistantMessages[1]!.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    expect(finalText).toContain("查好了");
    // 工具结果在对话里
    expect(transcript.some((m) => m.role === "toolResult" && m.toolName === "query_records")).toBe(true);
    // 事件序列覆盖完整生命周期
    expect(events).toContain("turn_end");
    expect(events).toContain("tool_execution_start");
    expect(events).toContain("tool_execution_end");
    expect(events).toContain("agent_end");

    // 请求形状：两次 generate 调用，tools 透传，第二轮带 tool 角色消息
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.url === ST_GENERATE_ENDPOINT)).toBe(true);
    const firstBody = JSON.parse(calls[0]!.init?.body as string);
    expect(firstBody.tools).toEqual([
      { type: "function", function: { name: "query_records", description: "按表查询记忆记录", parameters: { type: "object", properties: { table: { type: "string" } }, required: ["table"] } } },
    ]);
    const secondBody = JSON.parse(calls[1]!.init?.body as string);
    expect(
      (secondBody.messages as Array<{ role: string }>).some((m) => m.role === "tool"),
    ).toBe(true);
  });

  it("模型返回错误 stopReason 时 Agent 状态记录 errorMessage，不抛异常", async () => {
    const fn = (async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: null }, finish_reason: "content_filter" }] })}\n\n`));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    const adapter = new StBackendsLlmAdapter({
      config: TEST_CONFIG,
      fetchImpl: fn,
      getCsrfToken: async () => "csrf-t",
      log: { warn: vi.fn(), error: vi.fn() },
    });
    const agent = new Agent({
      initialState: { systemPrompt: "", model: testModel(), tools: [] },
      streamFn: adapter.streamFn,
    });
    await agent.prompt("hi");
    await agent.waitForIdle();
    expect(agent.state.errorMessage).toContain("content_filter");
  });
});
