import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeAgentConnections } from "./plugin-settings.ts";
import {
  buildStatusTestRequest,
  connectionHeaderError,
  connectionUpstreamHeaders,
  normalizeBaseUrl,
  removeAgentConnection,
  resolveAgentConnection,
  setAgentConnection,
  sortModelIds,
  upsertAgentConnection,
  type AgentConnection,
} from "./agent-connections.ts";
import type { PluginSettings } from "./plugin-settings.ts";

function connection(overrides: Partial<AgentConnection> = {}): AgentConnection {
  return {
    id: "c1",
    name: "DeepSeek 主用",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-abc",
    model: "deepseek-chat",
    ...overrides,
  };
}

function settings(overrides: Partial<PluginSettings> = {}): PluginSettings {
  return {
    ...DEFAULT_SETTINGS,
    agentConnections: [connection()],
    ...overrides,
  };
}

describe("upsertAgentConnection（新建/按 id 覆盖）", () => {
  it("新 id：追加到列表末尾", () => {
    const next = upsertAgentConnection(settings(), connection({ id: "c2", name: "本地" }));
    expect(next.agentConnections.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("已存在 id：原地替换（顺序不变）", () => {
    const next = upsertAgentConnection(settings(), connection({ id: "c1", apiKey: "sk-new" }));
    expect(next.agentConnections).toHaveLength(1);
    expect(next.agentConnections[0]!.apiKey).toBe("sk-new");
    expect(next.agentConnections[0]!.name).toBe("DeepSeek 主用");
  });

  it("settings 不可变更新：原对象不被修改", () => {
    const before = settings();
    upsertAgentConnection(before, connection({ id: "c2" }));
    expect(before.agentConnections.map((c) => c.id)).toEqual(["c1"]);
  });
});

describe("removeAgentConnection（删除 + 悬空选中回退）", () => {
  it("删除连接：列表移除，其余连接保留", () => {
    const next = removeAgentConnection(settings(), "c1");
    expect(next.agentConnections).toEqual([]);
  });

  it("被删连接正被某 Agent 选中：该 Agent 回退跟随 ST（undefined）", () => {
    const next = removeAgentConnection(
      settings({ fillTaskConnectionId: "c1", queryChatConnectionId: "c1" }),
      "c1",
    );
    expect(next.fillTaskConnectionId).toBeUndefined();
    expect(next.queryChatConnectionId).toBeUndefined();
  });

  it("被删连接未被选中：其他 Agent 的选择不受影响", () => {
    const next = removeAgentConnection(settings({ queryChatConnectionId: "c1" }), "c1");
    expect(next.queryChatConnectionId).toBeUndefined();
    const withOther = removeAgentConnection(
      settings({ fillTaskConnectionId: "c1", queryChatConnectionId: "other" }),
      "c1",
    );
    expect(withOther.queryChatConnectionId).toBe("other");
  });

  it("未知 id：原样返回", () => {
    const before = settings({ fillTaskConnectionId: "c1" });
    const next = removeAgentConnection(before, "nope");
    expect(next).toEqual(before);
  });
});

describe("setAgentConnection（Agent 选择连接 / 回退跟随 ST）", () => {
  it("有效 id：写入对应 Agent 选择", () => {
    const next = setAgentConnection(settings(), "queryChat", "c1");
    expect(next.queryChatConnectionId).toBe("c1");
    expect(next.fillTaskConnectionId).toBeUndefined();
  });

  it("undefined：清除选择（回退跟随 ST 当前连接）", () => {
    const next = setAgentConnection(
      settings({ queryChatConnectionId: "c1" }),
      "queryChat",
      undefined,
    );
    expect(next.queryChatConnectionId).toBeUndefined();
  });

  it("未知 id：原样返回（不产生悬空引用）", () => {
    const before = settings();
    expect(setAgentConnection(before, "fillTask", "nope")).toEqual(before);
  });
});

describe("resolveAgentConnection（运行时分流读取）", () => {
  it("选中有效连接：返回连接", () => {
    expect(resolveAgentConnection(settings({ fillTaskConnectionId: "c1" }), "fillTask")).toEqual(
      connection(),
    );
  });

  it("未选择（undefined）：返回 undefined（跟随 ST 当前连接）", () => {
    expect(resolveAgentConnection(settings(), "fillTask")).toBeUndefined();
    expect(resolveAgentConnection(settings(), "queryChat")).toBeUndefined();
  });

  it("选择指向不存在的 id：返回 undefined（防御悬空数据）", () => {
    expect(
      resolveAgentConnection(settings({ fillTaskConnectionId: "gone" }), "fillTask"),
    ).toBeUndefined();
  });

  it("两个 Agent 的选择互不影响", () => {
    const s = settings({ fillTaskConnectionId: "c1", queryChatConnectionId: "c1" });
    expect(resolveAgentConnection(s, "fillTask")).toBeDefined();
    expect(resolveAgentConnection(s, "queryChat")).toBeDefined();
  });
});

describe("normalizeBaseUrl（发送前规范化，防双拼 /chat/completions）", () => {
  it("普通 base 原样保留", () => {
    expect(normalizeBaseUrl("https://api.deepseek.com/v1")).toBe("https://api.deepseek.com/v1");
  });

  it("尾部斜杠剥除", () => {
    expect(normalizeBaseUrl("https://api.deepseek.com/v1/")).toBe("https://api.deepseek.com/v1");
    expect(normalizeBaseUrl("https://api.deepseek.com/v1///")).toBe("https://api.deepseek.com/v1");
  });

  it("尾部 /chat/completions 剥除（用户粘贴完整地址不双拼）", () => {
    expect(normalizeBaseUrl("https://api.deepseek.com/v1/chat/completions")).toBe(
      "https://api.deepseek.com/v1",
    );
    expect(normalizeBaseUrl("https://api.deepseek.com/v1/chat/completions/")).toBe(
      "https://api.deepseek.com/v1",
    );
  });

  it("空白修剪", () => {
    expect(normalizeBaseUrl("  https://api.deepseek.com/v1  ")).toBe("https://api.deepseek.com/v1");
  });
});

describe("sortModelIds（模型列表字典序）", () => {
  it("乱序输入 → 字典序输出", () => {
    expect(sortModelIds(["gpt-4o", "deepseek-chat", "claude-3", "gpt-4o-mini"])).toEqual([
      "claude-3",
      "deepseek-chat",
      "gpt-4o",
      "gpt-4o-mini",
    ]);
  });

  it("空列表原样返回", () => {
    expect(sortModelIds([])).toEqual([]);
  });

  it("不修改输入数组", () => {
    const input = ["b", "a"];
    sortModelIds(input);
    expect(input).toEqual(["b", "a"]);
  });
});

describe("buildStatusTestRequest（测试连接请求体）", () => {
  it("连接测试使用当前连接的请求头，Authorization 按大小写不敏感覆盖", () => {
    const body = buildStatusTestRequest(
      connection({ customHeaders: { authorization: "Basic abc", "X-Tenant": "a", "X-Empty": "" } }),
    );
    expect(JSON.parse(body.custom_include_headers)).toEqual({
      Authorization: "Basic abc",
      "X-Tenant": "a",
      "X-Empty": "",
    });
    expect(JSON.parse(buildStatusTestRequest(connection()).custom_include_headers)).toEqual({
      Authorization: "Bearer sk-abc",
    });
  });

  it("持久化读取保留各连接的独立请求头，并兼容旧连接", () => {
    const connections = [
      connection({ customHeaders: { "X-Tenant": "a" } }),
      connection({ id: "c2", customHeaders: { "X-Tenant": "b" } }),
      connection({ id: "old" }),
    ];
    expect(mergeAgentConnections(JSON.parse(JSON.stringify(connections)))).toEqual(connections);
  });

  it.each([
    [
      [
        ["X-Tenant", "a"],
        ["x-tenant", "b"],
      ],
      "重复",
    ],
    [[["X Bad", "a"]], "名称不合法"],
    [[["Content-TYPE", "text/plain"]], "Content-Type"],
    [[["X-Key", "a\r\nb"]], "换行"],
  ] as const)("非法请求头在发送前报错：%j", (entries, message) => {
    expect(connectionHeaderError(entries)).toContain(message);
    const customHeaders = Object.fromEntries(entries);
    expect(() => connectionUpstreamHeaders(connection({ customHeaders }))).toThrow(message);
    expect(() => upsertAgentConnection(DEFAULT_SETTINGS, connection({ customHeaders }))).toThrow(
      message,
    );
    expect(() => mergeAgentConnections([connection({ customHeaders })])).toThrow(message);
  });

  it("custom_url 使用规范化 URL，请求头携带连接 Key", () => {
    const body = buildStatusTestRequest(
      connection({ baseUrl: "https://api.deepseek.com/v1/chat/completions/", apiKey: "sk-1" }),
    );
    expect(body).toEqual({
      chat_completion_source: "custom",
      custom_url: "https://api.deepseek.com/v1",
      custom_include_headers: JSON.stringify({ Authorization: "Bearer sk-1" }),
    });
  });

  it("无 Key 连接：显式空 Authorization 隔离宿主凭据", () => {
    const body = buildStatusTestRequest(connection({ apiKey: "" }));
    expect(JSON.parse(body.custom_include_headers)).toEqual({ Authorization: "" });
  });
});
