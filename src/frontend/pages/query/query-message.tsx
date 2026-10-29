import { memo, useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Check,
  Copy,
  LoaderCircle,
  MessageCircleMore,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import type {
  QueryRecordsToolResult,
  QuerySqlToolResult,
  ProposalPreviewToolResult,
} from "../../../features/agent/index.ts";
import type {
  QueryChatMessage,
  QueryChatSegment,
  QueryChatCommitResult,
} from "../../../features/query-chat/query-chat-state.ts";
import { Button } from "../../../ui/primitives/button.tsx";
import { Badge } from "../../../ui/primitives/badge.tsx";
import {
  Message,
  MessageContent,
  MessageHeader,
  MessageFooter,
} from "../../../ui/primitives/message.tsx";
import { Bubble, BubbleContent } from "../../../ui/primitives/bubble.tsx";
import {
  Trace,
  TraceLine,
  TraceIcon,
  TraceTitle,
  TraceDescription,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
} from "../../../ui/primitives/trace.tsx";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "../../../ui/primitives/code-block.tsx";
import { cn } from "../../../ui/primitives/utils.ts";
import { StatusNotice } from "../../components/page-state.tsx";
import { copyText } from "../../components/copy-text.ts";

type ToolSegment = Extract<QueryChatSegment, { kind: "tool" }>;

export function QueryMessage({
  message,
  onRefresh,
  refreshing,
}: {
  message: QueryChatMessage;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);
  if (message.kind === "user")
    return (
      <Message align="end" data-query-message="user">
        <MessageContent>
          <Bubble variant="secondary">
            <BubbleContent className="ste:whitespace-pre-wrap">{message.text}</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    );
  const { process, answer } = splitTimeline(message.segments);
  const streaming = message.status === "streaming";
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
    <Message data-query-message="assistant" data-query-status={message.status}>
      <MessageContent>
        {message.status === "done" ? null : (
          <MessageHeader className="ste:px-0">
            <Badge variant={message.status === "error" ? "destructive" : "secondary"}>
              {message.status === "streaming"
                ? "回答中"
                : message.status === "error"
                  ? "出错"
                  : "已中断"}
            </Badge>
          </MessageHeader>
        )}
        {process.length ? (
          <ProcessGroup
            process={process}
            streaming={streaming}
            answering={streaming && answer !== ""}
            onCopyError={setCopyError}
          />
        ) : null}
        {answer ? (
          <div
            data-query-answer=""
            className="ste:flex ste:min-w-0 ste:flex-col ste:gap-3 ste:break-words"
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {answer}
            </ReactMarkdown>
          </div>
        ) : null}
        {streaming && !message.segments.length ? (
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
          <MessageFooter className="ste:px-0">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ste:self-start"
              onClick={() => void copy()}
              data-action="copy-answer"
            >
              {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
              {copied ? "已复制" : "复制回答"}
            </Button>
            <span aria-live="polite" className="ste:sr-only">
              {copied ? "已复制回答" : ""}
            </span>
          </MessageFooter>
        ) : null}
      </MessageContent>
    </Message>
  );
}

/**
 * 过程组：思考、工具调用与中间旁白收进一个折叠入口，正文只保留最终回答。
 * 运行中默认展开，终态默认收起；用户手动切换后以其选择为准。
 */
function ProcessGroup({
  process,
  streaming,
  answering,
  onCopyError,
}: {
  process: readonly QueryChatSegment[];
  streaming: boolean;
  answering: boolean;
  onCopyError: (message: string) => void;
}) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? streaming;
  const { steps, failed } = countSteps(process);
  const description =
    streaming && !answering
      ? runningLabel(process)
      : failed
        ? `${steps} 步 · ${failed} 步失败`
        : steps
          ? `${steps} 步`
          : undefined;
  return (
    <Trace data-query-process="">
      <TraceCollapsible open={open} onOpenChange={setUserOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine status={streaming ? "running" : failed ? "error" : undefined}>
            <TraceIcon>
              {streaming ? (
                <LoaderCircle className="ste:motion-safe:animate-spin" />
              ) : failed ? (
                <TriangleAlert />
              ) : (
                <Check />
              )}
            </TraceIcon>
            <TraceTitle>过程</TraceTitle>
            {description ? (
              <TraceDescription aria-live={streaming ? "polite" : undefined}>
                {description}
              </TraceDescription>
            ) : null}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            {process.map((segment, index) => (
              <TimelineSegment
                key={index}
                segment={segment}
                active={streaming && index === process.length - 1}
                onCopyError={onCopyError}
              />
            ))}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

/**
 * 时间线拆分：末尾文本片段是最终回答，此前的一切（思考、工具、旁白文字）归入过程组。
 * 相邻同类片段已在事件应用时合并，因此末尾文本天然是一整段。
 */
function splitTimeline(segments: readonly QueryChatSegment[]): {
  process: readonly QueryChatSegment[];
  answer: string;
} {
  const last = segments[segments.length - 1];
  if (last?.kind === "text") return { process: segments.slice(0, -1), answer: last.text };
  return { process: segments, answer: "" };
}

/** 步骤数只统计思考与工具，旁白文字不计入。 */
function countSteps(process: readonly QueryChatSegment[]): { steps: number; failed: number } {
  let steps = 0;
  let failed = 0;
  for (const segment of process) {
    if (segment.kind === "text") continue;
    steps += 1;
    if (segment.kind === "tool" && segment.isError) failed += 1;
  }
  return { steps, failed };
}

/** 运行中摘要：取过程组最后一个动作，避免展示原始工具名。 */
function runningLabel(process: readonly QueryChatSegment[]): string {
  const last = [...process].reverse().find((segment) => segment.kind !== "text");
  if (!last) return "正在准备回答…";
  if (last.kind === "thinking") return "正在思考…";
  if (last.running) return `正在${toolLabels[last.name] ?? "调用工具"}…`;
  return "正在整理回答…";
}

const TimelineSegment = memo(function TimelineSegment({
  segment,
  active,
  onCopyError,
}: {
  segment: QueryChatSegment;
  active: boolean;
  onCopyError: (message: string) => void;
}) {
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
  const running = segment.kind === "thinking" ? active : segment.running;
  const failed = segment.kind === "tool" && segment.isError;
  const label =
    segment.kind === "thinking" ? "思考过程" : (toolLabels[segment.name] ?? segment.name);
  const summary = segment.kind === "tool" ? toolSummary(segment) : undefined;
  return (
    <Trace data-query-segment={segment.kind}>
      <TraceCollapsible open={open} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine status={failed ? "error" : running ? "running" : undefined}>
            <TraceIcon>
              {running ? (
                <LoaderCircle className="ste:motion-safe:animate-spin" />
              ) : failed ? (
                <X />
              ) : segment.kind === "thinking" ? (
                <MessageCircleMore />
              ) : (
                <Check />
              )}
            </TraceIcon>
            <TraceTitle>{label}</TraceTitle>
            {running ? (
              <TraceDescription>执行中</TraceDescription>
            ) : failed ? (
              <TraceDescription>执行失败</TraceDescription>
            ) : summary ? (
              <TraceDescription>{summary}</TraceDescription>
            ) : null}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          {segment.kind === "thinking" ? (
            <p className="ste:text-xs ste:whitespace-pre-wrap ste:break-words">{segment.text}</p>
          ) : (
            <ToolDetail segment={segment} onCopyError={onCopyError} />
          )}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
});

function ToolDetail({
  segment,
  onCopyError,
}: {
  segment: ToolSegment;
  onCopyError: (message: string) => void;
}) {
  const args = stringifyJson(segment.args);
  const raw = segment.result === undefined ? "（无返回内容）" : stringifyJson(segment.result);
  return (
    <div className="ste:flex ste:min-w-0 ste:flex-col ste:gap-3">
      <p className="ste:flex ste:items-center ste:gap-2 ste:font-mono ste:text-xs">
        <Wrench className="ste:size-3" />
        {segment.name}
      </p>
      <CodeBlock size="sm">
        <CodeBlockHeader>
          <CodeBlockTitle>参数</CodeBlockTitle>
          <CodeBlockActions>
            <CodeBlockCopyButton
              value={args}
              aria-label="复制参数"
              copy={() => copyText(args)}
              onCopyError={onCopyError}
            />
          </CodeBlockActions>
        </CodeBlockHeader>
        <CodeBlockContent wrap className="ste:max-h-60">
          {args}
        </CodeBlockContent>
      </CodeBlock>
      {!segment.running ? (
        <CodeBlock size="sm" variant={segment.isError ? "destructive" : "default"}>
          <CodeBlockHeader>
            <CodeBlockTitle>{segment.isError ? "错误详情" : "结果"}</CodeBlockTitle>
            <CodeBlockActions>
              <CodeBlockCopyButton
                value={raw}
                aria-label="复制结果"
                copy={() => copyText(raw)}
                onCopyError={onCopyError}
              />
            </CodeBlockActions>
          </CodeBlockHeader>
          <CodeBlockContent
            wrap
            className={cn(
              "ste:max-h-80",
              segment.result === undefined && "ste:text-muted-foreground",
            )}
          >
            {raw}
          </CodeBlockContent>
        </CodeBlock>
      ) : null}
    </div>
  );
}

function toolSummary(segment: ToolSegment): string | undefined {
  if (segment.running || segment.isError || segment.result === undefined) return undefined;
  if (segment.name === "query_records") {
    const result = segment.result as QueryRecordsToolResult;
    const total = result.total ?? result.records?.length ?? 0;
    const pages = result.totalPages ?? 1;
    const page = result.page ?? 1;
    return pages > 1 ? `命中 ${total} 条记录 · 第 ${page}/${pages} 页` : `命中 ${total} 条记录`;
  }
  if (segment.name === "query_sql") {
    const result = segment.result as QuerySqlToolResult;
    const rows = result.rows?.length ?? 0;
    return `返回 ${rows} 行${result.truncated ? "（已截断）" : ""}`;
  }
  if (segment.name === "proposal_preview") {
    const result = segment.result as ProposalPreviewToolResult;
    return result.valid
      ? `${result.operations.length} 项修改待确认`
      : `校验未通过 · ${result.errors.length} 项问题`;
  }
  return undefined;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "";
}

const toolLabels: Readonly<Record<string, string>> = {
  query_records: "查询记忆记录",
  query_sql: "SQL 查询记忆",
  mutate: "准备记录变更",
  drop_mutate: "移除待提交变更",
  proposal_preview: "校验并预览提案",
  submit_proposal: "准备提交确认",
};

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
        {commit.warning}
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
