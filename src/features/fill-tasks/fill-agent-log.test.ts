import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { MemorySpaceId } from "../memory/index.ts";
import { createFillAgentRecorder, fillAgentLog } from "./fill-agent-log.ts";
import type { FillTask } from "./fill-task.ts";
import type { LogAppendInput } from "../logging/log.ts";
import {
  assistantMessage,
  fakeModel,
  scriptedStreamFn,
  textMessage,
  thinkingMessage,
  toStream,
  toolCallMessage,
  ScriptedEventStream,
} from "./stream-fn-support.ts";

/**
 * 记录器单测覆盖集成测试触达不到的路径：流静默结束（无 done/error 事件）
 * 回落 result()，以及运行结束时仍未进入请求快照的 trailingMessages 兜底
 * （批结束行完整性的契约：请求行永远只记实际发出的消息）。
 */

const SPACE_ID = "space-1" as MemorySpaceId;

function floorTask(): FillTask {
  return {
    runId: "run-fixed",
    memorySpaceId: SPACE_ID,
    from: 2,
    to: 3,
    blockSize: 2,
    kind: "floor",
    initText: null,
    chatId: "chat-1",
    status: "running",
    errorMessage: null,
    createdAt: "2026-07-30T01:02:03.000Z",
    updatedAt: "2026-07-30T01:02:03.000Z",
  };
}

function userMessage(text: string): UserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function toolResultMessage(text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "query_records",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 2,
  };
}

async function drain(stream: AsyncIterable<unknown>): Promise<number> {
  let events = 0;
  for await (const event of stream) {
    void event;
    events += 1;
  }
  return events;
}

describe("createFillAgentRecorder（issue 03 / ADR 0016）", () => {
  it("请求行：快照新增消息与该轮输出；流静默结束（无 done/error）回落 result()", async () => {
    const rows: LogAppendInput[] = [];
    const recorder = createFillAgentRecorder({
      task: floorTask(),
      batch: 2,
      from: 2,
      to: 3,
      appendLog: async (input) => {
        rows.push(input);
      },
    });
    const output = assistantMessage([thinkingMessage("想一下"), textMessage("好的")], "stop");
    const silent = new ScriptedEventStream();
    silent.end(output);
    const context: Context = { systemPrompt: "系统提示词", messages: [userMessage("问题")] };

    const stream = await recorder.wrapStreamFn(() => toStream(silent))(
      fakeModel(),
      context,
      undefined,
    );
    expect(await drain(stream)).toBe(0);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "fill-agent", key: "run-fixed", level: "info" });
    expect(JSON.parse(rows[0]!.text)).toEqual({
      batch: 2,
      block: { from: 2, to: 3 },
      round: 1,
      systemPrompt: "系统提示词",
      messages: context.messages,
      output: {
        thinking: "想一下",
        text: "好的",
        stopReason: "stop",
        usage: { input: 0, output: 0, totalTokens: 0 },
        toolCalls: [],
      },
    });
  });

  it("trailingMessages：未进入任何请求快照的消息（工具执行后直接结束）", async () => {
    const recorder = createFillAgentRecorder({
      task: floorTask(),
      batch: 1,
      from: 0,
      to: 1,
      appendLog: async () => undefined,
    });
    const prompt = userMessage("问题");
    const output = assistantMessage(
      [toolCallMessage("call-1", "query_records", { table: "characters" })],
      "toolUse",
    );
    const context: Context = { systemPrompt: "系统提示词", messages: [prompt] };
    const stream = await recorder.wrapStreamFn(scriptedStreamFn(() => output))(
      fakeModel(),
      context,
      undefined,
    );
    await drain(stream);

    // 运行结束时工具结果从未进入任何请求快照：进批结束行兜底；已记录的消息不重复
    const toolResult: Message = toolResultMessage("查询结果");
    const transcript: readonly AgentMessage[] = [prompt, output, toolResult];
    expect(recorder.trailingMessages(transcript)).toEqual([toolResult]);
    expect(recorder.trailingMessages([prompt, output])).toEqual([]);
  });

  it("请求行：失败轮（模型报错）error 级，工具调用参数与用量照常落行", async () => {
    const rows: LogAppendInput[] = [];
    const recorder = createFillAgentRecorder({
      task: floorTask(),
      batch: 1,
      from: 0,
      to: 1,
      appendLog: async (input) => {
        rows.push(input);
      },
    });
    const output = assistantMessage(
      [toolCallMessage("call-1", "mutate", { op: "create" })],
      "error",
      "模型炸了",
    );
    const context: Context = { systemPrompt: "S", messages: [userMessage("问题")] };
    const stream = await recorder.wrapStreamFn(scriptedStreamFn(() => output))(
      fakeModel(),
      context,
      undefined,
    );
    await drain(stream);

    expect(rows[0]!.level).toBe("error");
    expect(JSON.parse(rows[0]!.text).output).toMatchObject({
      stopReason: "error",
      toolCalls: [{ id: "call-1", name: "mutate", args: { op: "create" } }],
    });
  });

  it("fillAgentLog：初始化任务省略楼层区间，无系统提示词时省略 systemPrompt", () => {
    const input = {
      task: { ...floorTask(), kind: "init" as const, initText: "设定" },
      batch: 1,
      from: 0,
      to: 0,
      round: 1,
      systemPrompt: undefined,
      messages: [],
      output: assistantMessage([], "stop"),
    };
    const payload = JSON.parse(fillAgentLog(input).text);
    expect(payload).toEqual({
      batch: 1,
      round: 1,
      messages: [],
      output: {
        thinking: "",
        text: "",
        stopReason: "stop",
        usage: { input: 0, output: 0, totalTokens: 0 },
        toolCalls: [],
      },
    });
  });
});
