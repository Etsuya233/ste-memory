import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUERY_AGENT_TIMEOUT_MS,
  QUERY_RECORDS_TOOL_NAME,
  QueryAgent,
} from "../../src/agent/index.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-ai";
import { createTestMemorySpace, type TestMemorySpace } from "./memory-space-fixture.ts";
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

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function queryAgent(space: TestMemorySpace, streamFn: ReturnType<typeof scriptedStreamFn>) {
  return new QueryAgent({ llm: { streamFn, model: fakeModel() }, reader: space.reader });
}

function toolCallArgs(table: string, conditions?: Record<string, unknown>[]) {
  return { table, ...(conditions ? { conditions } : {}) };
}

describe("QueryAgent", () => {
  it("跑通整循环：工具调用 → 查询结果 → 回答（自然停止）", async () => {
    const space = createTestMemorySpace();
    const streamFn = scriptedStreamFn((context: Context) => {
      if (!lastToolResult(context)) {
        return assistantMessage(
          [
            toolCallMessage("call-1", QUERY_RECORDS_TOOL_NAME, {
              ...toolCallArgs("characters"),
              conditions: [{ field: "current_status", op: "equals", value: "受伤" }],
            }),
          ],
          "toolUse",
        );
      }
      return assistantMessage([textMessage("云烬和周遥目前受伤。")], "stop");
    });

    const events: string[] = [];
    const result = await queryAgent(space, streamFn).run(
      { memorySpaceId: SPACE_ID, messages: [userMessage("谁受伤了？")] },
      { onEvent: (event) => events.push(event.type) },
    );

    expect(result.stopReason).toBe("stop");
    expect(result.errorMessage).toBeUndefined();
    expect(result.answer).toBe("云烬和周遥目前受伤。");
    expect(streamFn.calls.count).toBe(2);
    expect(result.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);

    // 工具结果以字段 key 键控、剥掉噪音
    const toolResult = result.messages[2]!;
    expect(toolResult.role).toBe("toolResult");
    const text = toolResult.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    expect(text).toContain('"total": 2');
    expect(text).toContain('"current_status": "受伤"');
    expect(text).not.toContain("fieldEvidence");

    // 事件流以 agent_start 开头、agent_end 结尾，且带工具执行事件
    expect(events[0]).toBe("agent_start");
    expect(events.at(-1)).toBe("agent_end");
    expect(events).toContain("tool_execution_start");
    expect(events).toContain("tool_execution_end");
  });

  it("系统提示词含启用表/字段摘要（与工具校验共用 digest）", async () => {
    const space = createTestMemorySpace();
    const contexts: Context[] = [];
    const streamFn = scriptedStreamFn((context: Context) => {
      contexts.push(context);
      return assistantMessage([textMessage("你好。")], "stop");
    });

    await queryAgent(space, streamFn).run({
      memorySpaceId: SPACE_ID,
      messages: [userMessage("你好")],
    });

    const systemPrompt = contexts[0]?.systemPrompt ?? "";
    expect(systemPrompt).toContain("【characters｜人物】");
    expect(systemPrompt).toContain("- name｜名称：short_text，必填");
    expect(systemPrompt).toContain(
      "- current_status｜当前状态：single_select，选项：正常 / 受伤 / 死亡",
    );
    expect(systemPrompt).toContain(
      "- location｜所在地：single_reference，引用：locations（值为记录 id）",
    );
    expect(systemPrompt).not.toContain("secret_notes");
    expect(systemPrompt).not.toContain("archives");
  });

  it("digest 每次 run 只构建一次（表/字段列表各读一次）", async () => {
    const space = createTestMemorySpace();
    let listTablesCalls = 0;
    const originalListTables = space.reader.listTables;
    space.reader.listTables = async (memorySpaceId) => {
      listTablesCalls += 1;
      return originalListTables(memorySpaceId);
    };
    const streamFn = scriptedStreamFn((context: Context) => {
      if (!lastToolResult(context)) {
        return assistantMessage(
          [toolCallMessage("call-1", QUERY_RECORDS_TOOL_NAME, toolCallArgs("characters"))],
          "toolUse",
        );
      }
      return assistantMessage([textMessage("共 3 人。")], "stop");
    });

    const result = await queryAgent(space, streamFn).run({
      memorySpaceId: SPACE_ID,
      messages: [userMessage("有几个人？")],
    });

    expect(result.stopReason).toBe("stop");
    expect(listTablesCalls).toBe(1);
  });

  it("工具报错回喂后模型自愈：先错表 key，再按可用 key 列表修正", async () => {
    const space = createTestMemorySpace();
    const streamFn = scriptedStreamFn((context: Context) => {
      const last = lastToolResult(context);
      if (!last) {
        return assistantMessage(
          [toolCallMessage("call-1", QUERY_RECORDS_TOOL_NAME, toolCallArgs("characterss"))],
          "toolUse",
        );
      }
      if (last.isError) {
        return assistantMessage(
          [
            toolCallMessage("call-2", QUERY_RECORDS_TOOL_NAME, {
              ...toolCallArgs("characters"),
              conditions: [{ field: "current_status", op: "equals", value: "受伤" }],
            }),
          ],
          "toolUse",
        );
      }
      return assistantMessage([textMessage("云烬和周遥受伤。")], "stop");
    });

    const result = await queryAgent(space, streamFn).run({
      memorySpaceId: SPACE_ID,
      messages: [userMessage("谁受伤了？")],
    });

    expect(streamFn.calls.count).toBe(3);
    expect(result.answer).toBe("云烬和周遥受伤。");

    const firstToolResult = result.messages[2]!;
    expect(firstToolResult.role).toBe("toolResult");
    expect((firstToolResult as Extract<AgentMessage, { role: "toolResult" }>).isError).toBe(true);
    const errorText = firstToolResult.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    expect(errorText).toContain("可用表 key：characters、locations");
  });

  it("模型无工具调用时一轮自然停止", async () => {
    const space = createTestMemorySpace();
    const streamFn = scriptedStreamFn(() =>
      assistantMessage([textMessage("我不需要查。")], "stop"),
    );
    const result = await queryAgent(space, streamFn).run({
      memorySpaceId: SPACE_ID,
      messages: [userMessage("你好")],
    });

    expect(streamFn.calls.count).toBe(1);
    expect(result.stopReason).toBe("stop");
    expect(result.answer).toBe("我不需要查。");
    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("总超时（默认 5 分钟，可配置）触发后以 stopReason aborted 收尾，不抛异常", async () => {
    const space = createTestMemorySpace();
    const agent = new QueryAgent({
      llm: { streamFn: hangingStreamFn(), model: fakeModel() },
      reader: space.reader,
      timeoutMs: 100,
    });

    const startedAt = Date.now();
    const result = await agent.run({ memorySpaceId: SPACE_ID, messages: [userMessage("你好")] });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    expect(result.stopReason).toBe("aborted");
    expect(result.errorMessage).toBe("测试取消");
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
  });

  it("调用方信号已中止时直接返回 aborted，不启动 LLM 调用", async () => {
    const space = createTestMemorySpace();
    const streamFn = scriptedStreamFn(() => assistantMessage([textMessage("不应被调用")], "stop"));
    const controller = new AbortController();
    controller.abort();

    const result = await queryAgent(space, streamFn).run(
      { memorySpaceId: SPACE_ID, messages: [userMessage("你好")] },
      { signal: controller.signal },
    );

    expect(streamFn.calls.count).toBe(0);
    expect(result.stopReason).toBe("aborted");
    expect(result.messages).toEqual([]);
  });

  it("运行中调用方取消同样以 aborted 收尾", async () => {
    const space = createTestMemorySpace();
    const agent = new QueryAgent({
      llm: { streamFn: hangingStreamFn(), model: fakeModel() },
      reader: space.reader,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const result = await agent.run(
      { memorySpaceId: SPACE_ID, messages: [userMessage("你好")] },
      { signal: controller.signal },
    );

    expect(result.stopReason).toBe("aborted");
  });

  it("拒绝空消息输入", async () => {
    const space = createTestMemorySpace();
    const streamFn = scriptedStreamFn(() => assistantMessage([textMessage("x")], "stop"));
    await expect(
      queryAgent(space, streamFn).run({ memorySpaceId: SPACE_ID, messages: [] }),
    ).rejects.toThrow(/至少一条消息/);
  });

  it("拒绝首条非用户消息的输入", async () => {
    const space = createTestMemorySpace();
    const streamFn = scriptedStreamFn(() => assistantMessage([textMessage("x")], "stop"));
    await expect(
      queryAgent(space, streamFn).run({
        memorySpaceId: SPACE_ID,
        messages: [assistantMessage([textMessage("历史回答")], "stop")],
      }),
    ).rejects.toThrow(/第一条消息必须是用户消息/);
  });

  it("导出默认超时常量供宿主参考", () => {
    expect(DEFAULT_QUERY_AGENT_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });
});
