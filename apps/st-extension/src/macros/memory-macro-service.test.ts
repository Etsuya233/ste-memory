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

    expect([...h.registrar.registered.keys()]).toContain("memoryContext");
    expect([...h.registrar.registered.keys()]).toContain("memoryFull");
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
    expect([...h.registrar.registered.keys()]).toContain("memoryContext");
    expect([...h.registrar.registered.keys()]).toContain("memoryFull");
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

  it("注册携带可选视图名参数声明（unnamedArgs viewName）", async () => {
    const h = createHarness();
    await h.service.start();
    expect(h.registrar.registeredArgs.get("memoryContext")).toEqual([
      { name: "viewName", optional: true, defaultValue: "" },
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
    expect(h.warns.some((w) => w.includes("空视图名"))).toBe(true);
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
    expect(h.warns.some((w) => w.includes("未知视图"))).toBe(true);
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
