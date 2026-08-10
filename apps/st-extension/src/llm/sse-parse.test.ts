import { describe, expect, it } from "vitest";
import { SseEventParser } from "./sse-parse.ts";

describe("SseEventParser（SSE 增量解析）", () => {
  it("单个完整事件", () => {
    const parser = new SseEventParser();
    expect(parser.push('data: {"a":1}\n\n')).toEqual(['{"a":1}']);
  });

  it("多个事件一次喂入", () => {
    const parser = new SseEventParser();
    expect(parser.push('data: A\n\ndata: B\n\n')).toEqual(["A", "B"]);
  });

  it("事件跨 chunk 边界（缓冲累积）", () => {
    const parser = new SseEventParser();
    expect(parser.push('data: {"a":')).toEqual([]);
    expect(parser.push('1}\n\n')).toEqual(['{"a":1}']);
  });

  it("一条 data 被拆成两行时按 \\n 连接（SSE 规范）", () => {
    const parser = new SseEventParser();
    expect(parser.push("data: line1\ndata: line2\n\n")).toEqual(["line1\nline2"]);
  });

  it("CRLF 分隔（\\r\\n\\r\\n）与 \\r\\r 分隔", () => {
    const parser = new SseEventParser();
    expect(parser.push("data: A\r\n\r\n")).toEqual(["A"]);
    const crParser = new SseEventParser();
    expect(crParser.push("data: B\r\r")).toEqual(["B"]);
  });

  it("[DONE] 哨兵原样输出", () => {
    const parser = new SseEventParser();
    expect(parser.push("data: [DONE]\n\n")).toEqual(["[DONE]"]);
  });

  it("注释行（keep-alive）与空 data 忽略", () => {
    const parser = new SseEventParser();
    expect(parser.push(": keep-alive\n\n")).toEqual([]);
    const empty = new SseEventParser();
    expect(empty.push("data:\n\n")).toEqual([]);
  });

  it("非 data 字段（event/id）忽略，只取 data", () => {
    const parser = new SseEventParser();
    expect(parser.push('event: message\ndata: {"x":1}\nid: 7\n\n')).toEqual(['{"x":1}']);
  });

  it("finish：残留无空行结尾的缓冲作为最后事件吐出", () => {
    const parser = new SseEventParser();
    expect(parser.push("data: tail")).toEqual([]);
    expect(parser.finish()).toEqual(["tail"]);
  });

  it("连续多个 chunk 累积事件顺序正确", () => {
    const parser = new SseEventParser();
    const first = parser.push('data: {"i":1}\n\n');
    const second = parser.push('data: {"i":2');
    const third = parser.push('}\n\ndata: {"i":3}\n\n');
    expect([...first, ...second, ...third]).toEqual(['{"i":1}', '{"i":2}', '{"i":3}']);
  });
});
