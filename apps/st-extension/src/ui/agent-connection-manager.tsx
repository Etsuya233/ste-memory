/**
 * Agent 连接管理器（ADR 0010 / spec .scratch/agent-connections）：设置 Tab
 * 的「Agent 连接」区块。
 *
 * 纯展示层：状态变更走 agent-connections 纯函数 → onChange(nextSettings)
 * （宿主写 settings）；「测试连接」经注入的 onTestConnection（宿主 =
 * st-backends-status 适配器，复用 ST 同源 /status 端点零 token 验证）。
 * 交互逻辑（CRUD/回退/规范化/排序）在 agent-connections 纯函数测试覆盖，
 * 组件只做「模型 → DOM」投影与事件接线。
 */
import { useState } from "react";
import type { PluginSettings } from "../settings/plugin-settings.ts";
import {
  AGENT_CONNECTION_TARGETS,
  agentConnectionSelection,
  removeAgentConnection,
  setAgentConnection,
  upsertAgentConnection,
  type AgentConnection,
  type AgentConnectionTarget,
} from "../settings/agent-connections.ts";
import type { ConnectionTestResult } from "../llm/st-backends-status.ts";

/** UI 层 id 工厂（新建连接时分配；浏览器环境，缺省随机） */
function createUiId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Agent 选择器「跟随 ST 当前连接」选项文案（缺省行为，旧版零变化） */
export const FOLLOW_ST_CONNECTION_LABEL = "跟随 ST 当前连接";

