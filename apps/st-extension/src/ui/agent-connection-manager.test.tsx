/**
 * Agent API 连接管理器冒烟测试（react-dom/server renderToString，无 jsdom）：
 * 验证渲染契约（data-action / data-stm-field）与关键态（连接列表行、密钥状态
 * chip、Agent 选择器选中值、编辑表单）。交互逻辑在 agent-connections 测试覆盖。
 */
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PluginSettings } from "../settings/plugin-settings.ts";
import type { AgentConnection } from "../settings/agent-connections.ts";
import type { ConnectionTestResult } from "../llm/st-backends-status.ts";
import {
  AgentConnectionForm,
  AgentConnectionManager,
  FOLLOW_ST_CONNECTION_LABEL,
  maskApiKey,
} from "./agent-connection-manager.tsx";

function connection(overrides: Partial<AgentConnection> = {}): AgentConnection {
  return {
    id: "c1",
    name: "DeepSeek 主用",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-1",
    model: "deepseek-chat",
    ...overrides,
  };
}

function settings(overrides: Partial<PluginSettings> = {}): PluginSettings {
  return {
    enabled: true,
    r2: { accountId: "", accessKeyId: "", secretAccessKey: "", bucket: "" },
    macroName: "{{memoryContext}}",
    macroLimit: 2000,
    mirror: { enabled: true, includeHistory: true },
    agentPresets: { presets: [], activePresetId: "systemDefault" },
    agentConnections: [
      connection(),
      connection({ id: "c2", name: "本地", apiKey: "", model: "qwen" }),
    ],
    ...overrides,
  };
}

const noopTest = async (): Promise<ConnectionTestResult> => ({ ok: true, models: [] });

describe("AgentConnectionManager（连接管理区块冒烟）", () => {
  it("标题 + 明文存储提示 + 连接列表（名称/URL/模型/密钥掩码 chip）就位", () => {
    const html = renderToString(
      <AgentConnectionManager
        settings={settings()}
        onChange={() => undefined}
        onTestConnection={noopTest}
      />,
    );
    expect(html).toContain("Agent 连接");
    expect(html).toContain("明文存于浏览器本地");
    expect(html).toContain('data-stm-field="connection-list"');
    expect(html).toContain("DeepSeek 主用");
    // renderToString 在 JSX 文本节点间插 <!-- -->，URL 与模型分开断言
    expect(html).toContain("https://api.deepseek.com/v1");
    expect(html).toContain("deepseek-chat");
    // 密钥掩码展示（sk-1 长度 ≤4 → 全掩）；无密钥连接标「无密钥」
    expect(html).toContain("密钥 ••••");
    expect(html).toContain("无密钥");
  });

  it("连接行操作按钮 + 新建按钮就位（edit/delete/create action）", () => {
    const html = renderToString(
      <AgentConnectionManager
        settings={settings()}
        onChange={() => undefined}
        onTestConnection={noopTest}
      />,
    );
    expect(html).toContain('data-action="edit-connection"');
    expect(html).toContain('data-action="delete-connection"');
    expect(html).toContain('data-action="create-connection"');
  });

  it("空池：提示先新建连接；无连接行", () => {
    const html = renderToString(
      <AgentConnectionManager
        settings={settings({ agentConnections: [] })}
        onChange={() => undefined}
        onTestConnection={noopTest}
      />,
    );
    expect(html).toContain("还没有 Agent 连接");
    expect(html).not.toContain('data-stm-field="connection-row"');
  });

  it("Agent 选择器：跟随 ST 当前连接为缺省选项，选中值反映设置", () => {
    const html = renderToString(
      <AgentConnectionManager
        settings={settings({ fillTaskConnectionId: "c1", queryChatConnectionId: "c2" })}
        onChange={() => undefined}
        onTestConnection={noopTest}
      />,
    );
    // 两个选择器各就位
    const selectors = html.match(/data-action="select-agent-connection"/g);
    expect(selectors).toHaveLength(2);
    expect(html).toContain(FOLLOW_ST_CONNECTION_LABEL);
    expect(html).toContain("DeepSeek 主用");
    expect(html).toContain("本地");
    // 选中值反映设置：React 在选中 option 上渲染 selected（value 取 option 的 value）
    const fillTask = html.match(/data-stm-target="fillTask"[\s\S]*?<\/select>/)?.[0] ?? "";
    const queryChat = html.match(/data-stm-target="queryChat"[\s\S]*?<\/select>/)?.[0] ?? "";
    expect(fillTask).toContain('<option value="c1" selected="">');
    expect(queryChat).toContain('<option value="c2" selected="">');
    // 未选中的 Agent 保持缺省跟随 ST
    expect(fillTask).toContain("跟随 ST 当前连接");
  });
});

