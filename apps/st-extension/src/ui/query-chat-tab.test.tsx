/**
 * 问答面板片段时间线渲染冒烟测试（react-dom/server renderToString，无 jsdom，
 * 对齐 agent-connection-manager.test.tsx 既有先例）：验证渲染契约——
 * 片段 DOM 顺序与节点/class、details 折叠开合前提、复制按钮取纯文本、
 * Markdown 冒烟渲染（含表格包装、外链新标签、原始 HTML 转义）。
 */
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  QueryChatMessage,
  QueryChatSegment,
} from "../query-chat/query-chat-state.ts";
import { AssistantMessageView } from "./query-chat-tab.tsx";

function assistantMessage(
  segments: readonly QueryChatSegment[],
  status: "streaming" | "done" | "error" = "done",
  error?: string,
): Extract<QueryChatMessage, { kind: "assistant" }> {
  return { kind: "assistant", id: "a1", status, segments, ...(error === undefined ? {} : { error }) };
}

function render(message: Extract<QueryChatMessage, { kind: "assistant" }>): string {
  return renderToString(<AssistantMessageView message={message} mode="query" />);
}

describe("AssistantMessageView（片段时间线渲染冒烟）", () => {
  it("思考/文本/工具卡按片段顺序逐个出现（思考 → 文本 → 工具 → 再思考）", () => {
    const message = assistantMessage([
      { kind: "thinking", text: "先回忆" },
      { kind: "text", text: "让我查一下" },
      {
        kind: "tool",
        callId: "call-1",
        name: "query_records",
        args: { table: "characters" },
        running: false,
        result: { total: 2 },
        isError: false,
      },
      { kind: "thinking", text: "结果有 2 条" },
    ]);
    const html = render(message);
    const thinking = 'class="stm-chat-thinking"';
    const text = 'class="stm-chat-markdown"';
    const tool = 'class="stm-chat-tool"';
    expect(html.indexOf(thinking)).toBeGreaterThan(-1);
    expect(html.indexOf(text)).toBeGreaterThan(html.indexOf(thinking));
    expect(html.indexOf(tool)).toBeGreaterThan(html.indexOf(text));
    expect(html.lastIndexOf(thinking)).toBeGreaterThan(html.indexOf(tool));
    // 两个思考片段各自独立（ADR 0013：不合并）
    expect(html.match(/class="stm-chat-thinking"/g)).toHaveLength(2);
    expect(html).toContain("先回忆");
    expect(html).toContain("让我查一下");
    expect(html).toContain("结果有 2 条");
  });

  it("思考片段保持纯文本：Markdown 标记不渲染", () => {
    const html = render(assistantMessage([{ kind: "thinking", text: "**加粗** 与 `代码`" }]));
    expect(html).toContain("**加粗** 与 `代码`");
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("<code>");
  });

  it("折叠开合前提：流式中仅当前进料思考片段受控展开，已完成思考片段默认折叠", () => {
    const streaming = assistantMessage(
      [
        { kind: "thinking", text: "已完成的第一段" },
        { kind: "text", text: "中间文本" },
        { kind: "thinking", text: "正在进料的第二段" },
      ],
      "streaming",
    );
    const html = render(streaming);
    // 仅 feed 片段带受控 open；完成的思考片段为不受控 details（无 open 属性）
    expect(html.match(/open=""/g)).toHaveLength(1);
    expect(html.indexOf("正在进料的第二段")).toBeGreaterThan(
      html.indexOf('class="stm-chat-thinking" open="">'),
    );
    expect(html.indexOf('class="stm-chat-thinking">')).toBeGreaterThan(-1);
    expect(html.indexOf('class="stm-chat-thinking">')).toBeLessThan(
      html.indexOf('class="stm-chat-thinking" open="">'),
    );
  });

  it("完成的回复：思考片段全部折叠（不受控 details，用户可手动展开）", () => {
    const html = render(
      assistantMessage([
        { kind: "thinking", text: "思考一段" },
        { kind: "text", text: "回答" },
      ]),
    );
    expect(html).not.toContain('open=""');
    expect(html).toContain('class="stm-chat-thinking">');
  });

  it("工具卡：执行中展开、出结果后折叠；失败卡错误高亮", () => {
    const running = render(
      assistantMessage([
        {
          kind: "tool",
          callId: "call-1",
          name: "query_records",
          args: { table: "characters" },
          running: true,
          result: undefined,
          isError: false,
        },
      ]),
    );
    expect(running).toContain('data-tool-call-id="call-1"');
    expect(running).toContain("执行中…");
    expect(running.match(/open=""/g)).toHaveLength(1);

    const done = render(
      assistantMessage([
        {
          kind: "tool",
          callId: "call-1",
          name: "query_records",
          args: { table: "characters" },
          running: false,
          result: { total: 2 },
          isError: false,
        },
      ]),
    );
    expect(done).not.toContain('open=""');
    expect(done).toContain("完成");
    expect(done).toContain("结果（2 条记录）");

    // 工具合法返回 undefined：running 显式标记驱动折叠，不卡在「执行中…」
    const voidResult = render(
      assistantMessage([
        {
          kind: "tool",
          callId: "call-1",
          name: "update_record",
          args: { table: "characters" },
          running: false,
          result: undefined,
          isError: false,
        },
      ]),
    );
    expect(voidResult).not.toContain('open=""');
    expect(voidResult).not.toContain("执行中…");
    expect(voidResult).toContain("完成");

    const failed = render(
      assistantMessage([
        {
          kind: "tool",
          callId: "call-1",
          name: "query_records",
          args: { table: "characters" },
          running: false,
          result: "表不存在",
          isError: true,
        },
      ]),
    );
    expect(failed).toContain("stm-chat-tool--error");
    expect(failed).toContain("执行失败");
    expect(failed).toContain("stm-chat-tool-section--error");
  });

  it("工具参数与结果保持 <pre> JSON 代码块", () => {
    const html = render(
      assistantMessage([
        {
          kind: "tool",
          callId: "call-1",
          name: "query_records",
          args: { table: "characters" },
          running: false,
          result: { total: 2 },
          isError: false,
        },
      ]),
    );
    expect(html).toContain("<pre>");
    // React 转义 JSON 里的引号（renderToString 产物），断言转义后的形式
    expect(html).toContain("&quot;table&quot;");
    expect(html).toContain("&quot;total&quot;");
  });

  it("复制按钮按聚合纯文本取用：无文本片段禁用，有文本片段可用", () => {
    const noText = render(assistantMessage([{ kind: "thinking", text: "只有思考" }]));
    expect(noText).toContain('data-action="copy-answer"');
    expect(noText).toContain('data-action="copy-answer" disabled=""');

    const withText = render(
      assistantMessage([{ kind: "thinking", text: "思考" }, { kind: "text", text: "回答" }]),
    );
    expect(withText).not.toContain('data-action="copy-answer" disabled=""');
  });

  it("Markdown 冒烟渲染：标题/强调/列表/代码块/表格/任务列表产出容器与结构", () => {
    const html = render(
      assistantMessage([
        {
          kind: "text",
          text: [
            "# 伤情总结",
            "",
            "**云烬**轻伤，[详情](https://example.com)。",
            "",
            "| 名字 | 伤情 |",
            "| --- | --- |",
            "| 云烬 | 轻伤 |",
            "",
            "- [x] 已告知",
            "",
            "```ts",
            "const ok = true;",
            "```",
          ].join("\n"),
        },
      ]),
    );
    expect(html).toContain('class="stm-chat-markdown"');
    expect(html).toContain("<h1>");
    expect(html).toContain("<strong>");
    expect(html).toMatch(/<ul[\s>]/);
    expect(html).toContain("stm-chat-markdown-table-wrap");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<pre>");
    expect(html).toContain("<code");
    // 外链新标签页打开（不丢失问答上下文）
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });

  it("回答文本中的原始 HTML 不执行（react-markdown 默认转义）", () => {
    const html = render(
      assistantMessage([{ kind: "text", text: "见 <script>window.alert(1)</script> 与 <img src=x onerror=1>" }]),
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("错误/中止消息：已生成片段保持原状并追加错误提示", () => {
    const html = render(
      assistantMessage(
        [
          { kind: "thinking", text: "思考了一段" },
          { kind: "text", text: "部分回答" },
        ],
        "error",
        "模型调用失败",
      ),
    );
    expect(html).toContain('stm-chat-assistant--error');
    expect(html).toContain("思考了一段");
    expect(html).toContain("部分回答");
    expect(html).toContain("模型调用失败");
    expect(html).toContain("stm-chat-error");
  });
});

describe("AssistantMessageView（多段流式进料）", () => {
  it("连续同类型增量合并进同一片段：不产生碎文本块（合并规则由状态层保证，此处验证渲染投影）", () => {
    const message = assistantMessage(
      [{ kind: "thinking", text: "先想" }],
      "streaming",
    );
    const html = render(message);
    expect(html).toContain("先想");
    expect(html.match(/class="stm-chat-thinking"/g)).toHaveLength(1);
    expect(html.match(/open=""/g)).toHaveLength(1);
  });
});