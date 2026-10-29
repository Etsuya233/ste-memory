import { useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy } from "lucide-react";
import {
  assistantPlainText,
  type QueryChatMessage,
  type QueryChatMode,
  type QueryChatSegment,
  type QueryChatCommitResult,
} from "../../../features/query-chat/query-chat-state.ts";
import { Button } from "../../../ui/primitives/button.tsx";
import { Badge } from "../../../ui/primitives/badge.tsx";
import {
  Card,
  CardHeader,
  CardTitle,
  CardAction,
  CardContent,
} from "../../../ui/primitives/card.tsx";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "../../../ui/primitives/accordion.tsx";
import { StatusNotice } from "../../components/page-state.tsx";
import { copyText } from "../../components/copy-text.ts";

export function QueryMessage({
  message,
  mode,
  onRefresh,
  refreshing,
}: {
  message: QueryChatMessage;
  mode: QueryChatMode;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  if (message.kind === "user")
    return (
      <Card size="sm" className="ste:min-w-0" data-query-message="user">
        <CardHeader>
          <CardTitle>你</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="ste:whitespace-pre-wrap ste:break-words">{message.text}</p>
        </CardContent>
      </Card>
    );
  const answer = assistantPlainText(message);
  async function copy() {
    try {
      await copyText(answer);
      setCopied(true);
      setCopyError(null);
    } catch (cause) {
      setCopyError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <Card
      size="sm"
      className="ste:min-w-0"
      data-query-message="assistant"
      data-query-status={message.status}
    >
      <CardHeader>
        <CardTitle>{mode === "query" ? "查询 Agent" : "填写 Agent"}</CardTitle>
        <CardAction>
          <Badge variant={message.status === "error" ? "destructive" : "secondary"}>
            {message.status === "streaming"
              ? "回答中"
              : message.status === "error"
                ? "出错"
                : "完成"}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="ste:flex ste:min-w-0 ste:flex-col ste:gap-4">
        {message.segments.map((segment, index) => (
          <TimelineSegment
            key={index}
            segment={segment}
            active={message.status === "streaming" && index === message.segments.length - 1}
          />
        ))}
        {message.status === "streaming" && !message.segments.length ? (
          <p role="status" className="ste:text-sm ste:text-muted-foreground">
            正在准备回答…
          </p>
        ) : null}
        {message.error ? <StatusNotice variant="destructive">{message.error}</StatusNotice> : null}
        {message.commit ? (
          <CommitResult commit={message.commit} onRefresh={onRefresh} refreshing={refreshing} />
        ) : null}
        {copyError ? (
          <StatusNotice variant="destructive">复制失败：{copyError}</StatusNotice>
        ) : null}
        {answer ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ste:self-start"
            onClick={() => void copy()}
            data-action="copy-answer"
          >
            <Copy data-icon="inline-start" />
            {copied ? "已复制回答" : "复制回答"}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function TimelineSegment({ segment, active }: { segment: QueryChatSegment; active: boolean }) {
  const [open, setOpen] = useState(false);
  if (segment.kind === "text")
    return (
      <div
        data-query-segment="text"
        className="ste:flex ste:min-w-0 ste:flex-col ste:gap-3 ste:break-words"
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {segment.text}
        </ReactMarkdown>
      </div>
    );
  const expanding = segment.kind === "thinking" ? active : segment.running;
  return (
    <Accordion
      value={expanding || open ? ["segment"] : []}
      onValueChange={(values) => setOpen(values.length > 0)}
      data-query-segment={segment.kind}
    >
      <AccordionItem value="segment">
        <AccordionTrigger>
          {segment.kind === "thinking"
            ? "思考过程"
            : `${segment.name} · ${segment.running ? "执行中" : segment.isError ? "执行失败" : "完成"}`}
        </AccordionTrigger>
        <AccordionContent>
          {segment.kind === "thinking" ? (
            <p className="ste:whitespace-pre-wrap ste:break-words">{segment.text}</p>
          ) : (
            <div className="ste:flex ste:flex-col ste:gap-3 ste:min-w-0">
              <div>
                <h3 className="ste:mb-2 ste:text-xs ste:font-medium">参数</h3>
                <pre className="ste:max-h-60 ste:overflow-y-auto ste:whitespace-pre-wrap ste:break-words ste:text-xs">
                  {JSON.stringify(segment.args, null, 2)}
                </pre>
              </div>
              {!segment.running ? (
                <div>
                  <h3 className="ste:mb-2 ste:text-xs ste:font-medium">
                    结果{segment.isError ? "（错误）" : ""}
                  </h3>
                  <pre className="ste:max-h-80 ste:overflow-y-auto ste:whitespace-pre-wrap ste:break-words ste:text-xs">
                    {segment.result === undefined
                      ? "（无返回内容）"
                      : JSON.stringify(segment.result, null, 2)}
                  </pre>
                </div>
              ) : null}
            </div>
          )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

function CommitResult({
  commit,
  onRefresh,
  refreshing,
}: {
  commit: QueryChatCommitResult;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  if (commit.status === "committed")
    return (
      <StatusNotice>
        已提交：创建 {commit.created} · 更新 {commit.updated} · 删除 {commit.deleted}。
        <Button type="button" size="sm" variant="outline" onClick={onRefresh} disabled={refreshing}>
          刷新记录
        </Button>
      </StatusNotice>
    );
  return (
    <StatusNotice variant={commit.status === "failed" ? "destructive" : "default"}>
      {commit.status === "failed" ? `提交失败：${commit.error}` : commit.notice}
    </StatusNotice>
  );
}

const markdownComponents: Components = {
  p: ({ children }) => <p className="ste:whitespace-pre-wrap ste:break-words">{children}</p>,
  h1: ({ children }) => <h2 className="ste:text-lg ste:font-semibold">{children}</h2>,
  h2: ({ children }) => <h3 className="ste:text-base ste:font-semibold">{children}</h3>,
  h3: ({ children }) => <h4 className="ste:text-sm ste:font-semibold">{children}</h4>,
  ul: ({ children }) => <ul className="ste:list-disc ste:pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="ste:list-decimal ste:pl-5">{children}</ol>,
  li: ({ children }) => <li className="ste:my-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="ste:border-l-2 ste:pl-3 ste:text-muted-foreground">
      {children}
    </blockquote>
  ),
  pre: ({ children }) => (
    <pre className="ste:max-w-full ste:overflow-x-auto ste:rounded-xl ste:bg-muted ste:p-3 ste:text-xs">
      {children}
    </pre>
  ),
  code: ({ children, className }) => <code className={className}>{children}</code>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="ste:break-all ste:underline ste:underline-offset-4"
    >
      {children}
    </a>
  ),
  img: ({ alt }) => <span>{alt ? `[图片：${alt}]` : "[图片]"}</span>,
  table: ({ children }) => (
    <div className="ste:max-w-full ste:overflow-x-auto">
      <table className="ste:w-full ste:border-collapse ste:text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="ste:border ste:p-2 ste:text-left ste:font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="ste:border ste:p-2">{children}</td>,
};
