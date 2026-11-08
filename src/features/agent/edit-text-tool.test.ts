import { describe, expect, it } from "vitest";
import { validateToolArguments } from "@earendil-works/pi-ai";
import {
  createServices,
  createTestDatabase,
  installDefaultPreset,
} from "../../infrastructure/indexeddb/test-support.ts";
import {
  MemoryRecordQueryService,
  validateProposalOperation,
  type MemorySpaceReader,
} from "../memory/index.ts";
import { buildMemorySpaceTableDigest } from "./digest.ts";
import { createTaskMutationTools } from "./task-mutation-tools.ts";
import { createEditTextTool, type EditTextToolParams } from "./tools/proposal/edit-text-tool.ts";
import { createMutateTool } from "./tools/proposal/mutate-tool.ts";
import { ProposalState } from "./tools/proposal/proposal-state.ts";
import { runFillAgent } from "./fill-agent-runner.ts";
import {
  assistantMessage,
  fakeModel,
  scriptedStreamFn,
  textMessage,
  toolCallMessage,
} from "./stream-fn-support.ts";

async function setup(initial: string | null = "高一同班。", proposal = false) {
  const services = await createServices(createTestDatabase());
  const space = await services.spaces.create("文本编辑");
  await installDefaultPreset(services.memoryStore, space.id);
  const table = (await services.tables.list(space.id)).find((t) => t.key === "characters")!;
  const fields = await services.fields.list(space.id, table.id);
  const background = fields.find((f) => f.key === "background")!;
  const name = fields.find((f) => f.key === "name")!;
  await services.fields.update(space.id, table.id, background.id, { maxChars: 40 });
  const record = (await services.records.create(space.id, table.id, {
    payload: { [name.id]: "陈同学", [background.id]: initial },
  }))!;
  const reader: MemorySpaceReader = {
    getSpace: (id) => services.spaces.find(id),
    listTables: (id) => services.tables.list(id),
    listFields: (id, tableId) => services.fields.list(id, tableId),
    queryRecords: (id, input) =>
      new MemoryRecordQueryService(
        services.tableRepository,
        services.fieldRepository,
        services.recordRepository,
      ).query(id, input),
  };
  const ports = {
    tables: services.tableRepository,
    fields: services.fieldRepository,
    records: services.recordRepository,
  };
  const digest = await buildMemorySpaceTableDigest(reader, space.id);
  const state = new ProposalState();
  const mutate = createMutateTool({
    digest,
    state,
    validateOperation: (op) => validateProposalOperation(ports, space.id, op),
  });
  const task = createTaskMutationTools({
    digest,
    ports,
    reader,
    memorySpaceId: space.id,
    messageRange: { from: 1, to: 2 },
    evidence: [],
    writer: services.records,
  });
  const tool = proposal
    ? createEditTextTool({
        digest,
        reader,
        state,
        update: async (id, params) => (await mutate.execute(id, params)).details,
      })
    : task.tools.find((t) => t.name === "edit_text")!;
  const target = {
    table: "characters",
    recordId: record.id,
    expectedRevisionId: record.revisionId,
    field: "background",
  };
  const read = () => services.recordRepository.find(space.id, table.id, record.id);
  const edit = async (params: Partial<EditTextToolParams>) => {
    const args = { ...target, ...params };
    const validated = validateToolArguments(tool, {
      type: "toolCall",
      id: "edit",
      name: "edit_text",
      arguments: args,
    });
    return tool.execute("edit", validated);
  };
  return {
    services,
    space,
    table,
    background,
    record,
    reader,
    ports,
    digest,
    state,
    mutate,
    task,
    tool,
    target,
    read,
    edit,
  };
}

