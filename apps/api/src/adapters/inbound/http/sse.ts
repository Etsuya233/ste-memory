/**
 * 通用 SSE 流（自 11.5 chat 路由的 streamChat 抽出，16 起聊天与填表事件流共用）：
 *
 * - hijack 接管响应，写 SSE 头（含按 Origin 手动补 CORS 头——hijack 后 @fastify/cors
 *   钩子不再生效，其设置的响应头会被 raw.writeHead 的 headers 参数整体覆盖）；
 * - 监听连接 close/error → AbortController.abort()，run 内据此收尾（聊天：中止 run；
 *   填表事件流：只退订不中止任务）；
 * - run 抛错时记日志并结束流（错误事件由调用方在 run 内部自行送达，形状各异）。
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { ALLOWED_WEB_ORIGIN } from "./server.ts";

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  // 响应结束（终态/断开）后连接不再复用：Node 在 end() 后自动关闭，
  // 否则 keep-alive 连接悬挂在空闲池，客户端永远等不到 close。
  connection: "close",
} as const;

/** 无 Origin(非浏览器客户端)时保持原样。 */
function buildSseHeaders(request: FastifyRequest): Record<string, string> {
  const headers: Record<string, string> = { ...SSE_HEADERS };
  const origin = request.headers.origin;
  if (origin !== undefined && ALLOWED_WEB_ORIGIN.test(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["vary"] = "Origin";
  }
  return headers;
}

/** SSE 写句柄：data 为单行 JSON；id/event 行可选（重连续传与事件分类用）。 */
export type SseSend = (
  data: unknown,
  options?: { readonly id?: string; readonly event?: string },
) => void;

/**
 * 把响应接管为 SSE 流：转发 run 产生的事件；监听连接关闭中止 run；
 * 未预期异常记录日志后结束（连接可能已断开，写失败静默忽略）。
 */
export async function streamSse(
  request: FastifyRequest,
  reply: FastifyReply,
  run: (send: SseSend, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  const controller = new AbortController();
  let ended = false;

  const send: SseSend = (data, options) => {
    if (ended) return;
    try {
      if (options?.id !== undefined) raw.write(`id: ${options.id}\n`);
      if (options?.event !== undefined) raw.write(`event: ${options.event}\n`);
      raw.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (error) {
      // 写失败（socket 已死/对端断开）：记日志后由 close/error 事件收尾，不抛给任务循环。
      request.log.warn({ err: error }, "sse write failed");
    }
  };
  const onDisconnect = () => controller.abort();
  raw.on("close", onDisconnect);
  raw.on("error", onDisconnect);
  raw.writeHead(200, buildSseHeaders(request));

  try {
    await run(send, controller.signal);
  } catch (error) {
    request.log.error({ err: error }, "sse stream failed");
  } finally {
    ended = true;
    raw.removeListener("close", onDisconnect);
    raw.removeListener("error", onDisconnect);
    raw.end();
  }
}
