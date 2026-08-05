import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROPOSAL_AGENT_TIMEOUT_MS,
  DROP_MUTATE_TOOL_NAME,
  MUTATE_TOOL_NAME,
  PROPOSAL_PREVIEW_TOOL_NAME,
  ProposalAgent,
  SUBMIT_PROPOSAL_TOOL_NAME,
} from "../../src/agent/index.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context, ToolResultMessage } from "@earendil-works/pi-ai";
import { createTestMemorySpace, type TestMemorySpace } from "./memory-space-fixture.ts";
import { SPACE_ID } from "./memory-space-data.ts";
import {
  assistantMessage,
  fakeModel,
  lastToolResult,
  scriptedStreamFn,
  textMessage,
  toolCallMessage,
} from "./stream-fn-support.ts";

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

function proposalAgent(space: TestMemorySpace, streamFn: ReturnType<typeof scriptedStreamFn>) {
  return new ProposalAgent({
    llm: { streamFn, model: fakeModel() },
    reader: space.reader,
    ports: space.ports,
  });
}

function lastToolResultOf(context: Context): ToolResultMessage | undefined {
  const last = lastToolResult(context);
  return last && last.role === "toolResult" ? (last as ToolResultMessage) : undefined;
}

function lastToolName(context: Context): string | undefined {
  return lastToolResultOf(context)?.toolName;
}

