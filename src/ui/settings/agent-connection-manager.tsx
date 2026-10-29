import { Button, Input, Select } from "../kit/controls.tsx";
import { ListGroup, NavigationRow } from "../kit/list.tsx";
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
import { useEffect, useId, useRef, useState } from "react";
import { PageChrome } from "../shell/page-layout.tsx";
import { PanelBar, PanelBarAction } from "../shell/panel-bar.tsx";
import { useSettingsPageNavigation } from "./settings-page-navigation.ts";
import { reportError } from "../shell/ui-helpers.tsx";
import { Disclosure } from "../shell/disclosure.tsx";
import type { PluginSettings } from "../../features/settings/plugin-settings.ts";
import {
  AGENT_CONNECTION_TARGETS,
  agentConnectionSelection,
  connectionHeaderError,
  removeAgentConnection,
  setAgentConnection,
  upsertAgentConnection,
  type AgentConnection,
  type AgentConnectionTarget,
} from "../../features/settings/agent-connections.ts";
import type { ConnectionTestResult } from "../../infrastructure/sillytavern/llm/st-backends-status.ts";
import {
  createConnectionDraft,
  connectionFromDraft,
  type AgentConnectionDraft,
} from "./agent-connection-draft.ts";

/** UI 层 id 工厂（新建连接时分配；浏览器环境，缺省随机） */
function createUiId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Agent 选择器「跟随 ST 当前连接」选项文案（缺省行为，旧版零变化） */
export const FOLLOW_ST_CONNECTION_LABEL = "跟随 ST 当前连接";

