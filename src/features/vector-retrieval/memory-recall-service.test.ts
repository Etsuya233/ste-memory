import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RECALL_CONFIGURATION,
  MemoryRecallService,
  renderRecall,
} from "./memory-recall-service.ts";
import type { RetrievalHit, VectorRetrievalService } from "./vector-retrieval-service.ts";
import type { MemorySpaceId, MemorySpaceReader } from "../memory/index.ts";
import type { MemoryView } from "../macros/memory-views.ts";

const space = "space" as MemorySpaceId;
const view: MemoryView = {
  name: "active",
  tableKey: "events",
  condition: null,
  limit: 1,
  projection: [],
};
function setup() {
  let context = "chat-a:0";
  let isGroup = false;
  let content = " 新消息 ";
  let views = [view];
  let retrievalState = {
    status: "done",
    dataVersion: 0,
    result: { hits: [] as RetrievalHit[], message: "没有符合筛选条件的记录" },
  };
  let notifyRetrieval = () => {};
  const queryRecords = vi.fn(async (_id: unknown, input: { paging: { page: number } }) => ({
    records: [{ id: `r${input.paging.page}` }],
    totalPages: 2,
  }));
  const retrieval = {
    subscribe: vi.fn((listener: () => void) => {
      notifyRetrieval = listener;
    }),
    getState: () => retrievalState,
    cancel: vi.fn(),
    search: vi.fn(async () => {}),
    ranges: vi.fn(async () => []),
  };
  const service = new MemoryRecallService({
    retrieval: retrieval as unknown as VectorRetrievalService,
    reader: {
      getSpace: async () => undefined,
      listTables: async () => [{ id: "table", key: "events", name: "事件", enabled: true }],
      listFields: async () => [],
      queryRecords,
    } as unknown as MemorySpaceReader,
    context: () => context,
    spaceId: () => space,
    readConfiguration: () => ({
      ...DEFAULT_RECALL_CONFIGURATION,
      enabled: true,
      spaceId: space,
      bindings: [{ scope: "global", name: "active", tableKey: "events", groupIds: ["g"] }],
    }),
    writeConfiguration: vi.fn(),
    views: (scope) => (scope === "global" ? views : []),
    enabled: () => true,
    source: () => ({ content, isUser: true }),
    lastUser: () => 2,
    isGroup: () => isGroup,
    stopGeneration: vi.fn(),
  });
  return {
    service,
    retrieval,
    queryRecords,
    setGroup: () => {
      isGroup = true;
    },
    setContext: (value: string) => {
      context = value;
    },
    setContent: (value: string) => {
      content = value;
    },
    setViews: (value: MemoryView[]) => {
      views = value;
    },
    setResult: (hits: RetrievalHit[]) => {
      retrievalState = { ...retrievalState, status: "done", result: { hits, message: "搜索完成" } };
    },
    memoryChanged: () => {
      retrievalState = {
        ...retrievalState,
        status: "idle",
        dataVersion: retrievalState.dataVersion + 1,
      };
      notifyRetrieval();
    },
  };
}
const hit = (input: string, id = "record"): RetrievalHit =>
  ({
    target: { table: { name: "事件", key: "events" }, record: { id }, groupName: "正文", input },
  }) as RetrievalHit;
afterEach(() => vi.useRealTimers());

