/**
 * SSE 增量解析器（纯逻辑，可单测）。
 *
 * 与 ST 客户端同法（public/scripts/sse-stream.js 已核实）：事件按空行分隔
 * （\n\n / \r\n\r\n / \r\r），`data:` 行累积（多条 data 行以 \n 连接），
 * 其余字段（event/id/注释行）忽略——本适配器只消费 data 负载。
 *
 * 输出：完整事件的 data 字符串；`[DONE]` 哨兵与 JSON 解析由调用方处理
 * （解析器只负责把字节流切成事件，不掺业务语义）。
 */
export class SseEventParser {
  #buffer = "";

  /** 喂入一段文本，返回其中完整事件的 data 字符串列表（空 data 事件忽略） */
  push(chunk: string): string[] {
    this.#buffer += chunk;
    const events = this.#buffer.split(/\r\n\r\n|\r\r|\n\n/g);
    // 最后一段没有空行结尾 → 留在缓冲等下一块（可能被后续块补全）
    this.#buffer = events.pop() ?? "";
    return events
      .filter((event) => event.length > 0)
      .map(extractData)
      .filter((data) => data.length > 0);
  }

  /** 流结束：把残留缓冲作为最后一个事件吐出（不做完整性要求——由调用方决定） */
  finish(): string[] {
    const rest = this.#buffer;
    this.#buffer = "";
    return rest.length > 0 ? [extractData(rest)] : [];
  }
}

/** 从事件块提取 data 字段：多行 data 按 \n 连接；空 data 返回空串（调用方跳过） */
function extractData(event: string): string {
  const lines = event.split(/\n|\r|\r\n/g);
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith(":")) continue; // 注释行（keep-alive 等）
    const match = /^data:(?: ?(.*))?$/.exec(line);
    if (match) data.push(match[1] ?? "");
  }
  return data.join("\n");
}
