/**
 * 聊天端点（ticket 11.5）：
 *
 * - POST /memory-spaces/:spaceId/chat：SSE 流式聊天（思考/回答增量、工具调用参数/结果、终态）；
 * - GET /llm-config：非敏感的环境配置回退信息（不含 API Key 值）。
 *
 * 预检错误（配置缺失 / 空间不存在）在 SSE 头之前以 JSON 4xx 返回；
 * 流中错误（网络、LLM 鉴权失败、超时）以 SSE error 事件送达；
 * 客户端断开时经 AbortController 中止 QueryAgent（stopReason "aborted" 收尾，不抛异常）。
 */
import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ChatSpaceNotFoundError } from "../../../../application/chat/chat-manager.ts";
import type { ChatEvent } from "../../../../application/chat/chat-events.ts";
import { LlmConfigError, type LlmWebConfig } from "../../../../application/chat/llm-config.ts";
import type { ChatManager, ChatMessageInput } from "../../../../application/ports/chat.ts";
import { ALLOWED_WEB_ORIGIN } from "../server.ts";

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
} as const;

/**
 * hijack 接管响应后 @fastify/cors 的钩子不再生效(其设置的响应头会被
 * raw.writeHead 的 headers 参数整体覆盖),需按请求 Origin 手动补 CORS 头;
 * 无 Origin(非浏览器客户端)时保持原样。
 */
function buildSseHeaders(request: FastifyRequest): Record<string, string> {
  const headers: Record<string, string> = { ...SSE_HEADERS };
  const origin = request.headers.origin;
  if (origin !== undefined && ALLOWED_WEB_ORIGIN.test(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["vary"] = "Origin";
  }
  return headers;
}

/** 单次请求回传的历史消息上限（对话历史随请求回传，做个合理的防滥用护栏）。 */
const MAX_CHAT_MESSAGES = 100;

interface ChatParams {
  readonly spaceId: string;
}

interface ChatBody {
  readonly messages?: unknown;
  readonly config?: unknown;
}

export function registerChatRoutes(server: FastifyInstance, chat: ChatManager): void {
  server.get("/llm-config", async () => chat.getLlmConfigInfo());

  server.post<{ Params: ChatParams; Body: ChatBody }>(
    "/memory-spaces/:spaceId/chat",
    async (request, reply) => {
      let messages: readonly ChatMessageInput[];
      let config: LlmWebConfig;
      try {
        ({ messages, config } = parseChatBody(request.body));
      } catch (error) {
        return reply.code(400).send({ message: (error as Error).message });
      }

      let prepared;
      try {
        prepared = await chat.prepareChat({
          spaceId: request.params.spaceId as MemorySpaceId,
          messages,
          config,
        });
      } catch (error) {
        if (error instanceof LlmConfigError) {
          return reply.code(400).send({ message: error.message });
        }
        if (error instanceof ChatSpaceNotFoundError) {
          return reply.code(404).send({ message: error.message });
        }
        throw error;
      }

      await streamChat(request, reply, (signal, onEvent) =>
        chat.runChat(prepared, { signal, onEvent }),
      );
    },
  );
}

function parseChatBody(body: unknown): {
  readonly messages: ChatMessageInput[];
  readonly config: LlmWebConfig;
} {
  const candidate = (body ?? {}) as Record<string, unknown> | null;
  const rawMessages = candidate?.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new Error("messages 必须是至少一条消息的数组");
  }
  if (rawMessages.length > MAX_CHAT_MESSAGES) {
    throw new Error(`messages 不能超过 ${MAX_CHAT_MESSAGES} 条`);
  }
  const messages = rawMessages.map((entry, index) => parseChatMessage(entry, index));
  if (messages[0]!.role !== "user" || messages[messages.length - 1]!.role !== "user") {
    throw new Error("对话必须以用户消息开头和结尾");
  }
  return { messages, config: parseLlmWebConfig(candidate?.config) };
}

function parseChatMessage(entry: unknown, index: number): ChatMessageInput {
  const role = (entry as Record<string, unknown> | null)?.role;
  if (typeof role !== "string") {
    throw new Error(`第 ${index + 1} 条消息的 role 必须是 user 或 assistant`);
  }
  if (role !== "user" && role !== "assistant") {
    throw new Error(`第 ${index + 1} 条消息的 role 必须是 user 或 assistant`);
  }
  const content = (entry as Record<string, unknown> | null)?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error(`第 ${index + 1} 条消息的 content 必须是非空字符串`);
  }
  return { role, content };
}

function parseLlmWebConfig(value: unknown): LlmWebConfig {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("config 必须是对象");
  }
  const config: { baseUrl?: string; model?: string; apiKey?: string } = {};
  for (const field of ["baseUrl", "model", "apiKey"] as const) {
    const entry = (value as Record<string, unknown>)[field];
    if (entry === undefined) continue;
    if (typeof entry !== "string") throw new Error(`config.${field} 必须是字符串`);
    config[field] = entry.trim();
  }
  return config;
}

/**
 * 接管响应为 SSE 流：转发 run 产生的聊天事件；监听连接关闭中止 run；
 * 未预期异常尽量以 error 事件送达（连接可能已断开，写失败静默忽略）。
 */
async function streamChat(
  request: FastifyRequest,
  reply: FastifyReply,
  run: (signal: AbortSignal, onEvent: (event: ChatEvent) => void) => Promise<void>,
): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  const controller = new AbortController();
  let ended = false;

  const send = (event: ChatEvent) => {
    if (ended) return;
    raw.write(`event: chat\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const onDisconnect = () => controller.abort();
  raw.on("close", onDisconnect);
  raw.on("error", onDisconnect);
  raw.writeHead(200, buildSseHeaders(request));

  try {
    await run(controller.signal, send);
  } catch (error) {
    request.log.error({ err: error }, "chat run failed");
    send({ type: "error", message: `服务内部错误：${errorMessage(error)}` });
  } finally {
    ended = true;
    raw.removeListener("close", onDisconnect);
    raw.removeListener("error", onDisconnect);
    raw.end();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
