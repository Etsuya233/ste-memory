/**
 * 使用只读端口和同步宏注册端口，验证提交通知驱动的刷新与异步结果归属。
 */
import type {
  MemoryField,
  MemoryFieldId,
  MemoryFieldKey,
  MemoryFieldType,
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
  MemoryTableKey,
} from "../memory/index.ts";
import type { QueryRecordsInput, QueryRecordsPage } from "../memory/index.ts";
import type { MemorySpaceReader } from "../memory/index.ts";
import { describe, expect, it } from "vitest";
import type {
  MemoryMacroExecutionContext,
  MemoryMacroRegistrationPort,
} from "../macros/memory-macro-service.ts";
import {
  AGENT_SYSTEM_DEFAULT_PROMPT_MACRO,
  AGENT_TABLES_DIGEST_MACRO,
  AgentMacroService,
  type AgentMacroServicePorts,
} from "./agent-macro-service.ts";

const BASE = "2026-07-28T00:00:00.000Z";

function table(id: string, name: string, enabled = true): MemoryTable {
  return {
    id: id as MemoryTableId,
    memorySpaceId: "space-1" as MemorySpaceId,
    key: `table-${id}` as MemoryTableKey,
    position: 0,
    name,
    description: "登场角色",
    prompt: "",
    displayStrategy: null,
    enabled,
    createdAt: BASE,
    updatedAt: BASE,
  };
}

function field(id: string, key: string): MemoryField {
  return {
    id: id as MemoryFieldId,
    memorySpaceId: "space-1" as MemorySpaceId,
    tableId: "table-1" as MemoryTableId,
    key: key as MemoryFieldKey,
    name: `字段${id}`,
    type: "short_text" as MemoryFieldType,
    required: true,
    prompt: "",
    enabled: true,
    position: 0,
    maxChars: 50,
    valuePattern: null,
    valuePatternMessage: null,
    options: [],
    referenceTableId: null,
    createdAt: BASE,
    updatedAt: BASE,
  };
}

class FakeReader implements MemorySpaceReader {
  async getSpace() {
    return undefined;
  }
  tables: readonly MemoryTable[] = [];
  fieldsByTable = new Map<MemoryTableId, readonly MemoryField[]>();
  async listTables(_memorySpaceId: MemorySpaceId) {
    return [...this.tables];
  }
  async listFields(_memorySpaceId: MemorySpaceId, tableId: MemoryTableId) {
    return this.fieldsByTable.get(tableId) ?? [];
  }
  async queryRecords(
    _memorySpaceId: MemorySpaceId,
    _input: QueryRecordsInput,
  ): Promise<QueryRecordsPage> {
    return { records: [], page: 1, pageSize: 20, total: 0, totalPages: 0 };
  }
}

class FakeRegistrar implements MemoryMacroRegistrationPort {
  registered = new Map<string, (context: MemoryMacroExecutionContext) => string>();
  unregistered: string[] = [];
  register(name: string, handler: (context: MemoryMacroExecutionContext) => string) {
    this.registered.set(name, handler);
  }
  unregister(name: string) {
    this.registered.delete(name);
    this.unregistered.push(name);
  }
}

function createHarness(overrides: Partial<AgentMacroServicePorts> = {}) {
  const reader = new FakeReader();
  const registrar = new FakeRegistrar();
  let currentSpaceId: MemorySpaceId | undefined = "space-1" as MemorySpaceId;
  let enabled = true;
  const errors: string[] = [];
  const service = new AgentMacroService({
    getSpaceId: () => currentSpaceId,
    reader,
    readEnabled: () => enabled,
    registerMacro: registrar,
    log: { info: () => {}, warn: () => {}, error: (message) => errors.push(message) },
    ...overrides,
  });
  return {
    reader,
    registrar,
    service,
    errors,
    setSpace(spaceId: MemorySpaceId | undefined) {
      currentSpaceId = spaceId;
    },
    setEnabled(next: boolean) {
      enabled = next;
    },
    invokeHandler(name: string): string {
      return registrar.registered.get(name)?.({}) ?? "<not-registered>";
    },
  };
}

