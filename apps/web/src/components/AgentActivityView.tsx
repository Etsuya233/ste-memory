/**
 * Agent 活动视图（ticket 16）：思考过程（可折叠）+ 工具调用卡片（参数/结果可展开、错误高亮）。
 * 聊天面板（11.5）与填表任务实时日志共用，保证两处调试 UI 行为一致。
 */
import { Wrench } from "lucide-react";
import type { ToolCallCard } from "../query-chat-state.ts";
import { MarkdownContent } from "./MarkdownContent.tsx";

interface AgentActivityViewProps {
  readonly thinking: string;
  readonly toolCalls: readonly ToolCallCard[];
  /** 流进行中：思考默认展开、工具卡默认展开以实时观察。 */
  readonly streaming: boolean;
}

export function AgentActivityView({ thinking, toolCalls, streaming }: AgentActivityViewProps) {
  return (
    <>
      {thinking.length > 0 ? (
        <details className="thinking-block" open={streaming}>
          <summary>思考过程</summary>
          <MarkdownContent text={thinking} />
        </details>
      ) : null}
      {toolCalls.map((card) => (
        <ToolCallCardView key={card.callId} card={card} />
      ))}
    </>
  );
}

export function ToolCallCardView({ card }: { card: ToolCallCard }) {
  const running = card.result === undefined;
  return (
    <details
      className={`tool-card ${card.isError ? "tool-card-error" : ""}`}
      /* 执行中的调用默认展开以实时观察参数；结束/出错后回到折叠态 */
      open={running}
    >
      <summary>
        <Wrench size={12} />
        <code>{card.name}</code>
        <em>{card.isError ? "执行失败" : running ? "执行中…" : "完成"}</em>
      </summary>
      <pre className="tool-card-args">{JSON.stringify(card.args, null, 2)}</pre>
      {card.result !== undefined ? (
        <div className="tool-card-result">
          <strong>结果（{card.isError ? "错误" : `${recordCount(card.result)} 条记录`}）</strong>
          <pre>{JSON.stringify(card.result, null, 2)}</pre>
        </div>
      ) : null}
    </details>
  );
}

function recordCount(result: unknown): number {
  if (typeof result === "object" && result !== null && "total" in result) {
    const total = (result as { total: unknown }).total;
    if (typeof total === "number") return total;
  }
  return 0;
}
