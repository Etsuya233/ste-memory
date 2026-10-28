import { describe, expect, it, vi } from "vitest";
import type { MemorySpaceBackup } from "../backup/backup-file.ts";
import type { MemorySpaceId } from "../memory/index.ts";
import type { MemoryMacro } from "./macro-expression.ts";
import type { MemoryView } from "./memory-views.ts";
import { MemoryMacroService, type MemoryMacroExecutionContext } from "./memory-macro-service.ts";
import type { MacroEvaluationStatistics } from "./macro-evaluation.ts";
import { renderMacroResult } from "./macro-result-render.ts";

const definition = (name = "记忆"): MemoryMacro => ({
  id: name,
  name,
  enabled: true,
  expression: { language: "query", query: { table: "notes" } },
  output: { format: "text", maxChars: null },
});

function harness(timeoutMs = 1000) {
  let context = "chat-A";
  let local: readonly MemoryMacro[] = [];
  let legacy: readonly MemoryView[] = [];
  const settings = {
    enabled: true,
    macroName: "{{ste}}",
    macroLimit: 4000,
    macros: [definition()] as readonly MemoryMacro[],
  };
  const snapshot: MemorySpaceBackup = {
    space: {
      id: "space" as MemorySpaceId,
      name: "测试",
      initializationSource: null,
      createdAt: "2026-10-26",
      updatedAt: "2026-10-26",
    },
    tables: [],
    fields: [],
    records: [],
    history: [],
    evidence: [],
  };
  let handler: ((context: MemoryMacroExecutionContext) => string) | undefined;
  const evaluate = vi.fn(async () => ({ columns: ["内容"], rows: [["本次记忆"]], sources: [] }));
  const capture = vi.fn(async () => structuredClone(snapshot));
  const close = vi.fn(async () => {});
  const statistics = vi.fn((): MacroEvaluationStatistics => ({
    queryVectorScope: "batch",
    queryVectors: { requests: 0, executionHits: 0, sharedHits: 0 },
  }));
  const service = new MemoryMacroService({
    getContext: () => context,
    getChatMacros: () => local,
    saveChatMacros: async (macros) => {
      local = macros;
    },
    readLegacyChatMacros: () => legacy,
    writeLegacyChatMacros: (macros) => {
      legacy = macros;
    },
    readSettings: () => settings,
    capture,
    createBatch: async () => ({
      evaluate,
      close,
      validate: async () => false,
      statistics,
    }),
    registerMacro: {
      register: (_name, next) => {
        handler = next;
      },
      unregister: () => {
        handler = undefined;
      },
    },
    timeoutMs,
  });
  return {
    service,
    settings,
    evaluate,
    capture,
    close,
    statistics,
    setLocal: (value: readonly MemoryMacro[]) => {
      local = value;
    },
    setLegacy: (value: readonly MemoryView[]) => {
      legacy = value;
    },
    local: () => local,
    legacy: () => legacy,
    switchChat: () => {
      context = "chat-B";
      service.chatChanged();
    },
    expand: (name = "记忆") => handler?.({ unnamedArgs: [name] }),
  };
}

