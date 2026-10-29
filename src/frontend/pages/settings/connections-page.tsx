import { useEffect, useRef, useState } from "react";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import { Button } from "../../../ui/primitives/button.tsx";
import { Input } from "../../../ui/primitives/input.tsx";
import { NativeSelect, NativeSelectOption } from "../../../ui/primitives/native-select.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "../../../ui/primitives/field.tsx";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
  ItemGroup,
} from "../../../ui/primitives/item.tsx";
import { PageContent, PageHeader } from "../../components/page-layout.tsx";
import { PageSection } from "../../components/page-section.tsx";
import { ConfirmAction, usePageLeave } from "../../components/confirmation.tsx";
import { PageEmpty, StatusNotice } from "../../components/page-state.tsx";
import { usePageScroll } from "../../components/use-page-scroll.ts";
import {
  createConnectionDraft,
  connectionFromDraft,
  type AgentConnectionDraft,
} from "../../../ui/settings/agent-connection-draft.ts";
import {
  agentConnectionSelection,
  removeAgentConnection,
  setAgentConnection,
  upsertAgentConnection,
  type AgentConnection,
  type AgentConnectionTarget,
} from "../../../features/settings/agent-connections.ts";
import {
  SettingsEditor,
  SecretInput,
  type SettingsSubpageProps,
} from "./connection-settings-editor.tsx";
import { normalizedAgentConnection, persistSettingsEdit } from "./connection-settings-model.ts";

export function ConnectionsPage(props: SettingsSubpageProps) {
  const [editing, setEditing] = useState<AgentConnectionDraft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  return editing ? (
    <AgentConnectionEditor
      {...props}
      key={editing.id}
      initial={editing}
      onBack={() => setEditing(null)}
      onSaved={(message) => {
        setNotice(message);
        setEditing(null);
      }}
    />
  ) : (
    <ConnectionList
      {...props}
      notice={notice}
      onEdit={(connection) =>
        setEditing(createConnectionDraft(connection, () => crypto.randomUUID()))
      }
      onCreate={() =>
        setEditing({
          id: crypto.randomUUID(),
          name: "",
          baseUrl: "",
          apiKey: "",
          model: "",
          headerRows: [],
        })
      }
    />
  );
}

