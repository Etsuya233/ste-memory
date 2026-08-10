import { describe, expect, it } from "vitest";
import { buildStGenerateBody, convertMessages } from "./st-backends-request.ts";
import type { StBackendsModel } from "./st-completion-settings.ts";

/** 最小 pi 模型（真实端口构造会读 ST 配置；测试直接造） */
function testModel(overrides: Partial<StBackendsModel> = {}): StBackendsModel {
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
    ...overrides,
  };
}

const TEST_CONFIG = {
  source: "openai",
  modelName: "gpt-4o",
  temperature: 1.1,
  topP: 0.9,
  frequencyPenalty: 0.2,
  presencePenalty: 0.3,
  maxTokens: 2048,
  contextWindow: 8192,
};

describe("buildStGenerateBody（ST 特有请求形状）", () => {
  it("ST 特有字段齐全：type/chat_completion_source/model/stream/include_reasoning", () => {
    const body = buildStGenerateBody(testModel(), { messages: [] }, undefined, TEST_CONFIG);
    expect(body).toEqual({
      type: "normal",
      messages: [],
      model: "gpt-4o",
      stream: true,
      chat_completion_source: "openai",
      include_reasoning: false,
      temperature: 1.1,
      top_p: 0.9,
      frequency_penalty: 0.2,
      presence_penalty: 0.3,
      max_tokens: 2048,
    });
  });

  it("生成参数缺失时省略字段（上游用默认值）", () => {
    const body = buildStGenerateBody(testModel({ stSource: "custom" }), { messages: [] }, undefined, {
      source: "custom",
      modelName: "m",
      maxTokens: 300,
      contextWindow: 4096,
    });
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.max_tokens).toBe(300);
    expect(body.chat_completion_source).toBe("custom");
  });

  it("显式流式选项优先于 ST 配置（temperature/maxTokens）", () => {
    const body = buildStGenerateBody(
      testModel(),
      { messages: [] },
      { temperature: 0.2, maxTokens: 8000 },
      TEST_CONFIG,
    );
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(8000);
  });

  it("有工具时透传 tools + tool_choice: auto；无工具不带", () => {
    const withTools = buildStGenerateBody(
      testModel(),
      { messages: [], tools: [{ name: "query_records", description: "查询记录", parameters: {} }] },
      undefined,
      TEST_CONFIG,
    );
    expect(withTools.tools).toEqual([
      {
        type: "function",
        function: { name: "query_records", description: "查询记录", parameters: {} },
      },
    ]);
    expect(withTools.tool_choice).toBe("auto");

    const withoutTools = buildStGenerateBody(testModel(), { messages: [] }, undefined, TEST_CONFIG);
    expect(withoutTools.tools).toBeUndefined();
    expect(withoutTools.tool_choice).toBeUndefined();
  });
});

describe("convertMessages（pi Context → OpenAI 消息）", () => {
  it("system prompt → system 消息；user 字符串原样", () => {
    const messages = convertMessages({
      systemPrompt: "你是填表助手",
      messages: [{ role: "user", content: "你好", timestamp: 1 }],
    });
    expect(messages).toEqual([
      { role: "system", content: "你是填表助手" },
      { role: "user", content: "你好" },
    ]);
  });

  it("assistant：文本 + tool_calls（arguments 序列化为 JSON 字符串）", () => {
    const messages = convertMessages({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "我来查一下" },
            { type: "toolCall", id: "call_1", name: "query_records", arguments: { table: "characters", page: 1 } },
          ],
          api: "openai-completions",
          provider: "sillytavern",
          model: "gpt-4o",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 1,
        },
      ],
    });
    expect(messages[0]).toEqual({
      role: "assistant",
      content: "我来查一下",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "query_records", arguments: JSON.stringify({ table: "characters", page: 1 }) },
        },
      ],
    });
  });

  it("assistant 只有工具调用时省略 content；空 assistant（无内容无工具）跳过", () => {
    const messages = convertMessages({
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "c2", name: "x", arguments: {} }],
          api: "openai-completions",
          provider: "sillytavern",
          model: "m",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [],
          api: "openai-completions",
          provider: "sillytavern",
          model: "m",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 2,
        },
      ],
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      role: "assistant",
      tool_calls: [{ id: "c2", type: "function", function: { name: "x", arguments: "{}" } }],
    });
  });

  it("toolResult → tool 角色 + tool_call_id；空结果用占位文本", () => {
    const messages = convertMessages({
      messages: [
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "query_records",
          content: [{ type: "text", text: "2 条记录" }],
          isError: false,
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call_2",
          toolName: "x",
          content: [],
          isError: false,
          timestamp: 2,
        },
      ],
    });
    expect(messages).toEqual([
      { role: "tool", content: "2 条记录", tool_call_id: "call_1" },
      { role: "tool", content: "(no tool output)", tool_call_id: "call_2" },
    ]);
  });
});