export function AgentConnectionManager(props: {
  readonly onBack?: () => void;
  readonly onEditingChange?: (editing: boolean) => void;
  readonly registerLeaveGuard?: (guard: (() => boolean) | null) => void;
  readonly settings: PluginSettings;
  readonly onChange: (settings: PluginSettings) => void;
  readonly onTestConnection: (connection: AgentConnection) => Promise<ConnectionTestResult>;
}) {
  const { settings } = props;
  const [editing, setEditing] = useState<AgentConnectionDraft | null>(null);
  /** 最近一次成功「测试连接」拉到的模型列表（字典序，填充模型下拉） */
  const [models, setModels] = useState<readonly string[]>([]);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const initialDraft = useRef<AgentConnectionDraft | null>(null);
  const { screenRef, rememberScroll } = useSettingsPageNavigation(
    editing
      ? settings.agentConnections.some((connection) => connection.id === editing.id)
        ? `edit:connection:${editing.id}`
        : "new:connection"
      : "list",
  );
  const ownsHeader = props.onBack !== undefined || editing !== null;
  const dirty =
    editing !== null && JSON.stringify(editing) !== JSON.stringify(initialDraft.current);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    props.onEditingChange?.(ownsHeader);
    return () => props.onEditingChange?.(false);
  }, [ownsHeader, props.onEditingChange]);
  useEffect(() => {
    props.registerLeaveGuard?.(
      () => !dirtyRef.current || window.confirm("连接有未保存的修改，放弃修改并离开吗？"),
    );
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      props.registerLeaveGuard?.(null);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [props.registerLeaveGuard]);

  async function runTest(draft: AgentConnectionDraft): Promise<void> {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await props.onTestConnection(connectionFromDraft(draft));
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

  function save(draft: AgentConnectionDraft): void {
    try {
      props.onChange(upsertAgentConnection(settings, connectionFromDraft(draft)));
      rememberScroll();
      setEditing(null);
      setTestResult(null);
    } catch (error) {
      reportError(error);
    }
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
    rememberScroll();
    setEditing(null);
  }

  function startCreate(): void {
    rememberScroll();
    setModels([]);
    initialDraft.current = {
      id: createUiId(),
      name: "",
      baseUrl: "",
      apiKey: "",
      model: "",
      headerRows: [],
    };
    setEditing(initialDraft.current);
    setTestResult(null);
  }

  function startEdit(connection: AgentConnection): void {
    rememberScroll();
    setModels([]);
    initialDraft.current = createConnectionDraft(connection, createUiId);
    setEditing(initialDraft.current);
    setTestResult(null);
  }

  return (
    <div ref={screenRef} className="stm-settings-detail-page" data-stm-field="agent-connections">
      {!editing && (
        <>
          {props.onBack && (
            <PageChrome
              pageKey="connection-list"
              header={
                <PanelBar
                  title="Agent 连接"
                  leading={
                    <PanelBarAction
                      icon="fa-arrow-left"
                      label="返回设置"
                      data-action="settings-back"
                      onClick={props.onBack}
                    />
                  }
                  trailing={
                    <PanelBarAction
                      icon="fa-plus"
                      label="新建连接"
                      data-action="create-connection"
                      onClick={startCreate}
                    />
                  }
                />
              }
            />
          )}
          <ListGroup as="ul" className="stm-settings-item-list" data-stm-field="connection-list">
            {settings.agentConnections.map((connection) => (
              <li key={connection.id} data-stm-field="connection-row">
                <NavigationRow
                  data-action="edit-connection"
                  onClick={() => startEdit(connection)}
                  title={connection.name}
                  description=<>
                    {connection.baseUrl} · {connection.model}
                  </>
                />
              </li>
            ))}
          </ListGroup>
          {settings.agentConnections.length === 0 && <div className="stm-empty">暂无独立连接</div>}
          {!props.onBack && (
            <Button
              type="button"

              data-action="create-connection"
              onClick={startCreate}
            >
              新建连接
            </Button>
          )}
        </>
      )}
      {editing && (
        <AgentConnectionForm
          key={editing.id}
          chrome={props.onEditingChange !== undefined}
          title={
            settings.agentConnections.some((connection) => connection.id === editing.id)
              ? "编辑 Agent 连接"
              : "新建 Agent 连接"
          }
          onDelete={
            settings.agentConnections.some((connection) => connection.id === editing.id)
              ? () => remove(editing.id)
              : undefined
          }
          draft={editing}
          models={models}
          testing={testing}
          testResult={testResult}
          onDraftChange={(next) => {
            if (
              next.baseUrl !== editing.baseUrl ||
              next.apiKey !== editing.apiKey ||
              JSON.stringify(next.headerRows) !== JSON.stringify(editing.headerRows)
            ) {
              setModels([]);
              setTestResult(null);
            }
            setEditing(next);
          }}
          onTest={() => void runTest(editing)}
          onSave={() => save(editing)}
          onCancel={() => {
            if (!dirty || window.confirm("连接有未保存的修改，放弃修改并返回吗？")) {
              rememberScroll();
              setEditing(null);
            }
          }}
        />
      )}
      {/* 移动端优先：选择器纵向堆叠，每行一个（面板宽度有限，并排会挤压） */}
      {!editing && (
        <div className="stm-connection-selectors" data-stm-field="agent-selectors">
          <div className="stm-section-label">Agent 使用的连接 · 即时保存</div>
          {AGENT_CONNECTION_TARGETS.map((target) => (
            <ConnectionSelector
              key={target}
              target={target}
              settings={settings}
              onChange={props.onChange}
            />
          ))}

          <label className="stm-form-row stm-settings-timeout">
            <span className="stm-form-label">每批填写时限（秒）</span>
            <select
              className="stm-select"
              value={settings.fillAgentTimeoutSeconds}
              onChange={(event) =>
                props.onChange({
                  ...settings,
                  fillAgentTimeoutSeconds: Number(event.target.value),
                })
              }
            >
              {[
                30,
                60,
                120,
                300,
                600,
                900,
                1800,
                ...([30, 60, 120, 300, 600, 900, 1800].includes(settings.fillAgentTimeoutSeconds)
                  ? []
                  : [settings.fillAgentTimeoutSeconds]),
              ].map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds}
                </option>
              ))}
            </select>
          </label>
          <div className="stm-setting-hint">超时后不提交当前批次</div>
        </div>
      )}
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
  const selectorId = useId();
  return (
    <div
      className="stm-setting-row stm-connection-selector-row"
      data-stm-field="agent-connection-selector"
    >
      <label className="stm-setting-label" htmlFor={selectorId}>
        {target === "fillTask" ? "表格填写 Agent" : "记忆助手"}
      </label>
      <Select
        id={selectorId}
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
      </Select>
    </div>
  );
}

