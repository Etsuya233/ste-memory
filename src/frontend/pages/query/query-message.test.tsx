import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { QueryChatMessage } from "../../../features/query-chat/query-chat-state.ts";
import { QueryMessage } from "./query-message.tsx";

function render(segments: Extract<QueryChatMessage, { kind: "assistant" }>["segments"]) {
  return renderToStaticMarkup(
    <QueryMessage
      message={{ kind: "assistant", id: "answer", status: "done", segments }}
      mode="query"
      onRefresh={() => {}}
      refreshing={false}
    />,
  );
}
describe("query answer projection", () => {
  it("keeps thinking, text and tool entries in source timeline order", () => {
    const html = render([
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
    ]);
    expect(html.indexOf("思考过程")).toBeLessThan(html.indexOf("第一段回答"));
    expect(html.indexOf("第一段回答")).toBeLessThan(html.indexOf("query_records"));
    expect(html.indexOf("query_records")).toBeLessThan(html.indexOf("第二段回答"));
  });
  it("does not execute raw HTML, load remote images or allow javascript links", () => {
    const html = render([
      {
        kind: "text",
        text: '<script>alert("x")</script>\n\n[bad](javascript:alert(1))\n\n![tracking](https://image.invalid/pixel)\n\n[docs](https://example.com)',
      },
    ]);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