function ConnectionList({
  services,
  controls,
  onBack,
  registerLeaveGuard,
  notice: savedNotice,
  onEdit,
  onCreate,
}: SettingsSubpageProps & {
  notice: string | null;
  onEdit: (connection: AgentConnection) => void;
  onCreate: () => void;
}) {
  const [settings, setSettings] = useState(() => services.settings.read());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState(savedNotice);
  const scroll = usePageScroll(services, "global-connections-list", true);
  const { requestLeave, confirmation } = usePageLeave({
    dirty: false,
    busy,
    scope: "connection-list",
    discard: () => {},
    register: registerLeaveGuard,
  });
  async function select(target: AgentConnectionTarget, id: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (
        id &&
        !services.settings.read().agentConnections.some((connection) => connection.id === id)
      )
        throw new Error("所选连接已不存在，请重新选择");
      const result = await persistSettingsEdit(
        services,
        () =>
          services.settings.save(
            setAgentConnection(services.settings.read(), target, id || undefined),
          ),
        (value) => agentConnectionSelection(value, target) === (id || undefined),
      );
      setSettings(result.settings);
      if (result.error)
        setError(`${result.saved ? "选择已保存，后续刷新失败" : "选择未保存"}：${result.error}`);
      else setNotice("连接选择已保存。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <PageHeader
        title="Agent 连接"
        {...controls}
        onBack={() => requestLeave(onBack)}
        busy={busy}
      />
      <PageContent
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        className="ste:flex ste:flex-col ste:gap-5"
      >
        {error ? (
          <StatusNotice variant="destructive">{error}</StatusNotice>
        ) : notice ? (
          <StatusNotice>{notice}</StatusNotice>
        ) : null}
        <PageSection title="默认 Agent 连接">
          <FieldGroup className="ste:gap-5">
            {(
              [
                ["fillTask", "表格填写 Agent"],
                ["queryChat", "查询 Agent"],
              ] as const
            ).map(([target, label]) => (
              <Field key={target}>
                <FieldLabel htmlFor={`connection-${target}`}>{label}</FieldLabel>
                <NativeSelect
                  id={`connection-${target}`}
                  className="ste:w-full"
                  disabled={busy}
                  value={agentConnectionSelection(settings, target) ?? ""}
                  onChange={(event) => void select(target, event.target.value)}
                >
                  <NativeSelectOption value="">跟随 SillyTavern 当前连接</NativeSelectOption>
                  {settings.agentConnections.map((connection) => (
                    <NativeSelectOption key={connection.id} value={connection.id}>
                      {connection.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <FieldDescription>选择后立即保存；运行中的任务沿用启动时的连接。</FieldDescription>
              </Field>
            ))}
          </FieldGroup>
        </PageSection>
        <PageSection
          title="独立连接"
          action={
            <div className="ste:flex ste:flex-wrap ste:items-center ste:gap-2">
              <span className="ste:text-xs ste:text-muted-foreground">
                {settings.agentConnections.length} 个
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={onCreate}
                disabled={busy}
                data-action="create-connection"
              >
                <Plus />
                新建
              </Button>
            </div>
          }
          bodyClassName="ste:p-0"
        >
          {settings.agentConnections.length ? (
            <ItemGroup className="ste:gap-0 ste:divide-y ste:divide-border">
              {settings.agentConnections.map((connection) => (
                <div role="listitem" key={connection.id}>
                  <Item
                    render={<button type="button" disabled={busy} />}
                    className="ste:rounded-none ste:border-0 ste:px-4 ste:py-2.5 ste:text-left ste:hover:bg-muted/60 ste:focus-visible:ring-inset"
                    onClick={() => onEdit(connection)}
                    data-action="edit-connection"
                  >
                    <ItemContent>
                      <ItemTitle>{connection.name}</ItemTitle>
                      <ItemDescription className="ste:break-all">
                        {connection.baseUrl} · {connection.model}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <ChevronRight className="ste:size-4 ste:text-muted-foreground" />
                    </ItemActions>
                  </Item>
                </div>
              ))}
            </ItemGroup>
          ) : (
            <PageEmpty
              title="暂无独立连接"
              description="可以新建 OpenAI 兼容连接，也可以继续跟随 SillyTavern。"
            />
          )}
        </PageSection>
      </PageContent>
      {confirmation}
    </div>
  );
}

function AgentConnectionEditor({
  services,
  controls,
  onBack,
  registerLeaveGuard,
  initial,
  onSaved,
}: SettingsSubpageProps & { initial: AgentConnectionDraft; onSaved: (notice: string) => void }) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [models, setModels] = useState<readonly string[]>([]);
  const [testResult, setTestResult] = useState<{ error: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const testGeneration = useRef(0);
  useEffect(
    () => () => {
      testGeneration.current++;
    },
    [],
  );
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const [exists] = useState(() =>
    services.settings.read().agentConnections.some((connection) => connection.id === initial.id),
  );
  function change(next: AgentConnectionDraft) {
    if (
      next.baseUrl !== draft.baseUrl ||
      next.apiKey !== draft.apiKey ||
      JSON.stringify(next.headerRows) !== JSON.stringify(draft.headerRows)
    ) {
      testGeneration.current++;
      setModels([]);
      setTestResult(null);
      setTesting(false);
    }
    setDraft(next);
    setError(null);
  }
  function addHeader() {
    change({
      ...draft,
      headerRows: [...draft.headerRows, { id: crypto.randomUUID(), name: "", value: "" }],
    });
  }
  function updateHeader(id: string, patch: { name?: string; value?: string }) {
    change({
      ...draft,
      headerRows: draft.headerRows.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    });
  }
  async function runTest() {
    const token = ++testGeneration.current;
    setTesting(true);
    setTestResult(null);
    try {
      const connection = connectionFromDraft(draft);
      if (!connection.baseUrl.trim()) throw new Error("请填写连接地址");
      const result = await services.testAgentConnection(connection);
      if (token !== testGeneration.current) return;
      if (result.ok) {
        setModels(result.models);
        setTestResult({ error: false, text: `连接成功，获取到 ${result.models.length} 个模型。` });
      } else setTestResult({ error: true, text: result.error });
    } catch (cause) {
      if (token === testGeneration.current)
        setTestResult({
          error: true,
          text: cause instanceof Error ? cause.message : String(cause),
        });
    } finally {
      if (token === testGeneration.current) setTesting(false);
    }
  }
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const connection = normalizedAgentConnection(connectionFromDraft(draft));
      const result = await persistSettingsEdit(
        services,
        () => {
          const latest = services.settings.read();
          if (exists && !latest.agentConnections.some((item) => item.id === connection.id))
            throw new Error("连接已被删除，请返回后重新创建");
          services.settings.save(upsertAgentConnection(latest, connection));
        },
        (settings) =>
          JSON.stringify(settings.agentConnections.find((item) => item.id === connection.id)) ===
          JSON.stringify(connection),
      );
      if (result.saved)
        onSaved(result.error ? `连接已保存，后续刷新失败：${result.error}` : "连接已保存。");
      else setError(`连接未保存：${result.error ?? "保存结果与草稿不一致"}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    try {
      const result = await persistSettingsEdit(
        services,
        () => services.settings.save(removeAgentConnection(services.settings.read(), draft.id)),
        (settings) => !settings.agentConnections.some((item) => item.id === draft.id),
      );
      if (!result.saved) throw new Error(result.error ?? "连接未删除");
      onSaved(
        result.error
          ? `连接已删除，后续刷新失败：${result.error}`
          : "连接已删除，原有选择已改为跟随 SillyTavern。",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsEditor
      title={exists ? "编辑 Agent 连接" : "新建 Agent 连接"}
      scope={`connection-${initial.id}`}
      controls={controls}
      onBack={onBack}
      registerLeaveGuard={registerLeaveGuard}
      dirty={dirty}
      busy={busy}
      onDiscard={() => setDraft(initial)}
      onSave={() => void save()}
      error={error}
    >
      <PageSection title="连接信息">
        <FieldGroup className="ste:gap-5">
          <Field>
            <FieldLabel htmlFor="agent-connection-name">连接名称</FieldLabel>
            <Input
              id="agent-connection-name"
              value={draft.name}
              required
              onChange={(event) => change({ ...draft, name: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="agent-connection-url">API Base URL</FieldLabel>
            <Input
              id="agent-connection-url"
              value={draft.baseUrl}
              required
              type="url"
              placeholder="https://example.com/v1"
              onChange={(event) => change({ ...draft, baseUrl: event.target.value })}
            />
            <FieldDescription>通过 SillyTavern 服务端转发 OpenAI 兼容请求。</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="agent-connection-key">API Key</FieldLabel>
            <SecretInput
              id="agent-connection-key"
              label="API Key"
              value={draft.apiKey}
              onChange={(event) => change({ ...draft, apiKey: event.target.value })}
            />
          </Field>
        </FieldGroup>
      </PageSection>
      <PageSection
        title="模型"
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={testing || !draft.baseUrl.trim()}
            onClick={() => void runTest()}
            data-action="test-connection"
          >
            {testing ? "正在测试…" : "测试连接"}
          </Button>
        }
      >
        <div className="ste:flex ste:flex-col ste:gap-4">
          {testResult ? (
            <StatusNotice variant={testResult.error ? "destructive" : "default"}>
              {testResult.text}
            </StatusNotice>
          ) : null}
          {models.length ? (
            <Field>
              <FieldLabel htmlFor="agent-connection-model-list">可用模型</FieldLabel>
              <NativeSelect
                id="agent-connection-model-list"
                className="ste:w-full"
                value={models.includes(draft.model) ? draft.model : ""}
                onChange={(event) => change({ ...draft, model: event.target.value })}
              >
                <NativeSelectOption value="" disabled>
                  选择模型
                </NativeSelectOption>
                {models.map((model) => (
                  <NativeSelectOption key={model} value={model}>
                    {model}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          ) : null}
          <Field>
            <FieldLabel htmlFor="agent-connection-model">模型名称</FieldLabel>
            <Input
              id="agent-connection-model"
              value={draft.model}
              required
              onChange={(event) => change({ ...draft, model: event.target.value })}
            />
            <FieldDescription>可以直接填写模型标识，无须先测试连接。</FieldDescription>
          </Field>
        </div>
      </PageSection>
      <PageSection
        title="自定义请求头"
        action={
          <div className="ste:flex ste:flex-wrap ste:items-center ste:gap-2">
            <span className="ste:text-xs ste:text-muted-foreground">
              {draft.headerRows.length} 个
            </span>
            <Button type="button" size="sm" variant="outline" onClick={addHeader}>
              <Plus />
              添加
            </Button>
          </div>
        }
      >
        <div className="ste:flex ste:flex-col ste:gap-4">
          <FieldDescription>
            请求头名称不能重复，Content-Type 固定为 application/json。
          </FieldDescription>
          {draft.headerRows.map((row, index) => (
            <div
              key={row.id}
              className="ste:flex ste:min-w-0 ste:flex-col ste:gap-3 ste:rounded-lg ste:border ste:border-border ste:bg-muted/30 ste:p-3"
            >
              <Field>
                <FieldLabel htmlFor={`header-name-${row.id}`}>请求头 {index + 1} 名称</FieldLabel>
                <Input
                  id={`header-name-${row.id}`}
                  value={row.name}
                  required
                  onChange={(event) => updateHeader(row.id, { name: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`header-value-${row.id}`}>请求头 {index + 1} 值</FieldLabel>
                <SecretInput
                  id={`header-value-${row.id}`}
                  label={`请求头 ${index + 1} 值`}
                  value={row.value}
                  onChange={(event) => updateHeader(row.id, { value: event.target.value })}
                />
              </Field>
              <Button
                type="button"
                variant="ghost"
                className="ste:self-start"
                onClick={() =>
                  change({
                    ...draft,
                    headerRows: draft.headerRows.filter((item) => item.id !== row.id),
                  })
                }
              >
                <Trash2 />
                移除请求头 {index + 1}
              </Button>
            </div>
          ))}
        </div>
      </PageSection>
      {exists ? (
        <Button type="button" variant="destructive" onClick={() => setDeleting(true)}>
          <Trash2 />
          删除连接
        </Button>
      ) : null}
      <ConfirmAction
        open={deleting}
        onOpenChange={setDeleting}
        title={`删除连接「${draft.name}」？`}
        description="使用此连接的 Agent 将改为跟随 SillyTavern 当前连接。"
        confirmLabel="删除连接"
        destructive
        onConfirm={remove}
      />
    </SettingsEditor>
  );
}