function lastToolDetails<T>(context: Context): T | undefined {
  return lastToolResultOf(context)?.details as T | undefined;
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

function toolResultText(message: Extract<AgentMessage, { role: "toolResult" }>): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function runAgent(
  space: TestMemorySpace,
  respond: (context: Context) => ReturnType<typeof assistantMessage>,
) {
  const streamFn = scriptedStreamFn(respond);
  return { streamFn, agent: proposalAgent(space, streamFn) };
}

describe("ProposalAgent", () => {
  it("完整工作流：mutate 构建 → preview 校验 → submit 冻结提案（含统一 MutationBatch）", async () => {
    const space = createTestMemorySpace();
    const step = { value: 0 };
    const { streamFn, agent } = runAgent(space, (context) => {
      const toolName = lastToolName(context);
      const calls = streamFn.calls.count;
      // 未开始：mutate create
      if (step.value === 0) {
        step.value = 1;
        return assistantMessage(
          [
            toolCallMessage("call-1", MUTATE_TOOL_NAME, {
              op: "create",
              table: "characters",
              patch: { name: "新角色", current_status: "正常", aliases: ["新"] },
            }),
          ],
          "toolUse",
        );
      }
      if (step.value === 1 && toolName === MUTATE_TOOL_NAME) {
        step.value = 2;
        return assistantMessage(
          [toolCallMessage("call-2", PROPOSAL_PREVIEW_TOOL_NAME, {})],
          "toolUse",
        );
      }
      if (step.value === 2 && toolName === PROPOSAL_PREVIEW_TOOL_NAME) {
        step.value = 3;
        return assistantMessage(
          [toolCallMessage("call-3", SUBMIT_PROPOSAL_TOOL_NAME, {})],
          "toolUse",
        );
      }
      if (step.value === 3 && toolName === SUBMIT_PROPOSAL_TOOL_NAME) {
        const details = lastToolDetails<{ status: string }>(context)!;
        expect(details.status).toBe("submitted");
        expect(calls).toBe(4);
        return assistantMessage([textMessage("完成。")], "stop");
      }
      throw new Error(`意外的工具轮：step=${step.value}, tool=${toolName}`);
    });

    const result = await agent.run({
      memorySpaceId: SPACE_ID,
      messages: [userMessage("请根据消息 1-3 填写表格。")],
      messageRange: MESSAGE_RANGE,
      evidence: EVIDENCE,
    });

    expect(result.stopReason).toBe("stop");
    expect(result.errorMessage).toBeUndefined();

    // 提案冻结：范围/证据随外部注入，batch 为统一 MutationBatch（id 级）
    const proposal = result.proposal!;
    expect(proposal).toBeDefined();
    expect(proposal.messageRange).toEqual(MESSAGE_RANGE);
    expect(proposal.evidence).toEqual(EVIDENCE);
    expect(proposal.batch.create).toHaveLength(1);
    expect(proposal.batch.update).toHaveLength(0);
    expect(proposal.batch.delete).toHaveLength(0);
    expect(proposal.batch.create[0]!.tempId).toBe("tmp:1");
    expect(Object.keys(proposal.batch.create[0]!.patch)).toEqual([
      "field-name",
      "field-current-status",
      "field-aliases",
    ]);
    expect(proposal.batch.create[0]!.externalId).toBe("M1");

    // 预览展开：display 按表显示策略（field: name），create 全新增
    expect(proposal.operations).toHaveLength(1);
    expect(proposal.operations[0]).toMatchObject({
      externalId: "M1",
      op: "create",
      tableKey: "characters",
      tempId: "tmp:1",
      display: "新角色",
    });
    expect(proposal.operations[0]!.changes).toEqual([
      { field: "name", old: null, new: "新角色" },
      { field: "current_status", old: null, new: "正常" },
      { field: "aliases", old: null, new: ["新"] },
    ]);
  });

  it("mutate 返回引擎分配的 tempId 与 mutationId；重复操作覆盖并提示 replaced", async () => {
    const space = createTestMemorySpace();
    const step = { value: 0 };
    const { agent } = runAgent(space, (context) => {
      const toolName = lastToolName(context);
      if (step.value === 0) {
        step.value = 1;
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
      if (step.value === 1 && toolName === MUTATE_TOOL_NAME) {
        step.value = 2;
        return assistantMessage(
          [
            toolCallMessage("call-2", MUTATE_TOOL_NAME, {
              op: "update",
              table: "characters",
              recordId: "record-1",
              expectedRevisionId: "revision-record-1",
              patch: { current_status: "死亡" },
            }),
          ],
          "toolUse",
        );
      }
      if (step.value === 2 && toolName === MUTATE_TOOL_NAME) {
        step.value = 3;
        return assistantMessage(
          [toolCallMessage("call-3", SUBMIT_PROPOSAL_TOOL_NAME, {})],
          "toolUse",
        );
      }
      if (step.value === 3 && toolName === SUBMIT_PROPOSAL_TOOL_NAME) {
        return assistantMessage([textMessage("完成。")], "stop");
      }
      throw new Error(`意外的工具轮：step=${step.value}, tool=${toolName}`);
    });

    const result = await agent.run({
      memorySpaceId: SPACE_ID,
      messages: [userMessage("填写表格")],
      messageRange: MESSAGE_RANGE,
      evidence: EVIDENCE,
    });

    // 第一次 mutate：引擎分配 tmp:1 / M1
    const mutates = toolResultsOf(result.messages, MUTATE_TOOL_NAME);
    expect(mutates).toHaveLength(2);
    expect(mutates[0]!.details).toMatchObject({
      mutationId: "M1",
      tempId: "tmp:1",
      replaced: false,
    });
    expect(mutates[1]!.details).toMatchObject({ mutationId: "M2", replaced: false });

    expect(result.proposal!.batch.create).toHaveLength(1);
    expect(result.proposal!.batch.update).toHaveLength(1);
    expect(result.proposal!.batch.update[0]!.recordId).toBe("record-1");
  });

  it("preview 校验失败（revision 不匹配）→ drop 修正 → 重新 preview → submit 成功", async () => {
    const space = createTestMemorySpace();
    const step = { value: 0 };
    const { agent } = runAgent(space, (context) => {
      const toolName = lastToolName(context);
      if (step.value === 0) {
        step.value = 1;
        return assistantMessage(
          [
            toolCallMessage("call-1", MUTATE_TOOL_NAME, {
              op: "update",
              table: "characters",
              recordId: "record-1",
              expectedRevisionId: "revision-stale",
              patch: { current_status: "死亡" },
            }),
          ],
          "toolUse",
        );
      }
      if (step.value === 1 && toolName === MUTATE_TOOL_NAME) {
        step.value = 2;
        return assistantMessage(
          [toolCallMessage("call-2", PROPOSAL_PREVIEW_TOOL_NAME, {})],
          "toolUse",
        );
      }
      if (step.value === 2 && toolName === PROPOSAL_PREVIEW_TOOL_NAME) {
        const preview = lastToolDetails<{
          valid: boolean;
          errors: { mutationId: string; message: string }[];
        }>(context)!;
        expect(preview.valid).toBe(false);
        expect(preview.errors[0]).toMatchObject({ mutationId: "M1" });
        expect(preview.errors[0]!.message).toContain("期望修订与当前不一致");
        step.value = 3;
        return assistantMessage(
          [toolCallMessage("call-3", DROP_MUTATE_TOOL_NAME, { mutationId: "M1" })],
          "toolUse",
        );
      }
      if (step.value === 3 && toolName === DROP_MUTATE_TOOL_NAME) {
        step.value = 4;
        return assistantMessage(
          [
            toolCallMessage("call-4", MUTATE_TOOL_NAME, {
              op: "update",
              table: "characters",
              recordId: "record-1",
              expectedRevisionId: "revision-record-1",
              patch: { current_status: "死亡" },
            }),
          ],
          "toolUse",
        );
      }
      if (step.value === 4 && toolName === MUTATE_TOOL_NAME) {
        step.value = 5;
        return assistantMessage(
          [toolCallMessage("call-5", PROPOSAL_PREVIEW_TOOL_NAME, {})],
          "toolUse",
        );
      }
      if (step.value === 5 && toolName === PROPOSAL_PREVIEW_TOOL_NAME) {
        const preview = lastToolDetails<{ valid: boolean }>(context)!;
        expect(preview.valid).toBe(true);
        step.value = 6;
        return assistantMessage(
          [toolCallMessage("call-6", SUBMIT_PROPOSAL_TOOL_NAME, {})],
          "toolUse",
        );
      }
      if (step.value === 6 && toolName === SUBMIT_PROPOSAL_TOOL_NAME) {
        return assistantMessage([textMessage("完成。")], "stop");
      }
      throw new Error(`意外的工具轮：step=${step.value}, tool=${toolName}`);
    });

    const result = await agent.run({
      memorySpaceId: SPACE_ID,
      messages: [userMessage("填写表格")],
      messageRange: MESSAGE_RANGE,
      evidence: EVIDENCE,
    });

    expect(result.proposal!.batch.update[0]!.expectedRevisionId).toBe("revision-record-1");
    // 6 轮工具 + 1 轮自然停止
    expect(streamFnCalls(result)).toBe(7);
  });

  it("submit 自动复核失败 throw 回喂（isError），模型修正后重新提交成功", async () => {
    const space = createTestMemorySpace();
    const step = { value: 0 };
    const { agent } = runAgent(space, (context) => {
      const toolName = lastToolName(context);
      if (step.value === 0) {
        step.value = 1;
        return assistantMessage(
          [
            toolCallMessage("call-1", MUTATE_TOOL_NAME, {
              op: "update",
              table: "characters",
              recordId: "record-1",
              expectedRevisionId: "revision-stale",
              patch: { current_status: "死亡" },
            }),
          ],
          "toolUse",
        );
      }
      if (step.value === 1 && toolName === MUTATE_TOOL_NAME) {
        step.value = 2;
        return assistantMessage(
          [toolCallMessage("call-2", SUBMIT_PROPOSAL_TOOL_NAME, {})],
          "toolUse",
        );
      }
      if (step.value === 2 && toolName === SUBMIT_PROPOSAL_TOOL_NAME) {
        const last = lastToolResultOf(context)!;
        expect(last.isError).toBe(true);
        expect(toolResultText(last)).toContain("校验未通过");
        step.value = 3;
        return assistantMessage(
          [
            toolCallMessage("call-3", MUTATE_TOOL_NAME, {
              op: "update",
              table: "characters",
              recordId: "record-1",
              expectedRevisionId: "revision-record-1",
              patch: { current_status: "死亡" },
            }),
          ],
          "toolUse",
        );
      }
      if (step.value === 3 && toolName === MUTATE_TOOL_NAME) {
        step.value = 4;
        return assistantMessage(
          [toolCallMessage("call-4", SUBMIT_PROPOSAL_TOOL_NAME, {})],
          "toolUse",
        );
      }
      if (step.value === 4 && toolName === SUBMIT_PROPOSAL_TOOL_NAME) {
        expect(lastToolResultOf(context)!.isError).toBeFalsy();
        return assistantMessage([textMessage("完成。")], "stop");
      }
      throw new Error(`意外的工具轮：step=${step.value}, tool=${toolName}`);
    });

    const result = await agent.run({
      memorySpaceId: SPACE_ID,
      messages: [userMessage("填写表格")],
      messageRange: MESSAGE_RANGE,
      evidence: EVIDENCE,
    });

    const submits = toolResultsOf(result.messages, SUBMIT_PROPOSAL_TOOL_NAME);
    expect(submits).toHaveLength(2);
    expect(submits[0]!.isError).toBe(true);
    expect(submits[1]!.isError).toBeFalsy();
    expect(result.proposal).toBeDefined();
  });

  it("mutate 错表 key 报错回喂（附可用 key 列表），模型修正后完成", async () => {
    const space = createTestMemorySpace();
    const step = { value: 0 };
    const { agent } = runAgent(space, (context) => {
      const toolName = lastToolName(context);
      if (step.value === 0) {
        step.value = 1;
        return assistantMessage(
          [
            toolCallMessage("call-1", MUTATE_TOOL_NAME, {
              op: "create",
              table: "characterss",
              patch: { name: "新角色" },
            }),
          ],
          "toolUse",
        );
      }
      if (step.value === 1 && toolName === MUTATE_TOOL_NAME) {
        const last = lastToolResultOf(context)!;
        expect(last.isError).toBe(true);
        expect(toolResultText(last)).toContain("可用表 key：characters、locations");
        step.value = 2;
        return assistantMessage(
          [
            toolCallMessage("call-2", MUTATE_TOOL_NAME, {
              op: "create",
              table: "characters",
              patch: { name: "新角色" },
            }),
          ],
          "toolUse",
        );
      }
      if (step.value === 2 && toolName === MUTATE_TOOL_NAME) {
        step.value = 3;
        return assistantMessage(
          [toolCallMessage("call-3", SUBMIT_PROPOSAL_TOOL_NAME, {})],
          "toolUse",
        );
      }
      if (step.value === 3 && toolName === SUBMIT_PROPOSAL_TOOL_NAME) {
        return assistantMessage([textMessage("完成。")], "stop");
      }
      throw new Error(`意外的工具轮：step=${step.value}, tool=${toolName}`);
    });

    const result = await agent.run({
      memorySpaceId: SPACE_ID,
      messages: [userMessage("填写表格")],
      messageRange: MESSAGE_RANGE,
      evidence: EVIDENCE,
    });

    expect(result.proposal!.batch.create).toHaveLength(1);
  });

  it("proposal_preview 按表筛选：operations 与 errors 同步过滤，整批错误保留", async () => {
    const space = createTestMemorySpace();
    const step = { value: 0 };
    const { agent } = runAgent(space, (context) => {
      const toolName = lastToolName(context);
      if (step.value === 0) {
        step.value = 1;
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
      if (step.value === 1 && toolName === MUTATE_TOOL_NAME) {
        step.value = 2;
        return assistantMessage(
          [
            toolCallMessage("call-2", MUTATE_TOOL_NAME, {
              op: "update",
              table: "locations",
              recordId: "loc-1",
              expectedRevisionId: "revision-stale",
              patch: { name: "新临渊城" },
            }),
          ],
          "toolUse",
        );
      }
      if (step.value === 2 && toolName === MUTATE_TOOL_NAME) {
        step.value = 3;
        return assistantMessage(
          [toolCallMessage("call-3", PROPOSAL_PREVIEW_TOOL_NAME, { table: "characters" })],
          "toolUse",
        );
      }
      if (step.value === 3 && toolName === PROPOSAL_PREVIEW_TOOL_NAME) {
        const preview = lastToolDetails<{
          valid: boolean;
          operations: { tableKey: string }[];
          errors: { mutationId: string; message: string }[];
        }>(context)!;
        // 只含 characters 的操作；locations 的 revision 错误被过滤；整批 valid 仍为 false
        expect(preview.operations).toHaveLength(1);
        expect(preview.operations[0]!.tableKey).toBe("characters");
        expect(preview.errors).toEqual([]);
        expect(preview.valid).toBe(false);
        step.value = 4;
        return assistantMessage(
          [toolCallMessage("call-4", PROPOSAL_PREVIEW_TOOL_NAME, {})],
          "toolUse",
        );
      }
      if (step.value === 4 && toolName === PROPOSAL_PREVIEW_TOOL_NAME) {
        const preview = lastToolDetails<{
          valid: boolean;
          errors: { mutationId: string; message: string }[];
        }>(context)!;
        expect(preview.valid).toBe(false);
        expect(preview.errors).toHaveLength(1);
        expect(preview.errors[0]!.mutationId).toBe("M2");
        expect(preview.errors[0]!.message).toContain("期望修订与当前不一致");
        step.value = 5;
        return assistantMessage(
          [toolCallMessage("call-5", DROP_MUTATE_TOOL_NAME, { mutationId: "M2" })],
          "toolUse",
        );
      }
      if (step.value === 5 && toolName === DROP_MUTATE_TOOL_NAME) {
        step.value = 6;
        return assistantMessage(
          [toolCallMessage("call-6", SUBMIT_PROPOSAL_TOOL_NAME, {})],
          "toolUse",
        );
      }
      if (step.value === 6 && toolName === SUBMIT_PROPOSAL_TOOL_NAME) {
        return assistantMessage([textMessage("完成。")], "stop");
      }
      throw new Error(`意外的工具轮：step=${step.value}, tool=${toolName}`);
    });

    const result = await agent.run({
      memorySpaceId: SPACE_ID,
      messages: [userMessage("填写表格")],
      messageRange: MESSAGE_RANGE,
      evidence: EVIDENCE,
    });

    expect(result.proposal!.batch.create).toHaveLength(1);
    expect(result.proposal!.batch.update).toHaveLength(0);
  });

  it("proposal_preview 传未知表 key 报错回喂（附可用 key 列表）", async () => {
    const space = createTestMemorySpace();
    const step = { value: 0 };
    const { agent } = runAgent(space, (context) => {
      const toolName = lastToolName(context);
      if (step.value === 0) {
        step.value = 1;
        return assistantMessage(
          [toolCallMessage("call-1", PROPOSAL_PREVIEW_TOOL_NAME, { table: "ghosts" })],
          "toolUse",
        );
      }
      if (step.value === 1 && toolName === PROPOSAL_PREVIEW_TOOL_NAME) {
        const last = lastToolResultOf(context)!;
        expect(last.isError).toBe(true);
        expect(toolResultText(last)).toContain("可用表 key：characters、locations");
        return assistantMessage([textMessage("结束。")], "stop");
      }
      throw new Error(`意外的工具轮：step=${step.value}, tool=${toolName}`);
    });

    const result = await agent.run({
      memorySpaceId: SPACE_ID,
      messages: [userMessage("填写表格")],
      messageRange: MESSAGE_RANGE,
      evidence: EVIDENCE,
    });

    expect(result.proposal).toBeUndefined();
  });

  it("自然停止（无 submit_proposal）= 无提案，State 丢弃", async () => {
    const space = createTestMemorySpace();
    const { streamFn, agent } = runAgent(space, () =>
      assistantMessage([textMessage("无需变更。")], "stop"),
    );

    const result = await agent.run({
      memorySpaceId: SPACE_ID,
      messages: [userMessage("填写表格")],
      messageRange: MESSAGE_RANGE,
      evidence: EVIDENCE,
    });

    expect(streamFn.calls.count).toBe(1);
    expect(result.stopReason).toBe("stop");
    expect(result.proposal).toBeUndefined();
  });

  it("提交后重复 submit 报错；全程无落库（无副作用）", async () => {
    const space = createTestMemorySpace();
    const step = { value: 0 };
    const { agent } = runAgent(space, (context) => {
      const toolName = lastToolName(context);
      if (step.value === 0) {
        step.value = 1;
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
      if (step.value === 1 && toolName === MUTATE_TOOL_NAME) {
        step.value = 2;
        return assistantMessage(
          [toolCallMessage("call-2", SUBMIT_PROPOSAL_TOOL_NAME, {})],
          "toolUse",
        );
      }
      if (step.value === 2 && toolName === SUBMIT_PROPOSAL_TOOL_NAME) {
        step.value = 3;
        return assistantMessage(
          [toolCallMessage("call-3", SUBMIT_PROPOSAL_TOOL_NAME, {})],
          "toolUse",
        );
      }
      if (step.value === 3 && toolName === SUBMIT_PROPOSAL_TOOL_NAME) {
        const last = lastToolResultOf(context)!;
        expect(last.isError).toBe(true);
        expect(toolResultText(last)).toContain("已提交并冻结");
        return assistantMessage([textMessage("结束。")], "stop");
      }
      throw new Error(`意外的工具轮：step=${step.value}, tool=${toolName}`);
    });

    const result = await agent.run({
      memorySpaceId: SPACE_ID,
      messages: [userMessage("填写表格")],
      messageRange: MESSAGE_RANGE,
      evidence: EVIDENCE,
    });

    const submits = toolResultsOf(result.messages, SUBMIT_PROPOSAL_TOOL_NAME);
    expect(submits).toHaveLength(2);
    expect(submits[1]!.isError).toBe(true);
    // 全程无落库：fixture 记录未被修改
    expect(space.recordsByTableId.get("table-characters" as never)!).toHaveLength(3);
  });

  it("系统提示词含提案工作流与表/字段摘要", async () => {
    const space = createTestMemorySpace();
    const contexts: Context[] = [];
    const streamFn = scriptedStreamFn((context) => {
      contexts.push(context);
      return assistantMessage([textMessage("无需变更。")], "stop");
    });

    await proposalAgent(space, streamFn).run({
      memorySpaceId: SPACE_ID,
      messages: [userMessage("填写表格")],
      messageRange: MESSAGE_RANGE,
      evidence: EVIDENCE,
    });

    const systemPrompt = contexts[0]?.systemPrompt ?? "";
    expect(systemPrompt).toContain("submit_proposal");
    expect(systemPrompt).toContain("drop_mutate");
    expect(systemPrompt).toContain("proposal_preview");
    expect(systemPrompt).toContain("【characters｜人物】");
    expect(systemPrompt).not.toContain("secret_notes");
  });

  it("导出默认超时常量（对齐 QueryAgent 5 分钟）", () => {
    expect(DEFAULT_PROPOSAL_AGENT_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });
});

function streamFnCalls(result: { messages: readonly AgentMessage[] }): number {
  // 工具轮数（assistant toolUse 消息数）+ 1 轮自然停止
  return (
    result.messages.filter(
      (message) => message.role === "assistant" && message.stopReason === "toolUse",
    ).length + 1
  );
}