/** 连接编辑表单（新建/编辑共用）：手写模型 + 右侧 Select 下拉（字典序，测试成功后填充） */
export function AgentConnectionForm(props: {
  readonly chrome?: boolean;
  readonly title?: string;
  readonly onDelete?: () => void;
  readonly draft: AgentConnectionDraft;
  readonly models: readonly string[];
  readonly testing: boolean;
  readonly testResult: { ok: boolean; text: string } | null;
  readonly onDraftChange: (draft: AgentConnectionDraft) => void;
  readonly onTest: () => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const { draft, models } = props;
  const formId = useId();
  const headerRows = draft.headerRows;
  const [showHeaderValues, setShowHeaderValues] = useState(false);
  const headerError = connectionHeaderError(headerRows.map(({ name, value }) => [name, value]));
  function changeHeaders(rows: typeof headerRows): void {
    props.onDraftChange({ ...draft, headerRows: rows });
  }
  const canSave =
    draft.name.trim() !== "" &&
    draft.baseUrl.trim() !== "" &&
    draft.model.trim() !== "" &&
    !headerError;
  const canTest = draft.baseUrl.trim() !== "" && !headerError;
  return (
    <form
      id={formId}
      autoComplete="off"
      className="stm-connection-form"
      data-stm-field="connection-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave && !props.testing) props.onSave();
      }}
    >
      {props.chrome && (
        <PageChrome
          pageKey={`connection:${draft.id}`}
          header={
            <PanelBar
              title={props.title ?? "编辑 Agent 连接"}
              leading={
                <PanelBarAction
                  icon="fa-arrow-left"
                  label="取消编辑"
                  data-action="cancel-connection"
                  disabled={props.testing}
                  onClick={props.onCancel}
                />
              }
              trailing={
                <>
                  {props.onDelete && (
                    <PanelBarAction
                      icon="fa-trash"
                      label="删除连接"
                      data-action="delete-connection"
                      danger
                      disabled={props.testing}
                      onClick={props.onDelete}
                    />
                  )}
                  <PanelBarAction
                    icon="fa-check"
                    label="保存连接"
                    type="submit"
                    form={formId}
                    data-action="save-connection"
                    disabled={!canSave || props.testing}
                  />
                </>
              }
            />
          }
        />
      )}
      <fieldset className="stm-settings-fields" disabled={props.testing}>
        <div className="stm-setting-row stm-connection-form-row">
          <label className="stm-setting-label">名称</label>
          <Input
            autoComplete="off"
            data-stm-field="connection-name"
            aria-label="名称"
            value={draft.name}
            placeholder="如：DeepSeek 主用"
            onChange={(event) => props.onDraftChange({ ...draft, name: event.target.value })}
          />
        </div>
        <div className="stm-setting-row stm-connection-form-row">
          <label className="stm-setting-label">Base URL</label>
          <Input
            type="url"
            autoComplete="off"
            data-stm-field="connection-base-url"
            aria-label="端点"
            value={draft.baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(event) => props.onDraftChange({ ...draft, baseUrl: event.target.value })}
          />
        </div>
        <div className="stm-setting-row stm-connection-form-row">
          <label className="stm-setting-label">API Key</label>
          <Input
            type="password"
            autoComplete="new-password"
            data-stm-field="connection-api-key"
            aria-label="API Key"
            value={draft.apiKey}
            placeholder="无鉴权本地服务可留空"
            onChange={(event) => props.onDraftChange({ ...draft, apiKey: event.target.value })}
          />
        </div>
        <div className="stm-connection-headers" data-stm-field="connection-headers">
          <div className="stm-setting-label">自定义请求头</div>
          <div className="stm-setting-hint">
            仅用于当前连接；Authorization 可覆盖 API Key，Content-Type 固定为 application/json。
          </div>
          {headerRows.map((row, index) => (
            <div className="stm-connection-header-row" key={row.id}>
              <Input
                aria-label={`请求头名称 ${index + 1}`}
                autoComplete="off"
                placeholder="X-API-Key"
                value={row.name}
                onChange={(event) =>
                  changeHeaders(
                    headerRows.map((item) =>
                      item.id === row.id ? { ...item, name: event.target.value } : item,
                    ),
                  )
                }
              />
              <Input
                aria-label={`请求头值 ${index + 1}`}
                autoComplete="new-password"
                type={showHeaderValues ? "text" : "password"}
                placeholder="值（可为空）"
                value={row.value}
                onChange={(event) =>
                  changeHeaders(
                    headerRows.map((item) =>
                      item.id === row.id ? { ...item, value: event.target.value } : item,
                    ),
                  )
                }
              />
              <Button
                type="button"

                aria-label={`删除请求头 ${index + 1}`}
                onClick={() => changeHeaders(headerRows.filter((item) => item.id !== row.id))}
              >
                删除
              </Button>
            </div>
          ))}
          <div className="stm-setting-actions">
            <Button
              type="button"

              data-action="add-connection-header"
              onClick={() =>
                changeHeaders([...headerRows, { id: createUiId(), name: "", value: "" }])
              }
            >
              新增请求头
            </Button>
            <Button
              type="button"

              aria-pressed={showHeaderValues}
              onClick={() => setShowHeaderValues(!showHeaderValues)}
            >
              {showHeaderValues ? "隐藏值" : "显示值"}
            </Button>
          </div>
          {headerError && (
            <div className="stm-connection-test-fail" role="alert">
              {headerError}
            </div>
          )}
        </div>
        <div className="stm-setting-row stm-connection-form-row">
          <label className="stm-setting-label">模型</label>
          <div className="stm-connection-model-row">
            <Input
              autoComplete="off"
              data-stm-field="connection-model"
              aria-label="模型"
              value={draft.model}
              placeholder="手写模型名"
              onChange={(event) => props.onDraftChange({ ...draft, model: event.target.value })}
            />
            <Select
              data-stm-field="connection-model-select"
              aria-label="已拉取模型"
              value={draft.model}
              onChange={(event) => props.onDraftChange({ ...draft, model: event.target.value })}
            >
              <option value="">选择已拉取模型…</option>
              {models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </fieldset>
      <div className="stm-setting-actions">
        <Button
          type="button"

          data-action="test-connection"
          disabled={props.testing || !canTest}
          onClick={props.onTest}
        >
          {props.testing ? "测试中…" : "测试连接"}
        </Button>
        {!props.chrome && (
          <Button data-action="save-connection" disabled={!canSave} type="submit">
            保存
          </Button>
        )}
        {!props.chrome && (
          <Button
            type="button"

            data-action="cancel-connection"
            onClick={props.onCancel}
          >
            取消
          </Button>
        )}
      </div>
      {props.testResult && (
        <div
          className={props.testResult.ok ? "stm-connection-test-ok" : "stm-connection-test-fail"}
          data-stm-field="connection-test-result"
        >
          {props.testResult.text}
        </div>
      )}
      <Disclosure icon="fa-circle-info" title="连接与密钥存储">
        <div className="stm-setting-hint">
          为表格填写 Agent / 记忆助手 指定独立模型服务（Base URL + API Key + 模型名）； 请求仍走 ST
          服务端转发，无 CORS。API Key 和请求头值以明文存于浏览器本地。未配置任何连接时 Agent 跟随
          ST 当前连接。
        </div>
      </Disclosure>
    </form>
  );
}