describe("maskApiKey（密钥掩码展示）", () => {
  it("长度 >4：掩码 + 末 4 位", () => {
    expect(maskApiKey("sk-abcdef1234")).toBe("••••1234");
  });

  it("长度 ≤4：全掩", () => {
    expect(maskApiKey("sk-1")).toBe("••••");
    expect(maskApiKey("")).toBe("••••");
  });
});

describe("AgentConnectionForm（编辑表单冒烟）", () => {
  function renderForm(draft: AgentConnection, models: readonly string[] = []): string {
    return renderToString(
      <AgentConnectionForm
        draft={draft}
        models={models}
        testing={false}
        testResult={null}
        onDraftChange={() => undefined}
        onTest={() => undefined}
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );
  }

  it("字段就位：名称/Base URL/API Key（password）/模型手写 + 右侧 Select", () => {
    const html = renderForm(connection());
    expect(html).toContain('data-stm-field="connection-name"');
    expect(html).toContain('data-stm-field="connection-base-url"');
    expect(html).toContain('data-stm-field="connection-api-key"');
    expect(html).toContain('type="password"');
    expect(html).toContain('data-stm-field="connection-model"');
    expect(html).toContain('data-stm-field="connection-model-select"');
  });

  it("模型下拉含已拉取模型（字典序由纯函数保证，此处只验证渲染）", () => {
    const html = renderForm(connection(), ["deepseek-chat", "gpt-4o"]);
    expect(html).toContain("deepseek-chat");
    expect(html).toContain("gpt-4o");
  });

  it("必填未填全：保存按钮禁用；Base URL 为空：测试按钮禁用", () => {
    const empty = renderForm(connection({ name: "", baseUrl: "", model: "" }));
    expect(empty).toContain('data-action="save-connection" disabled=""');
    expect(empty).toContain('data-action="test-connection" disabled=""');
    // Base URL 已填但模型未填：可测试不可保存
    const partial = renderForm(connection({ model: "" }));
    expect(partial).toContain('data-action="save-connection" disabled=""');
    expect(partial).not.toContain('data-action="test-connection" disabled=""');
    // 全部必填：两者都可用
    const full = renderForm(connection());
    expect(full).not.toContain('data-action="save-connection" disabled=""');
    expect(full).not.toContain('data-action="test-connection" disabled=""');
  });

  it("测试结果展示区就位（成功/失败文案）", () => {
    const okHtml = renderToString(
      <AgentConnectionForm
        draft={connection()}
        models={[]}
        testing={false}
        testResult={{ ok: true, text: "连接成功，拉取到 3 个模型" }}
        onDraftChange={() => undefined}
        onTest={() => undefined}
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(okHtml).toContain("连接成功，拉取到 3 个模型");
    expect(okHtml).toContain("stm-connection-test-ok");
    const failHtml = renderToString(
      <AgentConnectionForm
        draft={connection()}
        models={[]}
        testing={false}
        testResult={{ ok: false, text: "Agent 连接 [DeepSeek 主用]：连接测试失败（401）" }}
        onDraftChange={() => undefined}
        onTest={() => undefined}
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(failHtml).toContain("stm-connection-test-fail");
    expect(failHtml).toContain("401");
  });
});