describe("生成时统一求值", () => {
  it.each(["full", "events"])("内置 %s 宏将单引用和多引用渲染为当前显示文本", async (name) => {
    const h = harness();
    const stamp = "2026-10-28T00:00:00.000Z";
    const table = {
      memorySpaceId: "space",
      enabled: true,
      description: "",
      prompt: "",
      position: 0,
      createdAt: stamp,
      updatedAt: stamp,
    };
    const field = {
      memorySpaceId: "space",
      required: false,
      enabled: true,
      position: 0,
      prompt: "",
      options: [],
      referenceTableId: null,
      maxChars: null,
      valuePattern: null,
      valuePatternMessage: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
    const record = {
      memorySpaceId: "space",
      fieldEvidence: {},
      source: { type: "manual" },
      revisionId: "revision",
      revisionSource: "user",
      createdAt: stamp,
      updatedAt: stamp,
    };
    const snapshot = {
      ...(await h.capture()),
      tables: [
        {
          ...table,
          id: "people",
          key: "people",
          name: "人物",
          displayStrategy: { type: "template", template: "{person-name}（{title}）" },
        },
        {
          ...table,
          id: "events",
          key: "events",
          name: "事件",
          displayStrategy: { type: "field", fieldId: "event-name" },
        },
      ],
      fields: [
        {
          ...field,
          id: "person-name",
          tableId: "people",
          key: "name",
          name: "姓名",
          type: "short_text",
        },
        {
          ...field,
          id: "title",
          tableId: "people",
          key: "title",
          name: "身份",
          type: "short_text",
        },
        {
          ...field,
          id: "event-name",
          tableId: "events",
          key: "name",
          name: "名称",
          type: "short_text",
        },
        {
          ...field,
          id: "owner",
          tableId: "events",
          key: "owner",
          name: "负责人",
          type: "single_reference",
          referenceTableId: "people",
        },
        {
          ...field,
          id: "cast",
          tableId: "events",
          key: "cast",
          name: "参与者",
          type: "multi_reference",
          referenceTableId: "people",
        },
        {
          ...field,
          id: "tags",
          tableId: "events",
          key: "tags",
          name: "标签",
          type: "short_text_list",
        },
      ],
      records: [
        {
          ...record,
          id: "person-1",
          tableId: "people",
          displayText: "旧名称一",
          payload: { "person-name": "林舟", title: "船长" },
        },
        {
          ...record,
          id: "person-2",
          tableId: "people",
          displayText: "旧名称二",
          payload: { "person-name": "苏月", title: "医师" },
        },
        {
          ...record,
          id: "event-1",
          tableId: "events",
          displayText: "出航",
          payload: {
            "event-name": "出航",
            owner: "person-1",
            cast: ["person-2", "person-1"],
            tags: ["person-1", "海上"],
          },
        },
        {
          ...record,
          id: "event-2",
          tableId: "events",
          displayText: "休整",
          payload: { "event-name": "休整", owner: null, cast: [], tags: [] },
        },
      ],
    } as unknown as MemorySpaceBackup;
    h.capture.mockResolvedValue(snapshot);
    await h.service.start();
    try {
      h.service.started("regenerate", {}, false);
      await h.service.afterCommands("regenerate", {}, false, "测试");
      expect(h.expand(name)).toContain(
        "| 出航 | 林舟（船长） | 苏月（医师）、林舟（船长） | person-1、海上 |",
      );
      expect(h.expand(name)).toContain("| 休整 |  |  |  |");
      expect(snapshot.records[2]!.payload.owner).toBe("person-1");
      expect(snapshot.records[2]!.payload.cast).toEqual(["person-2", "person-1"]);
    } finally {
      h.service.stop();
    }
  });

  it("保留超限前实际请求与准备轮数诊断，测试结果不覆盖真实结果", async () => {
    const h = harness();
    h.statistics.mockReturnValue({
      queryVectorScope: "batch",
      queryVectors: { requests: 4, executionHits: 1, sharedHits: 0 },
      sqlPasses: 5,
      preparedSources: 4,
      queryTexts: 4,
      sqlMs: 12,
    });
    h.evaluate.mockRejectedValue(new Error("不同查询文本超过 4 种"));
    await h.service.start();
    h.service.started("regenerate", {}, false);
    await h.service.afterCommands("regenerate", {}, false, "查询");
    const recent = h.service.getRecentResults();
    expect(recent.find((row) => row.name === "记忆")?.diagnostics).toEqual([
      { execution: h.statistics() },
    ]);
    const tested = await h.service.testMacro({
      macro: definition(),
      scope: "global",
      lastUserMessage: "查询",
    });
    expect(tested.error).toContain("超过 4 种");
    expect(tested.diagnostics).toEqual([{ execution: h.statistics() }]);
    expect(h.service.getRecentResults()).toBe(recent);
    h.service.stop();
  });

  it("会话关闭失败显式报告且不阻塞主生成", async () => {
    const h = harness();
    h.close.mockRejectedValueOnce(new Error("close RPC failed"));
    await h.service.start();
    h.service.started("regenerate", {}, false);
    await expect(h.service.afterCommands("regenerate", {}, false, "查询")).resolves.toBeUndefined();
    expect(h.expand()).toBe("");
    expect(h.service.getRecentResults().find((row) => row.name === "记忆")?.error).toContain(
      "close RPC failed",
    );
    h.service.stop();
  });
  it("注册保存与失效不查询，仅本次生成展开可见", async () => {
    const h = harness();
    await h.service.start();
    await h.service.kick();
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.expand()).toBe("");
    h.service.started("normal", {}, false);
    await h.service.afterCommands("normal", {}, false, "旧消息");
    expect(h.capture).not.toHaveBeenCalled();
    await h.service.messageSent({ isUser: true, content: "本次消息" });
    expect(h.evaluate).toHaveBeenCalledOnce();
    expect(h.expand()).toBe("本次记忆");
    expect(h.expand()).toBe("本次记忆");
    h.service.generationFinished(false);
    expect(h.expand()).toBe("");
    expect(h.service.getRecentResults().find((row) => row.name === "记忆")?.text).toBe("本次记忆");
    h.service.stop();
  });
  it("重生成与续写重新计算，独立dry run不计算", async () => {
    const h = harness();
    await h.service.start();
    h.service.started("normal", {}, true);
    await h.service.afterCommands("normal", {}, true, "测试");
    expect(h.evaluate).not.toHaveBeenCalled();
    for (const type of ["regenerate", "swipe", "continue"]) {
      h.service.started(type, {}, false);
      await h.service.afterCommands(type, {}, false, "测试");
      h.service.generationFinished(false);
    }
    expect(h.evaluate).toHaveBeenCalledTimes(3);
    h.service.stop();
  });
  it("同次工具递归不重复求值，测试超时也会释放且不污染真实结果", async () => {
    const h = harness(10);
    await h.service.start();
    h.service.started("regenerate", {}, false);
    await h.service.afterCommands("regenerate", {}, false, "本次");
    h.service.started("normal", { continuation: true }, false);
    await h.service.afterCommands("normal", {}, false, "本次");
    expect(h.evaluate).toHaveBeenCalledOnce();
    expect(h.expand()).toBe("本次记忆");
    let release!: (value: { columns: string[]; rows: string[][]; sources: never[] }) => void;
    h.evaluate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const before = h.service.getRecentResults();
    const result = await h.service.testMacro({
      macro: definition(),
      scope: "global",
      lastUserMessage: "独立测试",
    });
    expect(result.error).toContain("时限");
    expect(h.service.getRecentResults()).toBe(before);
    release({ columns: [], rows: [], sources: [] });
    h.service.stop();
  });
  it("群聊一个回复批次只算一次，下一批重新计算", async () => {
    const h = harness();
    await h.service.start();
    for (let group = 0; group < 2; group++) {
      h.service.groupStarted();
      for (let member = 0; member < 2; member++) {
        h.service.started("normal", { automatic_trigger: true }, false);
        await h.service.afterCommands("normal", { automatic_trigger: true }, false, "群聊消息");
        expect(h.expand()).toBe("本次记忆");
        h.service.generationFinished(false);
      }
      h.service.groupEnded();
    }
    expect(h.evaluate).toHaveBeenCalledTimes(2);
    h.service.stop();
  });
  it("停用对话宏遮蔽同名全局宏，其他宏继续", async () => {
    const h = harness();
    h.setLocal([{ ...definition(), enabled: false }, definition("另一个")]);
    await h.service.start();
    h.service.started("regenerate", {}, false);
    await h.service.afterCommands("regenerate", {}, false, "测试");
    expect(h.expand()).toBe("");
    expect(h.expand("另一个")).toBe("本次记忆");
    expect(h.evaluate).toHaveBeenCalledOnce();
    h.service.stop();
  });
  it("超时释放生成且迟到结果不能回填，切对话清空", async () => {
    const h = harness(10);
    let resolve!: (value: { columns: string[]; rows: string[][]; sources: never[] }) => void;
    h.evaluate.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await h.service.start();
    h.service.started("regenerate", {}, false);
    await h.service.afterCommands("regenerate", {}, false, "测试");
    expect(h.expand()).toBe("");
    expect(h.service.getRecentResults().find((row) => row.name === "记忆")?.error).toContain(
      "超过",
    );
    resolve({ columns: ["内容"], rows: [["迟到内容"]], sources: [] });
    await new Promise((done) => setTimeout(done, 0));
    expect(h.expand()).toBe("");
    h.switchChat();
    expect(h.service.getRecentResults()).toEqual([]);
    h.service.stop();
  });
  it("测试不覆盖真实结果，旧宏冲突仅阻止该名称并可改名迁入", async () => {
    const h = harness();
    h.setLocal([definition()]);
    h.setLegacy([{ name: "记忆", tableKey: "notes", condition: null, limit: 5, projection: [] }]);
    await h.service.start();
    await h.service.migrateLegacyChatMacros();
    expect(h.service.getMigrationConflicts()).toHaveLength(1);
    h.service.started("regenerate", {}, false);
    await h.service.afterCommands("regenerate", {}, false, "测试");
    expect(h.expand()).toBe("");
    const before = h.service.getRecentResults();
    const tested = await h.service.testMacro({
      macro: definition(),
      scope: "chat",
      lastUserMessage: "测试",
    });
    expect(tested.text).toBe("本次记忆");
    expect(h.service.getRecentResults()).toBe(before);
    await h.service.resolveMigrationConflict("记忆", { kind: "rename", name: "旧记忆" });
    expect(h.local().map((macro) => macro.name)).toEqual(["记忆", "旧记忆"]);
    expect(h.legacy()).toEqual([]);
    h.service.stop();
  });
});

