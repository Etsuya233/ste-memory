import { describe, expect, it } from "vitest";
import {
  abortedAgentRunSummary,
  buildMemorySpaceTableDigest,
  convertAgentMessagesToLlm,
  runAgentWithTimeout,
} from "./index.ts";
import { runFillAgent } from "./fill-agent-runner.ts";
import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import { createTestMemorySpace } from "./memory-space-fixture.ts";
import { SPACE_ID } from "./memory-space-data.ts";
import {
  assistantMessage,
  fakeModel,
  hangingStreamFn,
  lastToolResult,
  scriptedStreamFn,
  textMessage,
  toolCallMessage,
} from "./stream-fn-support.ts";
import { MUTATE_TOOL_NAME } from "./index.ts";

const MESSAGE_RANGE = { from: 1, to: 3 };
const EVIDENCE = [
  {
    evidence_id: "ev-1" as never,
    source_type: "chat",
    source_id: 1,
    storage_mode: "reference" as const,
    extraProps: {},
  },
];

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

/** 裸 Agent：只验证公开零件可装配（不做提案装配）。 */
function bareAgent(streamFn: StreamFn) {
  return new Agent({
    initialState: {
      systemPrompt: "测试",
      messages: [],
      model: fakeModel(),
      tools: [],
    },
    streamFn,
    getApiKey: async () => "fake",
    convertToLlm: convertAgentMessagesToLlm,
  });
}

function toolResultsOf(
  messages: readonly AgentMessage[],
  toolName: string,
): Extract<AgentMessage, { role: "toolResult" }>[] {
  return messages.filter(
    (message): message is Extract<AgentMessage, { role: "toolResult" }> =>
      message.role === "toolResult" && message.toolName === toolName,
  );
}

describe("Agent 运行基础设施公开面（ADR 0024）", () => {
  it("公开面导出：runAgentWithTimeout / convertAgentMessagesToLlm / abortedAgentRunSummary 可用", () => {
    expect(typeof runAgentWithTimeout).toBe("function");
    expect(typeof convertAgentMessagesToLlm).toBe("function");
    expect(typeof abortedAgentRunSummary).toBe("function");
  });

  it("App 层组装 smoke：公开零件 + pi-agent-core Agent 直接装配可跑通", async () => {
    const streamFn = scriptedStreamFn(() => assistantMessage([textMessage("你好。")], "stop"));
    const agent = bareAgent(streamFn);
    const events: string[] = [];
    const summary = await runAgentWithTimeout(
      agent,
      [userMessage("你好")],
      { onEvent: (event) => events.push(event.type) },
      5000,
    );

    // 事件转发 + agent_end 捕获最终对话记录
    expect(events).toContain("agent_end");
    // 摘要形状：最后一条助手消息的 stopReason / 纯文本回答
    expect(summary.stopReason).toBe("stop");
    expect(summary.errorMessage).toBeUndefined();
    expect(summary.answer).toBe("你好。");
    expect(summary.messages).toHaveLength(2);
    expect(summary.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("convertAgentMessagesToLlm：只保留标准角色，自定义角色消息被过滤", () => {
    const converted = convertAgentMessagesToLlm([
      { role: "user", content: "问题", timestamp: 1 },
      { role: "custom", content: "通知" } as AgentMessage,
      assistantMessage([textMessage("回答")], "stop"),
      {
        role: "toolResult",
        toolName: "x",
        toolCallId: "c1",
        content: [],
        isError: false,
        timestamp: 3,
      } as AgentMessage,
    ]);
    expect(converted.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
  });

  it("abortedAgentRunSummary：预中止返回统一摘要形状（stopReason=aborted）", () => {
    const summary = abortedAgentRunSummary("调用方已取消");
    expect(summary).toEqual({
      messages: [],
      stopReason: "aborted",
      errorMessage: "调用方已取消",
      answer: "",
    });
  });

  it("runAgentWithTimeout：超时到点硬中止（abort 语义，不等待当前轮）", async () => {
    const agent = bareAgent(hangingStreamFn());
    const summary = await runAgentWithTimeout(agent, [userMessage("hi")], {}, 50);
    expect(summary.stopReason).toBe("aborted");
  });

  it("runAgentWithTimeout：调用方 AbortSignal 取消以 aborted 收尾，不抛异常", async () => {
    const agent = bareAgent(hangingStreamFn());
    const controller = new AbortController();
    const promise = runAgentWithTimeout(
      agent,
      [userMessage("hi")],
      { signal: controller.signal },
      5000,
    );
    setTimeout(() => controller.abort(), 10);
    const summary = await promise;
    expect(summary.stopReason).toBe("aborted");
  });

  describe("提案 Agent 运行装配契约（runFillAgent，ADR 0024 决策 4）", () => {
    it("ProposalState 每 run 新建：两次 run 的 tempId / mutationId 都从 1 开始", async () => {
      const space = createTestMemorySpace();
      const run = async () => {
        const streamFn = scriptedStreamFn((context) => {
          if (!lastToolResult(context)) {
            return assistantMessage(
              [
                toolCallMessage("call-1", MUTATE_TOOL_NAME, {
                  op: "create",
                  table: "characters",
                  patch: { name: "新角色" },
                }),
              ],
              "toolUse",
            );
          }
          return assistantMessage([textMessage("完成。")], "stop");
        });
        const result = await runFillAgent({
          llm: { streamFn, model: fakeModel() },
          reader: space.reader,
          ports: space.ports,
          memorySpaceId: SPACE_ID,
          digest: await buildMemorySpaceTableDigest(space.reader, SPACE_ID),
          composedMessages: [],
          messages: [userMessage("填写表格")],
          messageRange: MESSAGE_RANGE,
          evidence: EVIDENCE,
          timeoutMs: 5000,
        });
        const mutates = toolResultsOf(result.messages, MUTATE_TOOL_NAME);
        expect(mutates).toHaveLength(1);
        return mutates[0]!.details as { mutationId: string; tempId: string };
      };

      // State 泄漏则第二次从 tmp:2 / M2 开始
      const first = await run();
      const second = await run();
      expect(first).toMatchObject({ mutationId: "M1", tempId: "tmp:1" });
      expect(second).toMatchObject({ mutationId: "M1", tempId: "tmp:1" });
    });

    it("总超时硬中止：timeoutMs 到点 run 以 aborted 收尾", async () => {
      const space = createTestMemorySpace();
      const digest = await buildMemorySpaceTableDigest(space.reader, SPACE_ID);
      const result = await runFillAgent({
        llm: { streamFn: hangingStreamFn(), model: fakeModel() },
        reader: space.reader,
        ports: space.ports,
        memorySpaceId: SPACE_ID,
        digest,
        composedMessages: [],
        messages: [userMessage("填写表格")],
        messageRange: MESSAGE_RANGE,
        evidence: EVIDENCE,
        timeoutMs: 50,
      });
      expect(result.stopReason).toBe("aborted");
    });
  });
});
