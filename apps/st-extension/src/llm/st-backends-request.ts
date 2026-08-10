import type { Context, Message, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import type { StBackendsModel } from "./st-completion-settings.ts";
import type { StChatCompletionConfig } from "./st-completion-settings.ts";

/**
 * ST backends 同源代理请求体（未文档化契约集中隔离在本模块）。
 *
 * 形状依据（ST 1.18.0 release 源码已核实）：
 * - `POST /api/backends/chat-completions/generate`（src/endpoints/backends/
 *   chat-completions.js:2157）按 `chat_completion_source` 派发，通用路径转发
 *   messages/model/temperature/max_tokens/stream/…，tools/tool_choice 透传
 *   （L2544-2546）；
 * - `type` 是 ST 特有生成类型（openai.js createGenerationParameters：
 *   'normal' = 常规生成）；
 * - 模型名必须由客户端带（服务端不查 oai_settings），密钥在服务端 secret
 *   store，插件永远不见 key（CUSTOM 源无 key 校验，其余源缺 key → 400）。
 */
export interface StGenerateBody {
  type: "normal";
  messages: StChatMessageBody[];
  model: string;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  max_tokens?: number;
  stream: true;
  chat_completion_source: string;
  include_reasoning: false;
  tools?: StToolBody[];
  tool_choice?: "auto";
}

export type StChatMessageBody =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content?: string; tool_calls?: StToolCallBody[] }
  | { role: "tool"; content: string; tool_call_id: string };

export interface StToolCallBody {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface StToolBody {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

/**
 * 构造 generate 请求体。纯函数（可单测）：输入 = pi 模型 + 上下文 + 流式选项
 * + ST 当前配置；显式选项优先于 ST 配置（options.temperature/maxTokens 由
 * 上层 agent 决定时覆盖用户设置）。
 */
export function buildStGenerateBody(
  model: StBackendsModel,
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: StChatCompletionConfig,
): StGenerateBody {
  const body: StGenerateBody = {
    type: "normal",
    messages: convertMessages(context),
    model: model.id,
    stream: true,
    chat_completion_source: model.stSource,
    include_reasoning: false,
  };
  const temperature = options?.temperature ?? config.temperature;
  if (temperature !== undefined) body.temperature = temperature;
  if (config.topP !== undefined) body.top_p = config.topP;
  if (config.frequencyPenalty !== undefined) body.frequency_penalty = config.frequencyPenalty;
  if (config.presencePenalty !== undefined) body.presence_penalty = config.presencePenalty;
  body.max_tokens = options?.maxTokens ?? config.maxTokens;
  if (context.tools && context.tools.length > 0) {
    body.tools = convertTools(context.tools);
    body.tool_choice = "auto";
  }
  return body;
}

/** pi Context → OpenAI chat-completions 消息（与 pi 自身 openai-completions 序列化同语义，简化：纯文本） */
export function convertMessages(context: Context): StChatMessageBody[] {
  const messages: StChatMessageBody[] = [];
  if (context.systemPrompt) {
    messages.push({ role: "system", content: context.systemPrompt });
  }
  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: contentToText(message.content) });
    } else if (message.role === "assistant") {
      const text = textBlocksOf(message.content).join("");
      const toolCalls = message.content.filter(
        (block): block is Extract<typeof block, { type: "toolCall" }> => block.type === "toolCall",
      );
      // 部分上游要求 assistant 消息 content/tool_calls 至少一个；空消息跳过
      // （与 pi 同语义：aborted 产生的空 assistant 不重放）
      if (text.length === 0 && toolCalls.length === 0) continue;
      const entry: StChatMessageBody = { role: "assistant" };
      if (text.length > 0) entry.content = text;
      if (toolCalls.length > 0) {
        entry.tool_calls = toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: {
            name: call.name,
            // pi 的 ToolCall.arguments 已是解析后的对象，OpenAI 需要 JSON 字符串
            arguments: JSON.stringify(call.arguments),
          },
        }));
      }
      messages.push(entry);
    } else if (message.role === "toolResult") {
      const text = contentToText(message.content);
      messages.push({
        role: "tool",
        content: text.length > 0 ? text : "(no tool output)",
        tool_call_id: message.toolCallId,
      });
    }
  }
  return messages;
}

/** pi Tool（TypeBox schema）→ OpenAI function tool（parameters 直接透传，TypeBox 产出即 JSON Schema） */
export function convertTools(tools: readonly Tool[]): StToolBody[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function contentToText(content: Message["content"]): string {
  return textBlocksOf(content).join("\n");
}

/** 提取文本内容块（user/assistant/toolResult 共用；分隔符由调用方决定） */
function textBlocksOf(content: Message["content"]): string[] {
  if (typeof content === "string") return [content];
  return content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text);
}