describe("AgentMacroService 注册生命周期", () => {
  it("start：注册两个宏，handler 同步返回摘要文本与默认提示词全文", async () => {
    const h = createHarness();
    h.reader.tables = [table("t1", "人物")];
    h.reader.fieldsByTable.set("t1" as MemoryTableId, [field("f1", "name")]);

    await h.service.start();

    expect([...h.registrar.registered.keys()].sort()).toEqual(
      [AGENT_SYSTEM_DEFAULT_PROMPT_MACRO, AGENT_TABLES_DIGEST_MACRO].sort(),
    );
    const digestText = h.invokeHandler(AGENT_TABLES_DIGEST_MACRO);
    expect(digestText).toContain("【table-t1｜人物】");
    expect(digestText).toContain("- name｜字段f1：short_text，必填，≤50字");
    const defaultPrompt = h.invokeHandler(AGENT_SYSTEM_DEFAULT_PROMPT_MACRO);
    expect(defaultPrompt).toContain("你是记忆表格填写助手");
    expect(defaultPrompt).toContain(digestText); // 默认全文含摘要
  });

  it("插件停用时注销宏并清空快照，重新启用后恢复注册", async () => {
    const h = createHarness();
    await h.service.start();
    expect(h.registrar.registered.size).toBe(2);

    h.setEnabled(false);
    await h.service.kick();
    expect(h.registrar.registered.size).toBe(0);
    expect(h.service.getSnapshot()).toEqual({ digestText: "", defaultPromptText: "" });
    expect(h.registrar.unregistered.sort()).toEqual(
      [AGENT_SYSTEM_DEFAULT_PROMPT_MACRO, AGENT_TABLES_DIGEST_MACRO].sort(),
    );

    h.setEnabled(true);
    await h.service.kick();
    expect(h.registrar.registered.size).toBe(2);
  });

  it("聊天切换通知立即清空旧空间宏，重新激活后显式刷新", async () => {
    const h = createHarness();
    h.reader.tables = [table("t1", "人物")];
    await h.service.start();
    expect(h.invokeHandler(AGENT_TABLES_DIGEST_MACRO)).toContain("人物");

    h.setSpace(undefined);
    const leaving = h.service.kick();
    expect(h.invokeHandler(AGENT_TABLES_DIGEST_MACRO)).toBe("");
    await leaving;
    expect(h.invokeHandler(AGENT_TABLES_DIGEST_MACRO)).toBe("");
    expect(h.invokeHandler(AGENT_SYSTEM_DEFAULT_PROMPT_MACRO)).toBe("");

    h.setSpace("space-1" as MemorySpaceId);
    await h.service.kick();
    expect(h.invokeHandler(AGENT_TABLES_DIGEST_MACRO)).toContain("人物");
  });

  it("只有显式提交通知才刷新，不依赖本地指纹或轮询", async () => {
    const h = createHarness();
    h.reader.tables = [table("t1", "人物")];
    await h.service.start();
    expect(h.invokeHandler(AGENT_TABLES_DIGEST_MACRO)).toContain("【table-t1｜人物】");

    h.reader.tables = [table("t1", "人物"), table("t2", "地点")];
    expect(h.invokeHandler(AGENT_TABLES_DIGEST_MACRO)).not.toContain("地点");
    await h.service.kick();
    expect(h.invokeHandler(AGENT_TABLES_DIGEST_MACRO)).toContain("【table-t2｜地点】");

    h.reader.tables = [table("t1", "人物")];
    expect(h.invokeHandler(AGENT_TABLES_DIGEST_MACRO)).toContain("【table-t2｜地点】");
    await h.service.kick();
    expect(h.invokeHandler(AGENT_TABLES_DIGEST_MACRO)).not.toContain("地点");
  });

  it("重建失败清空失效宏并报告错误，下一次通知可以恢复", async () => {
    const h = createHarness();
    h.reader.tables = [table("t1", "人物")];
    await h.service.start();
    expect(h.invokeHandler(AGENT_TABLES_DIGEST_MACRO)).toContain("人物");

    h.reader.listTables = async () => {
      throw new Error("db closed");
    };
    await h.service.kick();
    expect(h.errors.some((m) => m.includes("Agent 预设宏快照重建失败"))).toBe(true);
    expect(h.invokeHandler(AGENT_TABLES_DIGEST_MACRO)).toBe("");
    h.reader.listTables = async () => [table("t2", "地点")];
    await h.service.kick();
    expect(h.invokeHandler(AGENT_TABLES_DIGEST_MACRO)).toContain("地点");
  });

  it("切换期间旧读取迟到或服务停止后不能重新发布快照", async () => {
    const h = createHarness();
    h.reader.tables = [table("t1", "人物")];
    await h.service.start();
    let finishRead!: (tables: MemoryTable[]) => void;
    let reading!: () => void;
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    h.reader.listTables = async () => {
      reading();
      return new Promise<MemoryTable[]>((resolve) => {
        finishRead = resolve;
      });
    };
    const pending = h.service.kick();
    await started;
    h.setSpace(undefined);
    const leaving = h.service.kick();
    finishRead([table("late", "迟到人物")]);
    await Promise.all([pending, leaving]);
    expect(h.invokeHandler(AGENT_TABLES_DIGEST_MACRO)).toBe("");
    h.service.stop();
    expect(h.registrar.registered.size).toBe(0);
    await h.service.kick();
    expect(h.registrar.registered.size).toBe(0);
  });
});
