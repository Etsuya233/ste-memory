/**
 * 填表 Agent 决策行（ADR 0016「上下文 + 轮次」形态）：每批一条上下文行
 * （kind: context——系统提示词 + 预设消息 + 本批消息，批开始即写），此后每轮
 * 一条 turn 行（kind: turn——思考、输出、停止原因、用量、工具调用及结果）。
 *
 * 采集走 runFillAgent 的 onEvent 通道（Agent 事件订阅）：Agent 循环每轮结束
 * 必发 turn_end，携带该轮最终助手消息与工具结果（工具轮带结果，stop/error
 * 轮为空数组）——输出侧与工具结果在同一条事件里成对，无需请求快照，
 * 无需批内去重。
 */
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { LogAppendInput } from "../logging/log.ts";
import { FILL_AGENT_LOG_TYPE } from "./fill-log.ts";
import type { FillTask } from "./fill-task.ts";

/** 上下文行里的文本消息（预设 / 本批消息的简化投影）。 */
export interface FillAgentContextText {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface FillAgentContextLogInput {
  readonly task: FillTask;
  /** 批号（1 基） */
  readonly batch: number;
  /** 楼层闭区间（初始化任务省略 block，无楼层） */
  readonly from: number;
  readonly to: number;
  /** 该批完整系统提示词（编排消息 system 角色合并后的文本）。 */
  readonly systemPrompt: string;
  /** 预设消息（编排消息 user/assistant 段，进入运行前缀）。 */
  readonly preset: readonly FillAgentContextText[];
  /** 本批消息（本轮输入；{{msg}} 接管场景为空）。 */
  readonly input: readonly FillAgentContextText[];
}

/** 上下文行：批的输入快照，批开始即写（中断时系统提示词与预设仍在）。 */
export function fillAgentContextLog(input: FillAgentContextLogInput): LogAppendInput {
  const { task, batch } = input;
  return {
    type: FILL_AGENT_LOG_TYPE,
    key: task.runId,
    level: "info",
    text: JSON.stringify(
      {
        batch,
        ...(task.kind === "floor" ? { block: { from: input.from, to: input.to } } : {}),
        kind: "context",
        systemPrompt: input.systemPrompt,
        preset: input.preset,
        input: input.input,
      },
      null,
      2,
    ),
  };
}

export interface FillAgentTurnLogInput {
  readonly task: FillTask;
  /** 批号（1 基） */
  readonly batch: number;
  /** 楼层闭区间（初始化任务省略 block，无楼层） */
  readonly from: number;
  readonly to: number;
  /** 批内轮号（1 基，turn_end 到达顺序） */
  readonly round: number;
  /** 该轮最终助手消息（thinking/text/stopReason/usage/toolCalls/errorMessage）。 */
  readonly message: AssistantMessage;
  /** 该轮工具执行结果（toolResults，按 toolCallId 与工具调用配对）。 */
  readonly toolResults: readonly ToolResultMessage[];
}

/**
 * turn 行：该轮决策轨迹。失败轮（errorMessage 非空）error 级，其余 info 级；
 * 工具调用带结果（result/isError），中断时未执行完的工具只留调用参数。
 */
export function fillAgentTurnLog(input: FillAgentTurnLogInput): LogAppendInput {
  const { task, batch } = input;
  return {
    type: FILL_AGENT_LOG_TYPE,
    key: task.runId,
    level: input.message.errorMessage === undefined ? "info" : "error",
    text: JSON.stringify(
      {
        batch,
        ...(task.kind === "floor" ? { block: { from: input.from, to: input.to } } : {}),
        kind: "turn",
        round: input.round,
        thinking: thinkingOf(input.message),
        output: textOf(input.message),
        stopReason: input.message.stopReason,
        usage: {
          input: input.message.usage.input,
          output: input.message.usage.output,
          totalTokens: input.message.usage.totalTokens,
        },
        tools: turnToolsOf(input.message, input.toolResults),
        ...(input.message.errorMessage === undefined
          ? {}
          : { errorMessage: input.message.errorMessage }),
      },
      null,
      2,
    ),
  };
}

function thinkingOf(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "thinking"; thinking: string } => block.type === "thinking")
    .map((block) => block.thinking)
    .join("");
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

interface TurnTool {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly result?: string;
  readonly isError?: boolean;
}

/** 工具调用与结果配对：结果集按 toolCallId 匹配调用，匹配不到的工具只留调用参数。 */
function turnToolsOf(
  message: AssistantMessage,
  toolResults: readonly ToolResultMessage[],
): readonly TurnTool[] {
  const calls = message.content.filter(
    (
      block,
    ): block is {
      type: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    } => block.type === "toolCall",
  );
  return calls.map((call) => {
    const result = toolResults.find((toolResult) => toolResult.toolCallId === call.id);
    return {
      id: call.id,
      name: call.name,
      args: call.arguments,
      ...(result === undefined
        ? {}
        : { result: toolResultTextOf(result), isError: result.isError }),
    };
  });
}

function toolResultTextOf(result: ToolResultMessage): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export interface FillAgentTurnCollectorOptions {
  readonly task: FillTask;
  readonly batch: number;
  readonly from: number;
  readonly to: number;
  /** turn 行写入：best-effort 由调用方决定（写入失败不阻断 Agent 循环）。 */
  readonly appendLog: (input: LogAppendInput) => Promise<void>;
}

export interface FillAgentTurnCollector {
  /** Agent 事件监听（runFillAgent onEvent 通道）；只消费 turn_end。 */
  readonly listener: (event: AgentEvent) => void;
  /** 等已入队轮次行写完：批结束行落库前调用，保证行序 = 批内时间序。 */
  flush(): Promise<void>;
}

export function createFillAgentTurnCollector(
  options: FillAgentTurnCollectorOptions,
): FillAgentTurnCollector {
  let round = 0;
  // 写入队列：listener 是同步回调、appendLog 异步——串行链保证行序 = 轮次序。
  let queue: Promise<void> = Promise.resolve();
  const listener: FillAgentTurnCollector["listener"] = (event) => {
    if (event.type !== "turn_end") return;
    round += 1;
    const currentRound = round;
    // turn_end 的 message 必为本轮助手消息（循环事件契约：工具执行后与终止轮都发）。
    const message = event.message as AssistantMessage;
    queue = queue.then(() =>
      options.appendLog(
        fillAgentTurnLog({
          task: options.task,
          batch: options.batch,
          from: options.from,
          to: options.to,
          round: currentRound,
          message,
          toolResults: event.toolResults,
        }),
      ),
    );
  };
  const flush: FillAgentTurnCollector["flush"] = () => queue;
  return { listener, flush };
}