describe("automatic recall", () => {
  it("a background dry run between real start and MESSAGE_SENT cannot consume the real send", async () => {
    const { service, retrieval, setResult } = setup();
    setResult([hit("真实发送记忆")]);
    service.started("normal", {}, false);
    service.started("normal", {}, true);
    expect(service.getMacroText()).toBe("");
    service.generationFinished(true);
    await service.messageSent(2);
    expect(retrieval.search).toHaveBeenCalledTimes(1);
    expect(service.getMacroText()).toContain("真实发送记忆");
  });
  it("a saved real message also proceeds if an overlapping dry run has not finished", async () => {
    const { service, retrieval, setResult } = setup();
    setResult([hit("本轮真实内容")]);
    service.started("normal", {}, false);
    service.started("normal", {}, true);
    await service.messageSent(2);
    expect(retrieval.search).toHaveBeenCalledTimes(1);
    expect(service.getMacroText()).toContain("本轮真实内容");
  });
  it("dry runs during retrieval do not hide the text needed by the real prompt", async () => {
    const { service, retrieval, setResult } = setup();
    let complete!: () => void;
    retrieval.search.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    service.started("normal", {}, false);
    const waiting = service.messageSent(2);
    await vi.waitFor(() => expect(retrieval.search).toHaveBeenCalled());
    service.started("normal", {}, true);
    setResult([hit("真实提示词必须可见")]);
    complete();
    await waiting;
    expect(service.getMacroText()).toContain("真实提示词必须可见");
    service.generationFinished(true);
    expect(service.getMacroText()).toContain("真实提示词必须可见");
    service.generationFinished();
    service.started("normal", {}, true);
    expect(service.getMacroText()).toBe("");
    expect(retrieval.search).toHaveBeenCalledTimes(1);
  });
  it("memory changes during local view paging release preparation before search starts", async () => {
    const { service, retrieval, queryRecords, memoryChanged } = setup();
    queryRecords.mockImplementation(() => new Promise(() => {}));
    service.started("normal", {}, false);
    const waiting = service.messageSent(2);
    await vi.waitFor(() => expect(queryRecords).toHaveBeenCalled());
    memoryChanged();
    await waiting;
    expect(service.getState().status).toBe("stale");
    expect(retrieval.search).not.toHaveBeenCalled();
    expect(service.getMacroText()).toBe("");
  });
  it("group outer sends do not query until a real member is drafted and members share the snapshot", async () => {
    const { service, retrieval, setGroup, setResult } = setup();
    setGroup();
    setResult([hit("群聊记忆")]);
    service.started("normal", {}, false);
    await service.messageSent(2);
    expect(retrieval.search).not.toHaveBeenCalled();
    service.groupStarted();
    service.started("normal", {}, false);
    await service.messageSent(2);
    service.generationFinished();
    service.started("normal", {}, false);
    expect(service.getMacroText()).toContain("群聊记忆");
    expect(retrieval.search).toHaveBeenCalledTimes(1);
  });
  it("a failed new send never reuses the previous successful turn", async () => {
    const { service, retrieval, setResult, setContent } = setup();
    setResult([hit("旧轮记忆")]);
    service.started("normal", {}, false);
    await service.messageSent(2);
    setContent("新一轮消息");
    retrieval.search.mockRejectedValueOnce(new Error("网络错误"));
    service.started("normal", {}, false);
    expect(service.getMacroText()).toBe("");
    await service.messageSent(2);
    service.started("regenerate", {}, false);
    expect(service.getMacroText()).toBe("");
    expect(service.getState().message).toContain("网络错误");
  });
  it("tool continuations preserve the prepared turn without additional embeddings", async () => {
    const { service, retrieval, setResult } = setup();
    setResult([hit("工具轮记忆")]);
    service.started("normal", {}, false);
    await service.messageSent(2);
    service.started("normal", { continuation: true }, false);
    await service.messageSent(2);
    expect(service.getMacroText()).toContain("工具轮记忆");
    expect(retrieval.search).toHaveBeenCalledTimes(1);
  });
  it("A to B to A epochs and view edits cannot publish delayed results", async () => {
    const { service, retrieval, setResult, setContext, setViews } = setup();
    let complete!: () => void;
    retrieval.search.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    service.started("normal", {}, false);
    const wait = service.messageSent(2);
    await vi.waitFor(() => expect(retrieval.search).toHaveBeenCalled());
    setContext("chat-b:1");
    service.chatChanged();
    setContext("chat-a:2");
    service.syncContext();
    setViews([{ ...view, condition: { fieldKey: "status", values: ["open"] } }]);
    setResult([hit("旧轮迟到")]);
    complete();
    await wait;
    expect(service.getMacroText()).toBe("");
    expect(service.getState().text).toBe("");
  });
  it("fully pages views, ignores display limit and only queries once per send", async () => {
    const { service, retrieval, queryRecords } = setup();
    service.started("normal", {}, false);
    await service.messageSent(2);
    await service.messageSent(2);
    expect(queryRecords).toHaveBeenCalledTimes(2);
    expect(retrieval.search).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        query: "新消息",
        selection: [{ tableId: "table", groupIds: ["g"], recordIds: ["r1", "r2"] }],
      }),
    );
  });
  it("reuses the same snapshot for regen, swipe, continue and ignores assistant edits", async () => {
    const { service, retrieval, setResult, setContent } = setup();
    setResult([hit("本轮记忆")]);
    service.started("normal", {}, false);
    await service.messageSent(2);
    for (const type of ["regenerate", "swipe", "continue"]) {
      service.started(type, {}, false);
      service.sourceChanged();
      expect(service.getMacroText()).toContain("本轮记忆");
    }
    expect(retrieval.search).toHaveBeenCalledTimes(1);
    setContent("用户消息已编辑");
    service.sourceChanged();
    expect(service.getMacroText()).toBe("");
  });
  it("excludes dry run and quiet without consuming normal snapshot", async () => {
    const { service, setResult, retrieval } = setup();
    setResult([hit("已准备")]);
    service.started("normal", {}, false);
    await service.messageSent(2);
    service.generationFinished();
    service.started("normal", {}, true);
    expect(service.getMacroText()).toBe("");
    service.generationFinished();
    expect(service.getMacroText()).toContain("已准备");
    service.started("quiet", {}, false);
    await service.messageSent(2);
    expect(retrieval.search).toHaveBeenCalledTimes(1);
  });
  it("releases the ten second budget even when local work never resolves", async () => {
    vi.useFakeTimers();
    const { service, queryRecords, retrieval } = setup();
    queryRecords.mockImplementation(() => new Promise(() => {}));
    service.started("normal", {}, false);
    const wait = service.messageSent(2);
    await vi.advanceTimersByTimeAsync(10_000);
    await wait;
    expect(service.getState().message).toContain("10 秒");
    expect(service.getMacroText()).toBe("");
    expect(retrieval.search).not.toHaveBeenCalled();
  });
  it("releases skip immediately and never publishes a delayed old result", async () => {
    const { service, retrieval, setResult } = setup();
    let complete!: () => void;
    retrieval.search.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    service.started("normal", {}, false);
    const wait = service.messageSent(2);
    await vi.waitFor(() => expect(retrieval.search).toHaveBeenCalled());
    service.skip();
    await wait;
    setResult([hit("迟到旧结果")]);
    complete();
    await Promise.resolve();
    expect(service.getMacroText()).toBe("");
    expect(service.getState().status).toBe("skipped");
  });
  it("rejects deleted scoped views without silently choosing another scope", async () => {
    const { service, retrieval, setViews } = setup();
    setViews([]);
    service.started("normal", {}, false);
    await service.messageSent(2);
    expect(retrieval.search).not.toHaveBeenCalled();
    expect(service.getState().message).toContain("global/active");
  });
  it("honors whole record order and includes source and truncation in the character budget", () => {
    const rendered = renderRecall([hit("{{nested}}" + "长".repeat(900))], 500);
    expect(rendered.text.length).toBe(500);
    expect(rendered.text).toContain("正文已截断");
    expect(rendered.text).not.toContain("{{");
    const first = renderRecall(
      [hit("短"), hit("长".repeat(900), "second"), hit("短", "third")],
      500,
    );
    expect(first.count).toBe(1);
    expect(first.text).not.toContain("third");
  });
});
