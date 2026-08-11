import type {
  MemoryRecord,
  MemoryRecordId,
  MemoryRevisionId,
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
  MemoryTableKey,
} from "@ste-memory/core/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpaceFingerprint, SyncChangeSource } from "../cloud/space-fingerprint.ts";
import {
  MemoryMacroService,
  type MemoryMacroDataPorts,
  type MemoryMacroRegistrationPort,
  type MemoryMacroServicePorts,
} from "./memory-macro-service.ts";

/**
 * 记忆宏服务测试（ticket 15）：fake 变更源 + fake 数据端口 + fake 注册端口，
 * 直接驱动 start/kick/轮询，验证注册生命周期（名字解析/变化注销/停用注销）、
 * 快照重建时机（指纹变化重建、未变跳过、切空间置空收敛）与输出上限。
 */

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
    description: "",
    prompt: "",
    displayStrategy: null,
    enabled,
    createdAt: BASE,
    updatedAt: BASE,
  };
}

function record(id: string, displayText: string, updatedAt: string = BASE): MemoryRecord {
  return {
    id: id as MemoryRecordId,
    memorySpaceId: "space-1" as MemorySpaceId,
    tableId: "table-1" as MemoryTableId,
    payload: {},
    fieldEvidence: {},
    displayText,
    source: { type: "manual" },
    revisionId: "r" as MemoryRevisionId,
    revisionSource: "user",
    createdAt: BASE,
    updatedAt,
  };
}

class FakeData implements MemoryMacroDataPorts {
  tables: readonly MemoryTable[] = [];
  recordsByTable = new Map<MemoryTableId, readonly MemoryRecord[]>();
  async listTables(_memorySpaceId: MemorySpaceId) {
    return [...this.tables];
  }
  async listRecords(_memorySpaceId: MemorySpaceId, tableId: MemoryTableId) {
    return this.recordsByTable.get(tableId) ?? [];
  }
}

