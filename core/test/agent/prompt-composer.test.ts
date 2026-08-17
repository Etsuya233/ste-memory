import { describe, expect, it } from "vitest";
import {
  composeInteractiveProposalAgentSystemPrompt,
  composeProposalAgentMessages,
  composeProposalAgentSystemPrompt,
  composeQueryAgentSystemPrompt,
} from "../../src/memory/application/agent/prompt-composer.ts";
import type { MemorySpaceTableDigest } from "../../src/memory/application/agent/digest.ts";

const DIGEST: MemorySpaceTableDigest = {
  tables: [
    {
      id: "table-1" as never,
      key: "characters",
      name: "角色",
      description: "登场角色",
      fields: [
        {
          id: "field-1" as never,
          key: "name",
          name: "名称",
          type: "short_text",
          required: true,
          options: [],
          referenceTableKey: null,
        },
        {
          id: "field-2" as never,
          key: "current_status",
          name: "当前状态",
          type: "short_text",
          required: false,
          options: [],
          referenceTableKey: null,
        },
      ],
    },
  ],
};

describe("composeInteractiveProposalAgentSystemPrompt", () => {
  it("要求提交前先陈述变更并征得用户明确同意", () => {
    const prompt = composeInteractiveProposalAgentSystemPrompt(DIGEST);
    // 陈述 + 征询 + 同意后才提交：一条连续指令，避免被拆散
    expect(prompt).toMatch(/陈述.*变更.*同意/s);
    expect(prompt).toContain("submit_proposal");
    // 用户不同意 / 无需变更时不得提交
    expect(prompt).toContain("不同意");
  });

  it("携带启用表/字段摘要（模型可见范围与工具一致）", () => {
    const prompt = composeInteractiveProposalAgentSystemPrompt(DIGEST);
    expect(prompt).toContain("characters");
    expect(prompt).toContain("current_status");
  });

  it("不含后台填表任务的整块消息框架（消息范围/处理块措辞）", () => {
    const prompt = composeInteractiveProposalAgentSystemPrompt(DIGEST);
    expect(prompt).not.toMatch(/处理块|消息范围|本轮消息中的对话内容/);
  });

  it("与后台填表 prompt 同源但确认要求更严格", () => {
    const interactive = composeInteractiveProposalAgentSystemPrompt(DIGEST);
    const background = composeProposalAgentSystemPrompt(DIGEST);
    // 后台模式是「自己确认无误后提交」；交互式必须是「征得用户同意后提交」
    expect(background).toContain("确认无误后调用 submit_proposal");
    expect(interactive).not.toContain("确认无误后调用 submit_proposal");
    expect(interactive).toContain("用户");
  });

  it("查询 prompt 不含任何填写指令（只读 Agent 无变更概念）", () => {
    const query = composeQueryAgentSystemPrompt(DIGEST);
    expect(query).not.toContain("submit_proposal");
    expect(query).not.toContain("mutate");
  });
});

describe("composeProposalAgentMessages（消息编排缺省组合器）", () => {
  it("单条 system 消息：内容 = 系统默认提示词全文（指令 + 摘要）", () => {
    const messages = composeProposalAgentMessages(DIGEST);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.text).toBe(composeProposalAgentSystemPrompt(DIGEST));
    expect(messages[0]!.text).toContain("你是记忆表格填写助手");
    expect(messages[0]!.text).toContain("characters");
  });
});