export function AgentConnectionManager(props: {
  readonly settings: PluginSettings;
  readonly onChange: (settings: PluginSettings) => void;
  readonly onTestConnection: (connection: AgentConnection) => Promise<ConnectionTestResult>;
}) {
  const { settings } = props;
  const [editing, setEditing] = useState<AgentConnection | null>(null);
  /** 最近一次成功「测试连接」拉到的模型列表（字典序，填充模型下拉） */
  const [models, setModels] = useState<readonly string[]>([]);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  async function runTest(draft: AgentConnection): Promise<void> {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await props.onTestConnection(draft);
      if (result.ok) {
        setModels(result.models);
        setTestResult({ ok: true, text: `连接成功，拉取到 ${result.models.length} 个模型` });
      } else {
        setTestResult({ ok: false, text: result.error });
      }
    } catch (error) {
      setTestResult({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  }

  function save(draft: AgentConnection): void {
    props.onChange(upsertAgentConnection(settings, draft));
    setEditing(null);
    setTestResult(null);
  }

  function remove(connectionId: string): void {
    const connection = settings.agentConnections.find((c) => c.id === connectionId);
    if (!connection) return;
    if (
      !window.confirm(
        `删除 Agent 连接「${connection.name}」？选中它的 Agent 将回退为「跟随 ST 当前连接」。`,
      )
    ) {
      return;
    }
    props.onChange(removeAgentConnection(settings, connectionId));
  }

  function startCreate(): void {
    setEditing({ id: createUiId(), name: "", baseUrl: "", apiKey: "", model: "" });
    setTestResult(null);
  }

  function startEdit(connection: AgentConnection): void {
    setEditing({ ...connection });
    setTestResult(null);
  }

  return (
    <div className="stm-setting-group" data-stm-field="agent-connections">
      <div className="stm-setting-group-title">Agent 连接</div>
      <div className="stm-setting-hint">
        为表格填写 Agent / 查询 Agent 指定独立模型服务（Base URL + API Key + 模型名）； 请求仍走 ST
        服务端转发，无 CORS。密钥以明文存于浏览器本地。未配置任何连接时 Agent 跟随 ST 当前连接。
      </div>
      <div className="stm-connection-list" data-stm-field="connection-list">
        {settings.agentConnections.length === 0 && (
          <div className="stm-setting-hint">
            还没有 Agent 连接——新建一个，或在下方保持「跟随 ST 当前连接」。
          </div>
        )}
        {settings.agentConnections.map((connection) => (
          <div className="stm-connection-row" data-stm-field="connection-row" key={connection.id}>
            <span className="stm-connection-name">{connection.name}</span>
            <span className="stm-connection-meta">
              {connection.baseUrl} · {connection.model}
            </span>
            <button
              className="stm-button"
              data-action="edit-connection"
              onClick={() => startEdit(connection)}
            >
              编辑
            </button>
            <button
              className="stm-button"
              data-action="delete-connection"
              onClick={() => remove(connection.id)}
            >
              删除
            </button>
          </div>
        ))}
      </div>
      <div className="stm-setting-actions">
        <button className="stm-button" data-action="create-connection" onClick={startCreate}>
          新建连接
        </button>
      </div>
      {editing && (
        <AgentConnectionForm
          draft={editing}
          models={models}
          testing={testing}
          testResult={testResult}
          onDraftChange={setEditing}
          onTest={() => void runTest(editing)}
          onSave={() => save(editing)}
          onCancel={() => setEditing(null)}
        />
      )}
      {/* 移动端优先：选择器纵向堆叠，每行一个（面板宽度有限，并排会挤压） */}
      <div className="stm-connection-selectors" data-stm-field="agent-selectors">
        {AGENT_CONNECTION_TARGETS.map((target) => (
          <ConnectionSelector
            key={target}
            target={target}
            settings={settings}
            onChange={props.onChange}
          />
        ))}
      </div>
    </div>
  );
}

/** 单个 Agent 的连接选择器：跟随 ST 当前连接（缺省）/ 各连接 */
function ConnectionSelector(props: {
  readonly target: AgentConnectionTarget;
  readonly settings: PluginSettings;
  readonly onChange: (settings: PluginSettings) => void;
}): React.JSX.Element {
  const { target, settings } = props;
  const selectedId = agentConnectionSelection(settings, target);
  return (
    <div className="stm-setting-row stm-connection-selector-row" data-stm-field="agent-connection-selector">
      <label className="stm-setting-label">
        {target === "fillTask" ? "表格填写 Agent" : "查询 Agent"}
      </label>
      <select
        className="stm-input"
        data-action="select-agent-connection"
        data-stm-target={target}
        value={selectedId ?? ""}
        onChange={(event) =>
          props.onChange(
            setAgentConnection(
              settings,
              target,
              event.target.value === "" ? undefined : event.target.value,
            ),
          )
        }
      >
        <option value="">{FOLLOW_ST_CONNECTION_LABEL}</option>
        {settings.agentConnections.map((connection) => (
          <option key={connection.id} value={connection.id}>
            {connection.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** 连接编辑表单（新建/编辑共用）：手写模型 + 右侧 Select 下拉（字典序，测试成功后填充） */
export function AgentConnectionForm(props: {
  readonly draft: AgentConnection;
  readonly models: readonly string[];
  readonly testing: boolean;
  readonly testResult: { ok: boolean; text: string } | null;
  readonly onDraftChange: (draft: AgentConnection) => void;
  readonly onTest: () => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const { draft, models } = props;
  const canSave =
    draft.name.trim() !== "" && draft.baseUrl.trim() !== "" && draft.model.trim() !== "";
  const canTest = draft.baseUrl.trim() !== "";
  return (
    <div className="stm-connection-form" data-stm-field="connection-form">
      <div className="stm-setting-row stm-connection-form-row">
        <label className="stm-setting-label">名称</label>
        <input
          className="stm-input"
          data-stm-field="connection-name"
          value={draft.name}
          placeholder="如：DeepSeek 主用"
          onChange={(event) => props.onDraftChange({ ...draft, name: event.target.value })}
        />
      </div>
      <div className="stm-setting-row stm-connection-form-row">
        <label className="stm-setting-label">Base URL</label>
        <input
          className="stm-input"
          data-stm-field="connection-base-url"
          value={draft.baseUrl}
          placeholder="如：https://api.deepseek.com/v1（无需带 /chat/completions）"
          onChange={(event) => props.onDraftChange({ ...draft, baseUrl: event.target.value })}
        />
      </div>
      <div className="stm-setting-row stm-connection-form-row">
        <label className="stm-setting-label">API Key</label>
        <input
          className="stm-input"
          type="password"
          data-stm-field="connection-api-key"
          value={draft.apiKey}
          placeholder="无鉴权本地服务可留空"
          onChange={(event) => props.onDraftChange({ ...draft, apiKey: event.target.value })}
        />
      </div>
      <div className="stm-setting-row stm-connection-form-row">
        <label className="stm-setting-label">模型</label>
        <div className="stm-connection-model-row">
          <input
            className="stm-input"
            data-stm-field="connection-model"
            value={draft.model}
            placeholder="手写模型名"
            onChange={(event) => props.onDraftChange({ ...draft, model: event.target.value })}
          />
          <select
            className="stm-input"
            data-stm-field="connection-model-select"
            value={draft.model}
            onChange={(event) => props.onDraftChange({ ...draft, model: event.target.value })}
          >
            <option value="">选择已拉取模型…</option>
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="stm-setting-actions">
        <button
          className="stm-button"
          data-action="test-connection"
          disabled={props.testing || !canTest}
          onClick={props.onTest}
        >
          {props.testing ? "测试中…" : "测试连接"}
        </button>
        <button
          className="stm-button"
          data-action="save-connection"
          disabled={!canSave}
          onClick={props.onSave}
        >
          保存
        </button>
        <button className="stm-button" data-action="cancel-connection" onClick={props.onCancel}>
          取消
        </button>
      </div>
      {props.testResult && (
        <div
          className={props.testResult.ok ? "stm-connection-test-ok" : "stm-connection-test-fail"}
          data-stm-field="connection-test-result"
        >
          {props.testResult.text}
        </div>
      )}
    </div>
  );
}
