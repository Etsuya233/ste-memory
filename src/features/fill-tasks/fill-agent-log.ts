/**
 * 填表 Agent 请求行（ADR 0016）：每次 LLM 请求一行，呈现该轮 Agent 的决策轨迹。
 *
 * 捕获靠包装 streamFn——每次 LLM 调用收到该轮完整请求快照（系统提示词 +
 * LLM 可见消息），流终止（done / error，或流静默结束回落 result()）时得到该轮
 * 最终助手消息（思考、文本、停止原因、用量、工具调用参数）。批内去重：
 *
 * - 首条请求行 messages = 该轮全部消息（预设消息 + 本批消息），带 systemPrompt
 *   快照（该批完整系统提示词）；
 * - 后续请求行 messages = 上次快照之后新增的消息，排除已作为上一条请求行
 *   output 记录在案的模型输出消息——即上一轮工具结果；历史上下文与系统提示词
 *   不重复记录。
 *
 * 工具结果自然落在下一请求行的 messages；运行结束时仍未进入任何请求快照的
 * 消息（工具执行后直接结束）由 trailingMessages 交给所在批结束行兜底。
 */
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { LogAppendInput } from "../logging/log.ts";
import { FILL_AGENT_LOG_TYPE } from "./fill-log.ts";
import type { FillTask } from "./fill-task.ts";

/** 请求行的输出原文（模型输出 → 日志字段的投影：文本与思考拼接、工具调用只留 id/name/args）。 */
interface FillAgentLogOutput {
  readonly thinking: string;
  readonly text: string;
  readonly stopReason: string;
  readonly usage: { readonly input: number; readonly output: number; readonly totalTokens: number };
  readonly toolCalls: readonly {
    readonly id: string;
    readonly name: string;
    readonly args: Record<string, unknown>;
  }[];
}

export interface FillAgentLogInput {
  readonly task: FillTask;
  /** 批号（1 基） */
  readonly batch: number;
  /** 楼层闭区间（初始化任务省略，无楼层） */
  readonly from: number;
  readonly to: number;
  /** 批内请求序号（1 基） */
  readonly round: number;
  /** 该批完整系统提示词快照（仅每批首条请求行携带，undefined = 本行省略） */
  readonly systemPrompt: string | undefined;
  /** 本轮新增消息（pi 原始消息对象，不转换） */
  readonly messages: readonly AgentMessage[];
  readonly output: AssistantMessage;
}

/**
 * 请求行载荷 → 通用日志行：key = 任务 runId，text = Pretty JSON。
 * 失败轮（模型报错 `errorMessage` 非空）error 级，其余 info 级。
 */
export function fillAgentLog(input: FillAgentLogInput): LogAppendInput {
  const output = agentOutputOf(input.output);
  return {
    type: FILL_AGENT_LOG_TYPE,
    key: input.task.runId,
    level: input.output.errorMessage === undefined ? "info" : "error",
    text: JSON.stringify(
      {
        batch: input.batch,
        ...(input.task.kind === "floor" ? { block: { from: input.from, to: input.to } } : {}),
        round: input.round,
        ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
        messages: input.messages,
        output,
      },
      null,
      2,
    ),
  };
}

function agentOutputOf(message: AssistantMessage): FillAgentLogOutput {
  const blocks = message.content;
  return {
    thinking: blocks
      .filter((block) => block.type === "thinking")
      .map((block) => block.thinking)
      .join(""),
    text: blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(""),
    stopReason: message.stopReason,
    usage: {
      input: message.usage.input,
      output: message.usage.output,
      totalTokens: message.usage.totalTokens,
    },
    toolCalls: blocks
      .filter((block) => block.type === "toolCall")
      .map((block) => ({ id: block.id, name: block.name, args: block.arguments })),
  };
}

export interface FillAgentRecorderOptions {
  readonly task: FillTask;
  readonly batch: number;
  readonly from: number;
  readonly to: number;
  /** 请求行写入：best-effort 由调用方决定（写入失败不阻断 Agent 循环）。 */
  readonly appendLog: (input: LogAppendInput) => Promise<void>;
}

export interface FillAgentRecorder {
  /** 包装 streamFn：逐轮快照新增消息，流终止时写入该轮请求行。 */
  wrapStreamFn(streamFn: StreamFn): StreamFn;
  /** 运行结束后的兜底：最终对话记录中未进入任何请求快照的消息。 */
  trailingMessages(runMessages: readonly AgentMessage[]): readonly AgentMessage[];
}

export function createFillAgentRecorder(options: FillAgentRecorderOptions): FillAgentRecorder {
  const { task, batch, from, to } = options;
  /** 已进入过请求快照的消息（含模型输出） */
  const covered = new WeakSet<AgentMessage>();
  /** 已写入请求行 output 的模型输出消息（不在 messages 里重复记录） */
  const modelOutputs = new WeakSet<AgentMessage>();
  let coveredCount = 0;
  let round = 0;
  let systemPromptPending = true;

  const wrapStreamFn: FillAgentRecorder["wrapStreamFn"] =
    (streamFn) => async (model, context, streamOptions) => {
      round += 1;
      const currentRound = round;
      const includeSystemPrompt = systemPromptPending;
      const messages = context.messages
        .slice(coveredCount)
        .filter((message) => !modelOutputs.has(message));
      // 快照本身逐轮追加（convertToLlm 只过滤不重排）：上次长度之后即本轮新增
      coveredCount = context.messages.length;
      for (const message of context.messages) covered.add(message);

      const stream = await streamFn(model, context, streamOptions);
      return forwardStream(stream, async (output) => {
        modelOutputs.add(output);
        systemPromptPending = false;
        await options.appendLog(
          fillAgentLog({
            task,
            batch,
            from,
            to,
            round: currentRound,
            systemPrompt: includeSystemPrompt ? (context.systemPrompt ?? "") : undefined,
            messages,
            output,
          }),
        );
      });
    };

  const trailingMessages: FillAgentRecorder["trailingMessages"] = (runMessages) =>
    runMessages.filter((message) => !covered.has(message) && !modelOutputs.has(message));

  return { wrapStreamFn, trailingMessages };
}

/**
 * 惰性包装流：观察器挂在原流迭代器上，逐事件透传给 Agent 循环；终止事件
 * （done/error）携带该轮最终助手消息，流静默结束（无终止事件）时回落
 * result()。迭代异常原样传播（不改变任务失败语义），result() 委托原流。
 */
function forwardStream(
  stream: AssistantMessageEventStream,
  observe: (output: AssistantMessage) => Promise<void>,
): AssistantMessageEventStream {
  const iterator = stream[Symbol.asyncIterator]();
  let observed = false;
  const observeOnce = async (output: AssistantMessage) => {
    if (observed) return;
    observed = true;
    await observe(output);
  };
  const outputOf = (event: AssistantMessageEvent): AssistantMessage | undefined => {
    if (event.type === "done") return event.message;
    if (event.type === "error") return event.error;
    return undefined;
  };
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          const next = await iterator.next();
          if (next.done) {
            const output = await stream.result();
            if (output !== undefined) await observeOnce(output);
          } else {
            const output = outputOf(next.value);
            if (output !== undefined) await observeOnce(output);
          }
          return next;
        },
      };
    },
    result: () => stream.result(),
  } as unknown as AssistantMessageEventStream;
}