it("JSON预算按完整行输出，保持有效JSON", () => {
  const macro = { ...definition(), output: { format: "json" as const, maxChars: 120 } };
  const rendered = renderMacroResult(
    macro,
    { columns: ["内容"], rows: [["a".repeat(30)], ["b".repeat(30)], ["c".repeat(30)]] },
    4000,
  );
  expect(JSON.parse(rendered.text)).toMatchObject({ omitted: true });
  expect(rendered.text.length).toBeLessThanOrEqual(120);
  expect(rendered.outputRows).toBeGreaterThan(0);
  expect(() =>
    renderMacroResult(
      { ...macro, output: { ...macro.output, maxChars: 2 } },
      { columns: ["内容"], rows: [["内容太长"]] },
      4000,
    ),
  ).toThrow("预算不足");
});

it("旧投影保留单字段标签、布尔、列表和单行化文本", () => {
  const macro = {
    ...definition(),
    legacyRendering: true,
    expression: { language: "query" as const, query: { table: "notes", fields: ["flag"] } },
  };
  expect(renderMacroResult(macro, { columns: ["有效"], rows: [[true], [false]] }, 4000).text).toBe(
    "有效：是\n有效：否",
  );
  const projected = {
    ...macro,
    expression: {
      language: "query" as const,
      query: { table: "notes", fields: ["names", "note"] },
    },
  };
  expect(
    renderMacroResult(
      projected,
      { columns: ["人物", "说明"], rows: [[["张三", "李四"], "第一行\n第二行"]] },
      4000,
    ).text,
  ).toBe("人物：张三、李四，说明：第一行 第二行");
});
