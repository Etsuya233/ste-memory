import type {
  MemoryField,
  MemoryFieldId,
  MemoryFieldKey,
  MemoryRecord,
  MemoryRecordId,
  MemoryRecordPayload,
  MemoryRevisionId,
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
  MemoryTableKey,
} from "@ste-memory/core/memory";
import type { MemorySpaceReader } from "@ste-memory/core/memory/agent";
import type { QueryRecordsInput, QueryRecordsPage } from "@ste-memory/core/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpaceFingerprint, SyncChangeSource } from "../cloud/space-fingerprint.ts";
import type { MemoryView } from "../settings/memory-views.ts";
import {
  MemoryMacroService,
  type MemoryMacroDataPorts,
  type MemoryMacroExecutionContext,
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

function field(
  id: string,
  key: string,
  type: MemoryField["type"] = "short_text",
  options: readonly string[] = [],
  name: string = key,
): MemoryField {
  return {
    id: id as MemoryFieldId,
    memorySpaceId: "space-1" as MemorySpaceId,
    tableId: "table-plots" as MemoryTableId,
    key: key as MemoryFieldKey,
    name,
    type,
    required: false,
    prompt: "",
    enabled: true,
    position: 0,
    options,
    referenceTableId: null,
    maxChars: null,
    valuePattern: null,
    valuePatternMessage: null,
    createdAt: BASE,
    updatedAt: BASE,
  };
}

/** 视图专用表（digest 与查询结果的载体）：plots 表 + name/status 字段 */
function plotsTable(): MemoryTable {
  return {
    id: "table-plots" as MemoryTableId,
    memorySpaceId: "space-1" as MemorySpaceId,
    key: "plots" as MemoryTableKey,
    kind: "custom",
    name: "伏笔",
    description: "",
    prompt: "",
    displayStrategy: null,
    enabled: true,
    createdAt: BASE,
    updatedAt: BASE,
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
  registered = new Map<string, (context: MemoryMacroExecutionContext) => string>();
  registeredArgs = new Map<
    string,
    readonly { name: string; optional?: boolean; defaultValue?: string }[]
  >();
  unregistered: string[] = [];
  register(
    name: string,
    handler: (context: MemoryMacroExecutionContext) => string,
    args?: readonly { name: string; optional?: boolean; defaultValue?: string }[],
  ) {
    this.registered.set(name, handler);
    if (args) this.registeredArgs.set(name, args);
  }
  unregister(name: string) {
    this.registered.delete(name);
    this.unregistered.push(name);
  }
}

/** 视图查询端口：digest 构建（listTables/listFields）+ queryRecords 结果/错误可配置 */
class FakeReader implements MemorySpaceReader {
  tables: readonly MemoryTable[] = [plotsTable()];
  fieldsByTable = new Map<MemoryTableId, readonly MemoryField[]>([
    [
      "table-plots" as MemoryTableId,
      [
        field("field-name", "name", "short_text", [], "名称"),
        field("field-status", "status", "single_select", ["埋设中", "已触发", "已回收"], "状态"),
      ],
    ],
  ]);
  /** 查询结果（按表 id）；缺省空页 */
  resultsByTable = new Map<MemoryTableId, QueryRecordsPage>();
  queryError: Error | undefined;
  queryCalls: readonly QueryRecordsInput[] = [];
  async listTables(_memorySpaceId: MemorySpaceId) {
    return this.tables;
  }
  async listFields(_memorySpaceId: MemorySpaceId, tableId: MemoryTableId) {
    return this.fieldsByTable.get(tableId) ?? [];
  }
  async queryRecords(
    _memorySpaceId: MemorySpaceId,
    input: QueryRecordsInput,
  ): Promise<QueryRecordsPage> {
    this.queryCalls = [...this.queryCalls, input];
    if (this.queryError) throw this.queryError;
    return (
      this.resultsByTable.get(input.tableId) ?? {
        records: [],
        page: 1,
        pageSize: input.paging.pageSize,
        total: 0,
        totalPages: 0,
      }
    );
  }
}

/** 视图记录（payload 以字段 id 键控，displayText 与投影值分开给） */
function viewRecord(id: string, displayText: string, payload: MemoryRecordPayload): MemoryRecord {
  return {
    ...record(id, displayText),
    payload,
  };
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
  const reader = new FakeReader();
  let currentSpaceId: MemorySpaceId | undefined = "space-1" as MemorySpaceId;
  let settings = {
    enabled: true,
    macroName: "{{memoryContext}}",
    macroLimit: 2000,
    memoryViews: [] as readonly MemoryView[],
  };
  const errors: string[] = [];
  const warns: string[] = [];
  const service = new MemoryMacroService({
    getSpaceId: () => currentSpaceId,
    data,
    reader,
    readSettings: () => settings,
    registerMacro: registrar,
    changes,
    readChatScopeMacros: () => [],
    pollIntervalMs: 2_000,
    timers: {
      setTimeout: (handler, ms) => setTimeout(handler, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    log: {
      info: () => {},
      warn: (message) => warns.push(message),
      error: (message) => errors.push(message),
    },
    ...overrides,
  });
  return {
    data,
    registrar,
    changes,
    reader,
    service,
    errors,
    warns,
    setSpace(spaceId: MemorySpaceId | undefined) {
      currentSpaceId = spaceId;
    },
    setSettings(next: Partial<typeof settings>) {
      settings = { ...settings, ...next };
    },
    invokeHandler(name: string, args: readonly string[] = []): string {
      return registrar.registered.get(name)?.({ unnamedArgs: args }) ?? "<not-registered>";
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

    // 只注册一个前缀宏（内置/视图/对话宏全部走 {{前缀::名字}} 分发）
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
    h.data.tables = [table("t1", "人物")];
    h.data.recordsByTable.set("t1" as MemoryTableId, [record("r1", "张三")]);
    h.changes.fingerprints.set("space-1", fingerprint(BASE, { tables: 1, records: 1 }));
    await h.service.start();
    expect([...h.registrar.registered.keys()]).toContain("memoryContext");

    h.setSettings({ macroName: "{{myMemory}}" });
    await h.service.kick();
    expect([...h.registrar.registered.keys()]).toContain("myMemory");
    expect(h.registrar.unregistered).toContain("memoryContext");
  });

  it("同名注册不重复注销/注册（kick 幂等）", async () => {
    const h = createHarness();
    await h.service.start();
    await h.service.kick();
    await h.service.kick();
    expect(h.registrar.registered.size).toBeGreaterThanOrEqual(1);
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
    // 只注册一个前缀宏（内置/视图/对话宏全部走 {{前缀::名字}} 分发）
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
    h.changes.fingerprints.set(
      "space-1",
      fingerprint("2026-07-28T01:00:00.000Z", { tables: 1, records: 2 }),
    );
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
    h.changes.fingerprints.set(
      "space-1",
      fingerprint("2026-07-28T02:00:00.000Z", { tables: 1, records: 1 }),
    );
    await tick();

    expect(h.errors.length).toBeGreaterThanOrEqual(1);
    expect(h.errors.some((e) => e.includes("Dexie 故障"))).toBe(true);
    expect(h.invokeHandler("memoryContext")).toBe("【人物】\n张三"); // 旧快照仍在
  });
});

describe("MemoryMacroService 默认快照读时显示文本", () => {
  it("模板策略表按当前目标记录重渲：地点改名后快照显示新名（存储值过期也不误读）", async () => {
    const h = createHarness();
    const locTableId = "table-locs" as MemoryTableId;
    const relTableId = "table-rels" as MemoryTableId;
    const locNameId = "field-loc-name" as MemoryFieldId;
    const relFromId = "field-rel-from" as MemoryFieldId;
    const strategyTable = (
      id: MemoryTableId,
      key: string,
      name: string,
      displayStrategy: MemoryTable["displayStrategy"],
    ): MemoryTable => ({
      id,
      memorySpaceId: "space-1" as MemorySpaceId,
      key: key as MemoryTableKey,
      kind: "custom",
      name,
      description: "",
      prompt: "",
      displayStrategy,
      enabled: true,
      createdAt: BASE,
      updatedAt: BASE,
    });
    const refField = (id: string, key: string, tableId: MemoryTableId): MemoryField => ({
      id: id as MemoryFieldId,
      memorySpaceId: "space-1" as MemorySpaceId,
      tableId,
      key: key as MemoryFieldKey,
      name: key,
      type: "single_reference",
      required: false,
      prompt: "",
      enabled: true,
      position: 0,
      options: [],
      referenceTableId: null,
      maxChars: null,
      valuePattern: null,
      valuePatternMessage: null,
      createdAt: BASE,
      updatedAt: BASE,
    });
    h.data.tables = [
      strategyTable(locTableId, "locs", "地点", { type: "field", fieldId: locNameId }),
      strategyTable(relTableId, "rels", "关系", {
        type: "template",
        template: `{${relFromId}}`,
      }),
    ];
    h.reader.tables = h.data.tables;
    h.reader.fieldsByTable = new Map([
      [locTableId, [refField("field-loc-name", "loc-name", locTableId)]],
      [
        relTableId,
        [{ ...refField("field-rel-from", "rel-from", relTableId), referenceTableId: locTableId }],
      ],
    ]);
    // 存储 displayText 是过期快照（地点还叫旧名时渲染的），payload 已指向改名后的目标
    h.data.recordsByTable = new Map([
      [
        locTableId,
        [{ ...record("loc-1", "雾都"), tableId: locTableId, payload: { [locNameId]: "雾都" } }],
      ],
      [
        relTableId,
        [{ ...record("rel-1", "旧都"), tableId: relTableId, payload: { [relFromId]: "loc-1" } }],
      ],
    ]);

    await h.service.start();
    await tick();
    expect(h.invokeHandler("memoryContext")).toContain("雾都");
    expect(h.invokeHandler("memoryContext")).not.toContain("旧都");
  });
});

describe("MemoryMacroService 记忆视图（ticket 02 / ADR 0025）", () => {
  /** 标准视图环境：伏笔表 + 1 条记录（投影字段 name/status） */
  function seedViewHarness(h: ReturnType<typeof createHarness>, view: MemoryView): void {
    h.data.tables = [plotsTable()];
    // 默认快照数据源（listRecords）与视图数据源（queryRecords）分离：各自可独立断言
    h.data.recordsByTable.set("table-plots" as MemoryTableId, [record("r1", "深夜的钟声")]);
    h.reader.resultsByTable.set("table-plots" as MemoryTableId, {
      records: [
        viewRecord("r1", "深夜的钟声", {
          "field-name": "深夜的钟声",
          "field-status": "埋设中",
        }),
      ],
      page: 1,
      pageSize: 100,
      total: 1,
      totalPages: 1,
    });
    h.changes.fingerprints.set("space-1", fingerprint(BASE, { tables: 1, records: 1 }));
    h.setSettings({ memoryViews: [view] });
  }

  it("注册携带可选名字参数声明（unnamedArgs name）", async () => {
    const h = createHarness();
    await h.service.start();
    expect(h.registrar.registeredArgs.get("memoryContext")).toEqual([
      { name: "name", optional: true, defaultValue: "" },
    ]);
  });

  it("{{宏名::视图名}} = 视图快照（翻译 → 查询 → 渲染 → 缓存）", async () => {
    const h = createHarness();
    seedViewHarness(h, {
      name: "未完成伏笔",
      tableKey: "plots",
      condition: { fieldKey: "status", values: ["埋设中", "已触发"] },
      limit: 50,
      projection: ["name", "status"],
    });
    await h.service.start();

    expect(h.invokeHandler("memoryContext", ["未完成伏笔"])).toBe("名称：深夜的钟声，状态：埋设中");
    // 翻译契约：in 算子 + $updated_at desc + pageSize = limit
    expect(h.reader.queryCalls[0]).toEqual({
      tableId: "table-plots",
      fieldIds: ["field-name", "field-status"],
      conditions: [{ fieldId: "field-status", operator: "in", value: ["埋设中", "已触发"] }],
      order: { fieldId: "$updated_at", direction: "desc" },
      paging: { page: 1, pageSize: 50 },
    });
    // 数据变更（指纹变化）：轮询重建视图快照
    h.reader.resultsByTable.set("table-plots" as MemoryTableId, {
      records: [
        viewRecord("r1", "深夜的钟声", { "field-name": "深夜的钟声", "field-status": "埋设中" }),
        viewRecord("r2", "断剑", { "field-name": "断剑", "field-status": "已回收" }),
      ],
      page: 1,
      pageSize: 100,
      total: 2,
      totalPages: 1,
    });
    h.changes.fingerprints.set(
      "space-1",
      fingerprint("2026-07-28T01:00:00.000Z", { tables: 1, records: 2 }),
    );
    await tick();
    expect(h.invokeHandler("memoryContext", ["未完成伏笔"])).toBe(
      "名称：深夜的钟声，状态：埋设中\n名称：断剑，状态：已回收",
    );
  });

  it("无参 = 默认快照（与 ticket 15 输出契约一致）；视图名与默认快照互不干扰", async () => {
    const h = createHarness();
    seedViewHarness(h, {
      name: "未完成伏笔",
      tableKey: "plots",
      condition: null,
      limit: null,
      projection: [],
    });
    await h.service.start();

    // 无参：默认快照（全启用表分组）；视图：无投影 → 显示文本单行化
    expect(h.invokeHandler("memoryContext")).toBe("【伏笔】\n深夜的钟声");
    expect(h.invokeHandler("memoryContext", ["未完成伏笔"])).toBe("深夜的钟声");
  });

  it("未知视图名/空参数：空串 + 日志（不阻断）；两个以上参数由 ST 校验拒绝", async () => {
    const h = createHarness();
    seedViewHarness(h, {
      name: "未完成伏笔",
      tableKey: "plots",
      condition: null,
      limit: null,
      projection: [],
    });
    await h.service.start();

    expect(h.invokeHandler("memoryContext", ["不存在的视图"])).toBe("");
    expect(h.invokeHandler("memoryContext", [""])).toBe(""); // {{宏名::}}
    expect(h.warns.some((w) => w.includes("不存在的视图"))).toBe(true);
    expect(h.warns.some((w) => w.includes("空名字"))).toBe(true);
  });

  it("视图 CRUD（设置变化）kick 立即生效：新增/删除视图无需等轮询", async () => {
    const h = createHarness();
    seedViewHarness(h, {
      name: "未完成伏笔",
      tableKey: "plots",
      condition: null,
      limit: null,
      projection: [],
    });
    await h.service.start();
    expect(h.invokeHandler("memoryContext", ["未完成伏笔"])).toBe("深夜的钟声");

    // 新增视图：kick 立即重建（指纹未变也必须重建——设置参与判定）
    h.setSettings({
      memoryViews: [
        {
          name: "未完成伏笔",
          tableKey: "plots",
          condition: null,
          limit: null,
          projection: [],
        },
        {
          name: "全部伏笔",
          tableKey: "plots",
          condition: { fieldKey: "status", values: ["已回收"] },
          limit: 10,
          projection: ["name"],
        },
      ],
    });
    await h.service.kick();
    expect(h.invokeHandler("memoryContext", ["全部伏笔"])).toBe("名称：深夜的钟声");

    // 删除视图：kick 后该视图名展开为空串 + 日志
    h.setSettings({ memoryViews: [] });
    await h.service.kick();
    expect(h.invokeHandler("memoryContext", ["未完成伏笔"])).toBe("");
    expect(h.warns.some((w) => w.includes("未知宏名"))).toBe(true);
    // 默认快照不受影响
    expect(h.invokeHandler("memoryContext")).toBe("【伏笔】\n深夜的钟声");
  });

  it("翻译失败（表/字段缺失）：该视图快照 = 空串 + 日志（面板可显示配置错误）", async () => {
    const h = createHarness();
    seedViewHarness(h, {
      name: "坏视图",
      tableKey: "plots",
      condition: null,
      limit: null,
      projection: [],
    });
    // 表不存在（digest 构建后查不到）
    h.setSettings({
      memoryViews: [
        { name: "坏视图", tableKey: "ghost", condition: null, limit: null, projection: [] },
      ],
    });
    await h.service.start();
    expect(h.invokeHandler("memoryContext", ["坏视图"])).toBe("");
    expect(h.warns.some((w) => w.includes("坏视图") && w.includes("配置错误"))).toBe(true);
  });

  it("查询/渲染失败：单轮保旧值 + 日志（下轮轮询重试）", async () => {
    const h = createHarness();
    seedViewHarness(h, {
      name: "未完成伏笔",
      tableKey: "plots",
      condition: null,
      limit: null,
      projection: [],
    });
    await h.service.start();
    expect(h.invokeHandler("memoryContext", ["未完成伏笔"])).toBe("深夜的钟声");

    // 查询端口抛错（模拟 Dexie 故障）：快照保持旧值，只记日志
    h.reader.queryError = new Error("查询故障");
    h.changes.fingerprints.set(
      "space-1",
      fingerprint("2026-07-28T02:00:00.000Z", { tables: 1, records: 1 }),
    );
    await tick();
    expect(h.errors.some((e) => e.includes("查询故障"))).toBe(true);
    expect(h.invokeHandler("memoryContext", ["未完成伏笔"])).toBe("深夜的钟声");
  });

  it("插件停用：视图快照一并清空；重新启用恢复", async () => {
    const h = createHarness();
    seedViewHarness(h, {
      name: "未完成伏笔",
      tableKey: "plots",
      condition: null,
      limit: null,
      projection: [],
    });
    await h.service.start();
    expect(h.invokeHandler("memoryContext", ["未完成伏笔"])).toBe("深夜的钟声");

    h.setSettings({ enabled: false });
    await h.service.kick();
    expect(h.registrar.registered.size).toBe(0); // 停用即注销（无注入）
    expect(h.service.getViewSnapshot("未完成伏笔")).toBeUndefined();

    h.setSettings({ enabled: true });
    await h.service.kick();
    expect(h.invokeHandler("memoryContext", ["未完成伏笔"])).toBe("深夜的钟声");
  });
});

describe("MemoryMacroService 内置宏分发（{{前缀::名字}}）", () => {
  it("{{前缀::full}} = 全部启用表完整 Markdown；{{前缀::表Key}} = 单表（中文表 Key 可用）", async () => {
    const h = createHarness();
    h.data.tables = [
      table("t1", "人物"),
      { ...table("c1", "角色"), key: "角色" as MemoryTableKey },
    ];
    h.data.recordsByTable.set("t1" as MemoryTableId, [viewRecord("r1", "张三", { f1: "张三" })]);
    h.data.recordsByTable.set("c1" as MemoryTableId, [viewRecord("r2", "王五", { f2: "王五" })]);
    h.reader.fieldsByTable.set("t1" as MemoryTableId, [field("f1", "姓名")]);
    h.reader.fieldsByTable.set("c1" as MemoryTableId, [field("f2", "身份")]);
    h.changes.fingerprints.set("space-1", fingerprint(BASE, { tables: 2, records: 2 }));

    await h.service.start();

    const full = h.invokeHandler("memoryContext", ["full"]);
    expect(full).toContain("## 人物");
    expect(full).toContain("## 角色");
    expect(full).toContain("张三");
    expect(full).toContain("王五");
    // 表 Key 是字符串参数：ASCII 与中文表 Key 都直接可用
    expect(h.invokeHandler("memoryContext", ["table-t1"])).toContain("## 人物");
    expect(h.invokeHandler("memoryContext", ["table-t1"])).not.toContain("## 角色");
    expect(h.invokeHandler("memoryContext", ["角色"])).toContain("## 角色");
    expect(h.invokeHandler("memoryContext", ["角色"])).not.toContain("## 人物");
    // 未知名字：空串 + 警告
    expect(h.invokeHandler("memoryContext", ["没有的表"])).toBe("");
    expect(h.warns.some((w) => w.includes("没有的表"))).toBe(true);
  });
});

describe("MemoryMacroService 聊天 Scope 宏（{{前缀::宏名}}）", () => {
  /** 聊天宏环境：chatMetadata 宏列表可变 + 伏笔表 1 条记录（与视图测试同数据源） */
  function seedChatHarness(h: ReturnType<typeof createHarness>, _view: MemoryView) {
    h.data.tables = [plotsTable()];
    h.data.recordsByTable.set("table-plots" as MemoryTableId, [record("r1", "深夜的钟声")]);
    h.reader.resultsByTable.set("table-plots" as MemoryTableId, {
      records: [
        viewRecord("r1", "深夜的钟声", {
          "field-name": "深夜的钟声",
          "field-status": "埋设中",
        }),
      ],
      page: 1,
      pageSize: 100,
      total: 1,
      totalPages: 1,
    });
    h.changes.fingerprints.set("space-1", fingerprint(BASE, { tables: 1, records: 1 }));
  }

  it("优先级：对话宏 > 全局视图 > 内置（同名覆盖）", async () => {
    let chatMacros: readonly MemoryView[] = [];
    const h = createHarness({ readChatScopeMacros: () => chatMacros });
    const chatView: MemoryView = {
      name: "full", // 对话宏覆盖内置 full
      tableKey: "plots",
      condition: null,
      limit: 50,
      projection: [],
    };
    seedChatHarness(h, chatView);
    chatMacros = [chatView];

    await h.service.start();
    expect(h.invokeHandler("memoryContext", ["full"])).toBe("深夜的钟声");

    // 删除对话宏：无同名视图时回落内置 full（此环境有伏笔表 → Markdown）
    chatMacros = [];
    await h.service.kick();
    expect(h.invokeHandler("memoryContext", ["full"])).toContain("## 伏笔");
    expect(h.service.getChatScopeSnapshot("full")).toBeUndefined();

    // 同名全局视图接管（视图 > 内置）
    h.setSettings({
      memoryViews: [
        {
          name: "full",
          tableKey: "plots",
          condition: null,
          limit: 50,
          projection: [],
        },
      ],
    });
    await h.service.kick();
    expect(h.invokeHandler("memoryContext", ["full"])).toBe("深夜的钟声");

    // 对话宏再回来：对话 > 视图
    chatMacros = [chatView];
    await h.service.kick();
    expect(h.invokeHandler("memoryContext", ["full"])).toBe("深夜的钟声");
  });

  it("{{前缀::宏名}} 展开：单一前缀注册，快照与全局视图同一翻译/查询/渲染管线", async () => {
    let chatMacros: readonly MemoryView[] = [];
    const h = createHarness({ readChatScopeMacros: () => chatMacros });
    const chatView: MemoryView = {
      name: "伏笔速览",
      tableKey: "plots",
      condition: { fieldKey: "status", values: ["埋设中"] },
      limit: 50,
      projection: ["name"],
    };
    seedChatHarness(h, chatView);
    chatMacros = [chatView];

    await h.service.start();

    // 只有前缀一个注册名（不注册独立宏名）
    expect([...h.registrar.registered.keys()]).toEqual(["memoryContext"]);
    expect(h.invokeHandler("memoryContext", ["伏笔速览"])).toBe("名称：深夜的钟声");
    // 快照走查询端口（与视图同源）
    expect(h.reader.queryCalls.some((c) => c.tableId === "table-plots")).toBe(true);
  });

  it("CRUD kick 即时生效：改名立即切换；删除后同名全局视图接管", async () => {
    let chatMacros: readonly MemoryView[] = [];
    const h = createHarness({ readChatScopeMacros: () => chatMacros });
    const chatView: MemoryView = {
      name: "伏笔速览",
      tableKey: "plots",
      condition: null,
      limit: 50,
      projection: [],
    };
    seedChatHarness(h, chatView);
    chatMacros = [chatView];

    await h.service.start();
    expect(h.invokeHandler("memoryContext", ["伏笔速览"])).toBe("深夜的钟声");

    // 改名：kick 后新名下分发到新内容
    const renamed: MemoryView = { ...chatView, name: "伏笔速览v2" };
    chatMacros = [renamed];
    await h.service.kick();
    expect(h.invokeHandler("memoryContext", ["伏笔速览v2"])).toBe("深夜的钟声");
    expect(h.invokeHandler("memoryContext", ["伏笔速览"])).toBe(""); // 旧名已无定义

    // 同名全局视图存在时：对话宏删除后由全局视图接管（优先级链回落）
    h.setSettings({
      memoryViews: [
        {
          name: "伏笔速览",
          tableKey: "plots",
          condition: null,
          limit: 50,
          projection: [],
        },
      ],
    });
    chatMacros = [];
    await h.service.kick();
    expect(h.invokeHandler("memoryContext", ["伏笔速览"])).toBe("深夜的钟声");
  });

  it("对话宏配置错误：空串 + 警告，且不回落同名全局视图（覆盖优先）", async () => {
    let chatMacros: readonly MemoryView[] = [];
    const h = createHarness({ readChatScopeMacros: () => chatMacros });
    const broken: MemoryView = {
      name: "坏宏",
      tableKey: "nope", // 表不存在
      condition: null,
      limit: 50,
      projection: [],
    };
    seedChatHarness(h, broken);
    chatMacros = [broken];
    // 同名全局视图配置正常：对话宏仍以空串覆盖（不回落）
    h.setSettings({
      memoryViews: [
        {
          name: "坏宏",
          tableKey: "plots",
          condition: null,
          limit: 50,
          projection: [],
        },
      ],
    });

    await h.service.start();

    expect(h.invokeHandler("memoryContext", ["坏宏"])).toBe("");
    expect(h.warns.some((w) => w.includes("坏宏") && w.includes("配置错误"))).toBe(true);
    expect(h.invokeHandler("memoryContext", ["full"])).toContain("## 伏笔"); // 内置 full 不受影响
  });

  it("查询失败：单轮保旧值 + 日志（下轮轮询重试）", async () => {
    let chatMacros: readonly MemoryView[] = [];
    const h = createHarness({ readChatScopeMacros: () => chatMacros });
    const chatView: MemoryView = {
      name: "伏笔速览",
      tableKey: "plots",
      condition: null,
      limit: 50,
      projection: [],
    };
    seedChatHarness(h, chatView);
    chatMacros = [chatView];

    await h.service.start();
    expect(h.invokeHandler("memoryContext", ["伏笔速览"])).toBe("深夜的钟声");

    h.reader.queryError = new Error("查询故障");
    h.changes.fingerprints.set(
      "space-1",
      fingerprint("2026-07-28T02:00:00.000Z", { tables: 1, records: 1 }),
    );
    await tick();

    expect(h.invokeHandler("memoryContext", ["伏笔速览"])).toBe("深夜的钟声"); // 保旧值
    expect(h.errors.some((e) => e.includes("伏笔速览") && e.includes("查询故障"))).toBe(true);
  });

  it("插件停用：唯一注册注销；重新启用恢复分发", async () => {
    let chatMacros: readonly MemoryView[] = [];
    const h = createHarness({ readChatScopeMacros: () => chatMacros });
    const chatView: MemoryView = {
      name: "伏笔速览",
      tableKey: "plots",
      condition: null,
      limit: 50,
      projection: [],
    };
    seedChatHarness(h, chatView);
    chatMacros = [chatView];

    await h.service.start();
    expect(h.invokeHandler("memoryContext", ["伏笔速览"])).toBe("深夜的钟声");

    h.setSettings({ enabled: false });
    await h.service.kick();
    expect(h.registrar.registered.size).toBe(0);

    h.setSettings({ enabled: true });
    await h.service.kick();
    expect(h.invokeHandler("memoryContext", ["伏笔速览"])).toBe("深夜的钟声");
  });
});