class FakeRegistrar implements MemoryMacroRegistrationPort {
  registered = new Map<string, () => string>();
  unregistered: string[] = [];
  register(name: string, handler: () => string) {
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

function createHarness(overrides: Partial<MemoryMacroServicePorts> = {}) {
  const data = new FakeData();
  const registrar = new FakeRegistrar();
  const changes = new FakeChangeSource();
  let currentSpaceId: MemorySpaceId | undefined = "space-1" as MemorySpaceId;
  let settings = { enabled: true, macroName: "{{memoryContext}}", macroLimit: 2000 };
  const errors: string[] = [];
  const service = new MemoryMacroService({
    getSpaceId: () => currentSpaceId,
    data,
    readSettings: () => settings,
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
    data,
    registrar,
    changes,
    service,
    errors,
    setSpace(spaceId: MemorySpaceId | undefined) {
      currentSpaceId = spaceId;
    },
    setSettings(next: Partial<typeof settings>) {
      settings = { ...settings, ...next };
    },
    invokeHandler(name: string): string {
      return registrar.registered.get(name)?.() ?? "<not-registered>";
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

describe("MemoryMacroService 注册生命周期", () => {
  it("start：带花括号的配置名解析为裸标识符注册；handler 同步返回快照", async () => {
    const h = createHarness();
    h.data.tables = [table("t1", "人物")];
    h.data.recordsByTable.set("t1" as MemoryTableId, [record("r1", "张三")]);
    h.changes.fingerprints.set("space-1", fingerprint(BASE, { tables: 1, records: 1 }));

    await h.service.start();

    expect([...h.registrar.registered.keys()]).toEqual(["memoryContext"]);
    expect(h.invokeHandler("memoryContext")).toBe("【人物】\n张三");
  });

  it("宏名非法/为空：不注册（无注入）", async () => {
    const h = createHarness();
    h.setSettings({ macroName: "" });
    await h.service.start();
    expect(h.registrar.registered.size).toBe(0);

    h.setSettings({ macroName: "{{非法 名}}" });
    await h.service.kick();
    expect(h.registrar.registered.size).toBe(0);
  });

  it("宏名变化：注销旧名、注册新名（kick 立即生效）", async () => {
    const h = createHarness();
    await h.service.start();
    expect([...h.registrar.registered.keys()]).toEqual(["memoryContext"]);

    h.setSettings({ macroName: "{{myMemory}}" });
    await h.service.kick();
    expect([...h.registrar.registered.keys()]).toEqual(["myMemory"]);
    expect(h.registrar.unregistered).toEqual(["memoryContext"]);
  });

  it("同名注册不重复注销/注册（kick 幂等）", async () => {
    const h = createHarness();
    await h.service.start();
    await h.service.kick();
    await h.service.kick();
    expect(h.registrar.registered.size).toBe(1);
    expect(h.registrar.unregistered).toEqual([]);
  });

  it("插件停用：注销并清空快照；重新启用恢复（含数据未变时快照重建）", async () => {
    const h = createHarness();
    h.data.tables = [table("t1", "人物")];
    h.data.recordsByTable.set("t1" as MemoryTableId, [record("r1", "张三")]);
    h.changes.fingerprints.set("space-1", fingerprint(BASE, { tables: 1, records: 1 }));
    await h.service.start();
    expect(h.invokeHandler("memoryContext")).toBe("【人物】\n张三");

    h.setSettings({ enabled: false });
    await h.service.kick();
    expect(h.registrar.registered.size).toBe(0);
    expect(h.service.getSnapshot()).toBe("");

    // 重新启用 + 数据未变（指纹相同）：重建判定必须重新武装，快照恢复而非永久为空
    h.setSettings({ enabled: true });
    await h.service.kick();
    expect([...h.registrar.registered.keys()]).toEqual(["memoryContext"]);
    expect(h.invokeHandler("memoryContext")).toBe("【人物】\n张三");
  });
});

describe("MemoryMacroService 快照重建", () => {
  it("数据变更（指纹变化）：轮询重建快照，handler 展开最新记忆", async () => {
    const h = createHarness();
    h.data.tables = [table("t1", "人物")];
    h.data.recordsByTable.set("t1" as MemoryTableId, [record("r1", "张三")]);
    h.changes.fingerprints.set("space-1", fingerprint(BASE, { tables: 1, records: 1 }));
    await h.service.start();
    expect(h.invokeHandler("memoryContext")).toBe("【人物】\n张三");

    // 填表/手动编辑：新记录写入（updatedAt 前进）
    h.data.recordsByTable.set("t1" as MemoryTableId, [
      record("r1", "张三"),
      record("r2", "李四", "2026-07-28T01:00:00.000Z"),
    ]);
    h.changes.fingerprints.set("space-1", fingerprint("2026-07-28T01:00:00.000Z", { tables: 1, records: 2 }));
    await tick();

    expect(h.invokeHandler("memoryContext")).toBe("【人物】\n李四\n张三");
  });

  it("指纹未变：轮询不重建（handler 仍返回旧快照）", async () => {
    const h = createHarness();
    h.data.tables = [table("t1", "人物")];
    h.data.recordsByTable.set("t1" as MemoryTableId, [record("r1", "张三")]);
    h.changes.fingerprints.set("space-1", fingerprint(BASE, { tables: 1, records: 1 }));
    await h.service.start();

    // 数据端口被外部改掉但指纹没变（理论上不会发生）：不重建
    h.data.recordsByTable.set("t1" as MemoryTableId, [record("r1", "被改")]);
    await tick();
    expect(h.invokeHandler("memoryContext")).toBe("【人物】\n张三");
  });

  it("无活动空间：快照置空；切回后轮询恢复", async () => {
    const h = createHarness();
    h.data.tables = [table("t1", "人物")];
    h.data.recordsByTable.set("t1" as MemoryTableId, [record("r1", "张三")]);
    h.changes.fingerprints.set("space-1", fingerprint(BASE, { tables: 1, records: 1 }));
    await h.service.start();
    expect(h.invokeHandler("memoryContext")).toBe("【人物】\n张三");

    h.setSpace(undefined);
    await tick();
    expect(h.service.getSnapshot()).toBe("");

    h.setSpace("space-1" as MemorySpaceId);
    await tick();
    expect(h.invokeHandler("memoryContext")).toBe("【人物】\n张三");
  });

  it("切到另一个空间：重建为该空间数据", async () => {
    const h = createHarness();
    h.data.tables = [table("t1", "人物")];
    h.data.recordsByTable.set("t1" as MemoryTableId, [record("r1", "空间一")]);
    h.changes.fingerprints.set("space-1", fingerprint(BASE, { tables: 1, records: 1 }));
    h.changes.fingerprints.set("space-2", fingerprint(BASE, { tables: 1, records: 1 }));
    await h.service.start();

    h.setSpace("space-2" as MemorySpaceId);
    h.data.tables = [table("t2", "地点")];
    h.data.recordsByTable.set("t2" as MemoryTableId, [record("r2", "王城")]);
    await tick();
    expect(h.invokeHandler("memoryContext")).toBe("【地点】\n王城");
  });

  it("上限配置生效：超限尾部截断 + 标记", async () => {
    const h = createHarness();
    h.setSettings({ macroLimit: 8 });
    h.data.tables = [table("t1", "人物")];
    h.data.recordsByTable.set("t1" as MemoryTableId, [record("r1", "很长的一条记录")]);
    h.changes.fingerprints.set("space-1", fingerprint(BASE, { tables: 1, records: 1 }));
    await h.service.start();

    // 整段 12 字符 > 上限 8：保留头部 1 字符 + 截断标记（总长 = 上限）
    expect(h.invokeHandler("memoryContext")).toBe("【……（已截断）");
    expect(h.service.getSnapshot().length).toBe(8);

    // 调大上限：kick 立即按新上限重建
    h.setSettings({ macroLimit: 2000 });
    await h.service.kick();
    expect(h.invokeHandler("memoryContext")).toBe("【人物】\n很长的一条记录");
  });

  it("停用表不进入快照；启用表记录为空则省略该表", async () => {
    const h = createHarness();
    h.data.tables = [table("t1", "人物"), table("t2", "停用表", false)];
    h.data.recordsByTable.set("t1" as MemoryTableId, [record("r1", "张三")]);
    h.data.recordsByTable.set("t2" as MemoryTableId, [record("r2", "不应出现")]);
    h.changes.fingerprints.set("space-1", fingerprint(BASE, { tables: 2, records: 2 }));
    await h.service.start();

    expect(h.invokeHandler("memoryContext")).toBe("【人物】\n张三");
  });

  it("快照重建失败只记日志，快照保持旧值", async () => {
    const h = createHarness();
    h.data.tables = [table("t1", "人物")];
    h.data.recordsByTable.set("t1" as MemoryTableId, [record("r1", "张三")]);
    h.changes.fingerprints.set("space-1", fingerprint(BASE, { tables: 1, records: 1 }));
    await h.service.start();
    expect(h.invokeHandler("memoryContext")).toBe("【人物】\n张三");

    // 数据端口抛错（模拟 Dexie 故障）
    h.data.listRecords = async () => {
      throw new Error("Dexie 故障");
    };
    h.changes.fingerprints.set("space-1", fingerprint("2026-07-28T02:00:00.000Z", { tables: 1, records: 1 }));
    await tick();

    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain("Dexie 故障");
    expect(h.invokeHandler("memoryContext")).toBe("【人物】\n张三"); // 旧快照仍在
  });
});
