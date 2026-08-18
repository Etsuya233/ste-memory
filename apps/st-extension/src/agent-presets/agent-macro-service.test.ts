/**
 * Agent 预设宏服务测试（ticket 17）：fake 变更源 + fake reader + fake 注册端口，
 * 验证注册生命周期（停用注销/启用注册）、快照重建时机（指纹变化重建、未变跳过、
 * 切空间置空收敛）与两个宏的 handler 输出（摘要文本 / 默认提示词全文）。
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
} from "@ste-memory/core/memory";
import type { QueryRecordsInput, QueryRecordsPage } from "@ste-memory/core/memory";
import type { MemorySpaceReader } from "@ste-memory/core/memory/agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpaceFingerprint, SyncChangeSource } from "../cloud/space-fingerprint.ts";
import type { MemoryMacroExecutionContext, MemoryMacroRegistrationPort } from "../macros/memory-macro-service.ts";
import {
  AGENT_SYSTEM_DEFAULT_PROMPT_MACRO,
  AGENT_TABLES_DIGEST_MACRO,
  AgentMacroService,
  type AgentMacroServicePorts,
} from "./agent-macro-service.ts";

const BASE = "2026-07-28T00:00:00.000Z";

function fingerprint(updatedAt: string, counts: Partial<SpaceFingerprint> = {}): SpaceFingerprint {
  return { tables: 0, fields: 0, records: 0, history: 0, evidence: 0, updatedAt, ...counts };
}

const EMPTY_FINGERPRINT = fingerprint("");

function table(id: string, name: string, enabled = true): MemoryTable {
  return {
    id: id as MemoryTableId,
    memorySpaceId: "space-1" as MemorySpaceId,
    key: `table-${id}` as MemoryTableKey,
    kind: "custom",
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
  register(
    name: string,
    handler: (context: MemoryMacroExecutionContext) => string,
  ) {
    this.registered.set(name, handler);
  }
  unregister(name: string) {
    this.registered.delete(name);
    this.unregistered.push(name);
  }
}

class FakeChangeSource implements SyncChangeSource {
  fingerprints = new Map<string, SpaceFingerprint>();
  async listSpaceIds() {
    return [...this.fingerprints.keys()].sort();
  }
  async fingerprint(spaceId: string) {
    return this.fingerprints.get(spaceId) ?? EMPTY_FINGERPRINT;
  }
}

function createHarness(overrides: Partial<AgentMacroServicePorts> = {}) {
  const reader = new FakeReader();
  const registrar = new FakeRegistrar();
  const changes = new FakeChangeSource();
  let currentSpaceId: MemorySpaceId | undefined = "space-1" as MemorySpaceId;
  let enabled = true;
  const errors: string[] = [];
  const service = new AgentMacroService({
    getSpaceId: () => currentSpaceId,
    reader,
    readEnabled: () => enabled,
    registerMacro: registrar,
    changes,
    pollIntervalMs: 2_000,
    timers: {
      setTimeout: (handler, ms) => setTimeout(handler, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    log: { info: () => {}, warn: () => {}, error: (message) => errors.push(message) },
    ...overrides,
  });
  return {
    reader,
    registrar,
    changes,
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

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** 推进一步轮询（间隔 2s） */
async function tick() {
  await vi.advanceTimersByTimeAsync(2_000);
}

describe("AgentMacroService 注册生命周期", () => {
  it("start：注册两个宏，handler 同步返回摘要文本与默认提示词全文", async () => {
    const h = createHarness();
    h.reader.tables = [table("t1", "人物")];
    h.reader.fieldsByTable.set("t1" as MemoryTableId, [field("f1", "name")]);
    h.changes.fingerprints.set("space-1", fingerprint(BASE, { tables: 1, fields: 1 }));

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

  it("插件停用：注销宏 + 快照清空 + 停止轮询；重新启用后恢复注册", async () => {
    const h = createHarness();
    h.changes.fingerprints.set("space-1", fingerprint(BASE, { tables: 1 }));
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

  it("无活动空间：快照置空；切回空间后轮询恢复", async () => {
    const h = createHarness();
    h.reader.tables = [table("t1", "人物")];
    h.changes.fingerprints.set("space-1", fingerprint(BASE, { tables: 1 }));
    await h.service.start();
    expect(h.invokeHandler(AGENT_TABLES_DIGEST_MACRO)).toContain("人物");

    h.setSpace(undefined);
    await tick();
    expect(h.invokeHandler(AGENT_TABLES_DIGEST_MACRO)).toBe("");
    expect(h.invokeHandler(AGENT_SYSTEM_DEFAULT_PROMPT_MACRO)).toBe("");

    h.setSpace("space-1" as MemorySpaceId);
    await tick();
    expect(h.invokeHandler(AGENT_TABLES_DIGEST_MACRO)).toContain("人物");
  });

  it("指纹未变：跳过重建（handler 返回旧快照）；指纹变化：重建", async () => {
    const h = createHarness();
    h.reader.tables = [table("t1", "人物")];
    h.changes.fingerprints.set("space-1", fingerprint(BASE, { tables: 1 }));
    await h.service.start();
    expect(h.invokeHandler(AGENT_TABLES_DIGEST_MACRO)).toContain("【table-t1｜人物】");

    // 数据变化 → 指纹变化 → 重建
    h.reader.tables = [table("t1", "人物"), table("t2", "地点")];
    h.changes.fingerprints.set("space-1", fingerprint(BASE, { tables: 2 }));
    await tick();
    expect(h.invokeHandler(AGENT_TABLES_DIGEST_MACRO)).toContain("【table-t2｜地点】");

    // 指纹未变 → 跳过（快照仍是上次内容）
    h.reader.tables = [table("t1", "人物")];
    await tick();
    expect(h.invokeHandler(AGENT_TABLES_DIGEST_MACRO)).toContain("【table-t2｜地点】");
  });

  it("单轮重建失败：记日志，快照保持旧值，下轮重试", async () => {
    const h = createHarness();
    h.reader.tables = [table("t1", "人物")];
    h.changes.fingerprints.set("space-1", fingerprint(BASE, { tables: 1 }));
    await h.service.start();
    expect(h.invokeHandler(AGENT_TABLES_DIGEST_MACRO)).toContain("人物");

    h.reader.listTables = async () => {
      throw new Error("db closed");
    };
    h.changes.fingerprints.set("space-1", fingerprint(BASE, { tables: 2 }));
    await tick();
    expect(h.errors.some((m) => m.includes("Agent 预设宏快照重建失败"))).toBe(true);
    expect(h.invokeHandler(AGENT_TABLES_DIGEST_MACRO)).toContain("人物"); // 旧快照仍在
  });
});
