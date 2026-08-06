import { Activity, LoaderCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import { isFillTaskTerminal } from "../api/fill-tasks.ts";
import {
  buildFillTaskTimeline,
  latestTaskStatus,
  type FillTaskLogState,
  type FillTaskTimelineItem,
} from "../fill-task-events-state.ts";
import { STATUS_META } from "../fill-task-panel-state.ts";
import { ToolCallCardView } from "./AgentActivityView.tsx";
import { MarkdownContent } from "./MarkdownContent.tsx";
/**
 * 实时运行日志（ticket 16）：块进度 + 思考/工具调用（共享 AgentActivityView 渲染）+
 * 块结果摘要 + 任务状态。日志随事件流增长，终态后保留在页面上。
 */
export function FillTaskLogView({ log }: { log: FillTaskLogState }) {
  const listRef = useRef<HTMLDivElement>(null);
  const timeline = buildFillTaskTimeline(log.entries);
  const status = latestTaskStatus(log);
  const ended = status !== undefined && isFillTaskTerminal(status.status);

  // 新事件自动滚到底部。
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [log.entries.length]);

  return (
    <div className="fill-task-log">
      <header className="fill-task-log-heading">
        <Activity size={13} />
        <span>实时运行日志</span>
        {!ended ? <LoaderCircle size={12} className="spinning" /> : null}
        {status ? (
          <em>
            {STATUS_META[status.status].label}
            {status.errorMessage ? `：${status.errorMessage}` : ""}
          </em>
        ) : null}
      </header>
      <div className="fill-task-log-list" ref={listRef}>
        {(() => {
          let blockIndex = 0;
          return timeline.map((item, index) => {
            if (item.kind === "block_start") blockIndex += 1;
            return (
              <FillTaskLogItemView
                key={index}
                item={item}
                running={!ended}
                blockIndex={item.kind === "block_start" ? blockIndex : undefined}
              />
            );
          });
        })()}
      </div>
    </div>
  );
}

function FillTaskLogItemView({
  item,
  running,
  blockIndex,
}: {
  item: FillTaskTimelineItem;
  running: boolean;
  blockIndex?: number;
}) {
  switch (item.kind) {
    case "thinking":
      return (
        <details className="thinking-block" open={running}>
          <summary>思考过程</summary>
          <MarkdownContent text={item.text} />
        </details>
      );
    case "tool":
      // 时间线 tool 项与聊天 ToolCallCard 同构（callId/name/args/result/isError）。
      return <ToolCallCardView card={item} />;
    case "block_start":
      return (
        <div className="fill-task-log-block">
          <strong>第 {blockIndex ?? "?"} 块</strong>
          <span>
            消息 {item.from}–{item.to}
          </span>
        </div>
      );
    case "block_done":
      return (
        <div className="fill-task-log-block-done">
          <span>
            ✓ 消息 {item.from}–{item.to}
          </span>
          <em>
            {item.emptyProposal ? "空提案（无需变更）" : `变更 ${item.changedRecords} 条记录`}
          </em>
        </div>
      );
    case "status":
      return (
        <div className={`fill-task-log-status ${running ? "" : "fill-task-log-status-terminal"}`}>
          {STATUS_META[item.status].label}
          {item.errorMessage ? `：${item.errorMessage}` : ""}
        </div>
      );
  }
}