describe("edit_text", () => {
  it("事务模式追加保留旧事实，返回完整值和新修订，再局部替换保留其余文本", async () => {
    const h = await setup();
    const appended = await h.edit({ op: "append", text: "9月：留宿照护朋友。" });
    const current = (await h.read())!;
    expect(current.payload[h.background.id]).toBe("高一同班。\n9月：留宿照护朋友。");
    expect(appended.details).toMatchObject({
      value: current.payload[h.background.id],
      length: 16,
      revisionId: current.revisionId,
    });
    expect(current.revisionId).not.toBe(h.record.revisionId);
    await h.edit({
      op: "replace",
      expectedRevisionId: current.revisionId,
      oldText: "高一同班。",
      newText: "高一同班并成为好友。",
    });
    expect((await h.read())!.payload[h.background.id]).toBe(
      "高一同班并成为好友。\n9月：留宿照护朋友。",
    );
    expect((await h.read())!.displayText).toBe("陈同学");
  });

  it("空字段直接写入，支持用空 newText 删除唯一片段", async () => {
    const h = await setup(null);
    await h.edit({ op: "append", text: "旧事实；新经历" });
    await h.edit({
      op: "replace",
      expectedRevisionId: (await h.read())!.revisionId,
      oldText: "；新经历",
      newText: "",
    });
    expect((await h.read())!.payload[h.background.id]).toBe("旧事实");
  });

  it.each(["不存在", "同班"])("拒绝未命中或多次命中的片段 %s，原值保留", async (oldText) => {
    const h = await setup("同班，同班。");
    await expect(h.edit({ op: "replace", oldText, newText: "好友" })).rejects.toThrow(
      "精确且唯一匹配",
    );
    expect((await h.read())!.revisionId).toBe(h.record.revisionId);
  });

  it("追加与替换超长均拒绝，旧值与修订保持不变", async () => {
    const h = await setup();
    await expect(h.edit({ op: "append", text: "新增".repeat(30) })).rejects.toThrow("超过上限");
    await expect(
      h.edit({ op: "replace", oldText: "高一同班。", newText: "新增".repeat(30) }),
    ).rejects.toThrow("超过上限");
    expect(await h.read()).toEqual(h.record);
  });

  it("拒绝过期修订和非文本字段", async () => {
    const h = await setup();
    await expect(
      h.edit({ op: "append", text: "新经历", expectedRevisionId: "old" }),
    ).rejects.toThrow("修订已变化");
    await expect(h.edit({ op: "append", text: "别名", field: "aliases" })).rejects.toThrow(
      "short_text 或 long_text",
    );
  });

  it("schema 顶层为 object，拒绝缺参和空匹配片段", async () => {
    const h = await setup();
    expect(JSON.parse(JSON.stringify(h.tool.parameters)).type).toBe("object");
    await expect(h.edit({ op: "append" })).rejects.toThrow();
    await expect(h.edit({ op: "replace", oldText: "", newText: "新事实" })).rejects.toThrow();
  });

  it("提案内连续编辑读取待提交值，全文 update 后仍可继续编辑，落库保持用户确认边界", async () => {
    const h = await setup("高一同班。", true);
    await h.edit({ op: "append", text: "照护朋友。" });
    await h.edit({ op: "replace", oldText: "照护朋友。", newText: "留宿照护朋友。" });
    expect(h.state.operations[0]!.patch.background).toBe("高一同班。\n留宿照护朋友。");
    await h.mutate.execute("full", {
      op: "update",
      table: "characters",
      recordId: h.record.id,
      expectedRevisionId: h.record.revisionId,
      patch: { background: null },
    });
    await h.edit({ op: "append", text: "整理后的经历。" });
    expect(h.state.operations[0]!.patch.background).toBe("整理后的经历。");
    expect((await h.read())!.payload[h.background.id]).toBe("高一同班。");
  });

  it.each([false, true])("Agent 实际挂载 edit_text，事务模式=%s", async (transaction) => {
    const h = await setup();
    let round = 0;
    const streamFn = scriptedStreamFn((context) => {
      expect(context.tools?.some((t) => t.name === "edit_text")).toBe(true);
      if (round++ === 0)
        return assistantMessage(
          [
            toolCallMessage("edit", "edit_text", { ...h.target, op: "append", text: "照护朋友。" }),
            toolCallMessage("finish", "submit_proposal", {}),
          ],
          "toolUse",
        );
      return assistantMessage([textMessage("完成")], "stop");
    });
    const result = await runFillAgent({
      llm: { streamFn, model: fakeModel() },
      reader: h.reader,
      ports: h.ports,
      memorySpaceId: h.space.id,
      digest: h.digest,
      composedMessages: [],
      messages: [{ role: "user", content: "追加重要经历", timestamp: Date.now() }],
      messageRange: { from: 1, to: 2 },
      evidence: [],
      timeoutMs: 10_000,
      ...(transaction ? { taskWriter: h.services.records } : {}),
    });
    expect(result.errorMessage).toBeUndefined();
    expect((await h.read())!.payload[h.background.id]).toBe(
      transaction ? "高一同班。\n照护朋友。" : "高一同班。",
    );
    if (!transaction) expect(result.proposal).toBeDefined();
  });
});
