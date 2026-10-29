import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { QueryChatMessage } from "../../../features/query-chat/query-chat-state.ts";
import { QueryMessage } from "./query-message.tsx";

type Assistant = Extract<QueryChatMessage, { kind: "assistant" }>;

function render(message: Assistant) {
  return renderToStaticMarkup(
    <QueryMessage message={message} onRefresh={() => {}} refreshing={false} />,
  );
}

const processThenAnswer: Assistant["segments"] = [
  { kind: "thinking", text: "先检查记忆" },
  { kind: "text", text: "第一段回答" },
  {
    kind: "tool",
    callId: "tool",
    name: "query_records",
    args: { table: "people" },
    running: false,
    isError: false,
    result: { total: 1 },
  },
  { kind: "text", text: "第二段回答" },
];

describe("query answer projection", () => {
  it("collapses the process and keeps only the final answer when done", () => {
    const html = render({
      kind: "assistant",
      id: "answer",
      status: "done",
      segments: processThenAnswer,
    });
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("过程");
    expect(html).toContain("2 步");
    expect(html).toContain("第二段回答");
    expect(html).not.toContain("第一段回答");
    expect(html).not.toContain("思考过程");
    expect(html).not.toContain("查询记忆记录");
    expect(html.indexOf("过程")).toBeLessThan(html.indexOf("第二段回答"));
  });

  it("expands the process while running and names the current action", () => {
    const thinking = render({
      kind: "assistant",
      id: "thinking",
      status: "streaming",
      segments: [{ kind: "thinking", text: "先检查记忆" }],
    });
    expect(thinking).toContain('aria-expanded="true"');
    expect(thinking).toContain("正在思考…");
    expect(thinking).toContain("先检查记忆");
    expect(thinking).not.toContain("复制回答");

    const tool = render({
      kind: "assistant",
      id: "tool",
      status: "streaming",
      segments: [
        { kind: "thinking", text: "先检查记忆" },
        {
          kind: "tool",
          callId: "tool",
          name: "query_records",
          args: { table: "people" },
          running: true,
          isError: false,
          result: undefined,
        },
      ],
    });
    expect(tool).toContain("正在查询记忆记录…");
    expect(tool).toContain("思考过程");
    expect(tool).toContain("查询记忆记录");
  });

  it("keeps the process open while the final answer streams, then reports step count", () => {
    const html = render({
      kind: "assistant",
      id: "streaming-answer",
      status: "streaming",
      segments: processThenAnswer,
    });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("2 步");
    expect(html.indexOf("第一段回答")).toBeLessThan(html.indexOf("第二段回答"));
  });

  it("surfaces failed steps in the collapsed summary without expanding details", () => {
    const html = render({
      kind: "assistant",
      id: "failed",
      status: "done",
      segments: [
        { kind: "thinking", text: "先检查记忆" },
        {
          kind: "tool",
          callId: "tool",
          name: "query_records",
          args: {},
          running: false,
          isError: true,
          result: { error: "查询失败" },
        },
        { kind: "text", text: "没有找到记录。" },
      ],
    });
    expect(html).toContain("2 步 · 1 步失败");
    expect(html).toContain('data-status="error"');
    expect(html).not.toContain("执行失败");
    expect(html).toContain("没有找到记录。");
  });

  it("omits the process group when the message is only an answer", () => {
    const html = render({
      kind: "assistant",
      id: "plain",
      status: "done",
      segments: [{ kind: "text", text: "直接回答" }],
    });
    expect(html).not.toContain("过程");
    expect(html).toContain("直接回答");
    expect(html).toContain("复制回答");
  });

  it("keeps the process group when a turn ends without an answer", () => {
    const html = render({
      kind: "assistant",
      id: "tool-only",
      status: "done",
      segments: [
        { kind: "thinking", text: "先检查记忆" },
        {
          kind: "tool",
          callId: "tool",
          name: "proposal_preview",
          args: {},
          running: false,
          isError: false,
          result: { valid: true, operations: [], errors: [] },
        },
      ],
    });
    expect(html).toContain("过程");
    expect(html).toContain("2 步");
    expect(html).not.toContain("复制回答");
  });

  it("does not execute raw HTML, load remote images or allow javascript links", () => {
    const html = render({
      kind: "assistant",
      id: "markdown",
      status: "done",
      segments: [
        {
          kind: "text",
          text: '<script>alert("x")</script>\n\n[bad](javascript:alert(1))\n\n![tracking](https://image.invalid/pixel)\n\n[docs](https://example.com)',
        },
      ],
    });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("shows SQL truncation and preserves failed tool status without a success summary", () => {
    const html = render({
      kind: "assistant",
      id: "inspection",
      status: "streaming",
      segments: [
        {
          kind: "tool",
          callId: "sql",
          name: "query_sql",
          args: { sql: "SELECT name FROM people" },
          running: false,
          isError: false,
          result: { rows: [{ name: "爱丽丝" }], truncated: true, limit: 1 },
        },
        {
          kind: "tool",
          callId: "error",
          name: "query_records",
          args: {},
          running: false,
          isError: true,
          result: { error: "查询失败" },
        },
      ],
    });
    expect(html).toContain("返回 1 行（已截断）");
    expect(html).toContain('data-status="error"');
    expect(html).toContain("执行失败");
    expect(html).not.toContain("命中");
  });
});
