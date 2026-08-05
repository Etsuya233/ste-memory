import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Agent 回复的 Markdown 渲染容器。
 * - react-markdown 默认不渲染原始 HTML，天然防 XSS；
 * - remark-gfm 支持表格、任务列表、删除线等 LLM 常见输出；
 * - 样式统一由 .chat-markdown 容器下的后代选择器提供（见 query-chat.css）。
 */

const markdownComponents: Components = {
  a: ({ node: _node, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer" />
  ),
  table: ({ node: _node, ...props }) => (
    <div className="chat-markdown-table-wrap">
      <table {...props} />
    </div>
  ),
};

interface MarkdownContentProps {
  readonly text: string;
}

export function MarkdownContent({ text }: MarkdownContentProps) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
