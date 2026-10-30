import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Copy, Plus, Trash2, Download } from "lucide-react";
import { Button } from "../../primitives/button.tsx";
import { Input } from "../../primitives/input.tsx";
import { Textarea } from "../../primitives/textarea.tsx";
import { NativeSelect, NativeSelectOption } from "../../primitives/native-select.tsx";
import { Field, FieldLabel, FieldDescription } from "../../primitives/field.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../../primitives/card.tsx";
import { Badge } from "../../primitives/badge.tsx";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
  ItemActions,
  ItemGroup,
} from "../../primitives/item.tsx";
import { PageContent, PageHeader } from "../../components/page-layout.tsx";
import { PageSection } from "../../components/page-section.tsx";
import { usePageScroll } from "../../components/use-page-scroll.ts";
import { SwitchField } from "../../components/form-fields.tsx";
import { ConfirmAction, usePageLeave } from "../../components/confirmation.tsx";
import { StatusNotice } from "../../components/page-state.tsx";
import { PROPOSAL_AGENT_BASE_INSTRUCTIONS } from "../../../features/agent/index.ts";
import { downloadTextFile } from "../../../infrastructure/browser/download.ts";
import {
  BUILTIN_AGENT_PRESET_ID,
  AGENT_PRESET_ROLES,
  containsDigestReference,
  deleteAgentPreset,
  importAgentPreset,
  parseAgentPresetExport,
  serializeAgentPresetExport,
  setActiveAgentPreset,
  type AgentPromptPreset,
  type AgentPresetRole,
} from "../../../features/agent-presets/preset-model.ts";
import {
  AGENT_PRESET_PLACEHOLDERS,
  AGENT_PRESET_PLACEHOLDER_HINTS,
  type AgentPresetPlaceholderName,
} from "../../../features/agent-presets/preset-composer.ts";
import {
  buildAgentPresetPreviewItems,
  type AgentPresetPreviewItem,
} from "../../../features/agent-presets/preset-preview-model.ts";
import { SettingsEditor, type SettingsSubpageProps } from "./connection-settings-editor.tsx";
import { persistSettingsEdit } from "./connection-settings-model.ts";
import type { PresetSettingsServices } from "./preset-settings-services.ts";

type Props = SettingsSubpageProps & { presets: PresetSettingsServices };
const builtin: AgentPromptPreset = {
  id: BUILTIN_AGENT_PRESET_ID,
  name: "系统默认",
  messages: [
    {
      id: "system-instructions",
      name: "系统默认指令",
      role: "system",
      content: PROPOSAL_AGENT_BASE_INSTRUCTIONS,
      enabled: true,
    },
    {
      id: "system-digest",
      name: "表格摘要",
      role: "system",
      content: AGENT_PRESET_PLACEHOLDERS.tablesDigest,
      enabled: true,
    },
  ],
};

export function AgentPresetsPage(props: Props) {
  const [editing, setEditing] = useState<{ preset: AgentPromptPreset; isNew: boolean } | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  return editing ? (
    <AgentPresetEditor
      {...props}
      key={editing.preset.id}
      initial={editing.preset}
      isNew={editing.isNew}
      onBack={() => setEditing(null)}
      onSaved={(message) => {
        setNotice(message);
        setEditing(null);
      }}
    />
  ) : (
    <AgentPresetList
      {...props}
      notice={notice}
      onEdit={(preset, isNew = false) => setEditing({ preset, isNew })}
    />
  );
}

function AgentPresetList({
  services,
  controls,
  onBack,
  registerLeaveGuard,
  onEdit,
  notice: initialNotice,
}: Props & {
  notice: string | null;
  onEdit: (preset: AgentPromptPreset, isNew?: boolean) => void;
}) {
  const [settings, setSettings] = useState(() => services.settings.read());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState(initialNotice);
  const scroll = usePageScroll(services, "global-agent-presets", true);
  const { confirmation } = usePageLeave({
    dirty: false,
    busy,
    scope: "agent-presets-list",
    discard: () => {},
    register: registerLeaveGuard,
  });
  async function activate(id: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await persistSettingsEdit(
        services,
        () => {
          const latest = services.settings.read();
          if (
            id !== BUILTIN_AGENT_PRESET_ID &&
            !latest.agentPresets.presets.some((preset) => preset.id === id)
          )
            throw new Error("预设已不存在，请重新选择");
          services.settings.save({
            ...latest,
            agentPresets: setActiveAgentPreset(latest.agentPresets, id),
          });
        },
        (value) => value.agentPresets.activePresetId === id,
      );
      setSettings(result.settings);
      if (result.error)
        setError(
          `${result.saved ? "活动预设已保存，后续刷新失败" : "活动预设未保存"}：${result.error}`,
        );
      else setNotice("活动预设已保存，之后启动的任务使用此预设。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function importFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const parsed = parseAgentPresetExport(await file.text());
      const imported = {
        ...parsed,
        id: crypto.randomUUID(),
        messages: parsed.messages.map((message) => ({ ...message, id: crypto.randomUUID() })),
      };
      const result = await persistSettingsEdit(
        services,
        () => {
          const latest = services.settings.read();
          services.settings.save({
            ...latest,
            agentPresets: importAgentPreset(latest.agentPresets, imported),
          });
        },
        (value) => value.agentPresets.presets.some((preset) => preset.id === imported.id),
      );
      setSettings(result.settings);
      if (result.error)
        setError(`${result.saved ? "预设已导入，后续刷新失败" : "预设未导入"}：${result.error}`);
      else setNotice("预设已导入并设为活动预设。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <PageHeader title="Agent 提示词预设" {...controls} onBack={onBack} busy={busy} />
      <PageContent
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        className="ste:flex ste:flex-col ste:gap-4"
      >
        {error ? (
          <StatusNotice variant="destructive">{error}</StatusNotice>
        ) : notice ? (
          <StatusNotice>{notice}</StatusNotice>
        ) : null}
        <PageSection title="活动预设">
          <Field>
            <FieldLabel htmlFor="active-agent-preset">活动预设</FieldLabel>
            <NativeSelect
              id="active-agent-preset"
              className="ste:w-full"
              disabled={busy}
              value={settings.agentPresets.activePresetId}
              onChange={(event) => void activate(event.target.value)}
            >
              <NativeSelectOption value={BUILTIN_AGENT_PRESET_ID}>系统默认</NativeSelectOption>
              {settings.agentPresets.presets.map((preset) => (
                <NativeSelectOption key={preset.id} value={preset.id}>
                  {preset.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription>运行中的任务保持原提示词快照。</FieldDescription>
          </Field>
        </PageSection>
        <PageSection
          title="预设"
          action={
            <div className="ste:flex ste:flex-wrap ste:items-center ste:justify-end ste:gap-2">
              <span className="ste:text-xs ste:text-muted-foreground">
                {settings.agentPresets.presets.length + 1} 个
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                data-action="create-agent-preset"
                onClick={() =>
                  onEdit(
                    {
                      id: crypto.randomUUID(),
                      name: "",
                      messages: [
                        {
                          id: crypto.randomUUID(),
                          name: "",
                          role: "system",
                          content: "",
                          enabled: true,
                        },
                      ],
                    },
                    true,
                  )
                }
              >
                <Plus />
                新建
              </Button>
            </div>
          }
          bodyClassName="ste:p-0"
        >
          <ItemGroup className="ste:gap-0 ste:divide-y ste:divide-border">
            {[builtin, ...settings.agentPresets.presets].map((preset) => (
              <div role="listitem" key={preset.id}>
                <Item
                  render={<button type="button" disabled={busy} />}
                  className="ste:cursor-pointer ste:rounded-none ste:border-0 ste:px-4 ste:py-2.5 ste:text-left ste:hover:bg-muted/60 ste:focus-visible:ring-inset"
                  onClick={() => onEdit(preset)}
                  data-action="open-agent-preset"
                >
                  <ItemContent>
                    <ItemTitle>{preset.name}</ItemTitle>
                    <ItemDescription className="ste:line-clamp-1">
                      {preset.id === BUILTIN_AGENT_PRESET_ID
                        ? "内置 · 只读，可复制"
                        : `自定义 · ${preset.messages.length} 条消息`}
                      {preset.id === settings.agentPresets.activePresetId ? " · 使用中" : ""}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <ChevronRight className="ste:size-4 ste:text-muted-foreground" />
                  </ItemActions>
                </Item>
              </div>
            ))}
          </ItemGroup>
        </PageSection>
        <PageSection title="导入">
          <Field>
            <FieldLabel htmlFor="import-agent-preset">导入 Agent 预设 JSON</FieldLabel>
            <Input
              id="import-agent-preset"
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void importFile(file);
              }}
            />
          </Field>
        </PageSection>
      </PageContent>
      {confirmation}
    </div>
  );
}

function AgentPresetEditor({
  services,
  presets,
  controls,
  onBack,
  registerLeaveGuard,
  initial,
  isNew,
  onSaved,
}: Props & { initial: AgentPromptPreset; isNew: boolean; onSaved: (message: string) => void }) {
  const [draft, setDraft] = useState(initial);
  const [baseline, setBaseline] = useState(initial);
  const [newPreset, setNewPreset] = useState(isNew);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [input, setInput] = useState("");
  const [preview, setPreview] = useState<readonly AgentPresetPreviewItem[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const previewGeneration = useRef(0);
  const previewContext = presets.currentContext();
  const previewContextKey = JSON.stringify([previewContext?.chatIdentity, previewContext?.spaceId]);
  useEffect(() => {
    previewGeneration.current++;
    setPreview(null);
    setPreviewing(false);
  }, [previewContextKey]);
  useEffect(
    () => () => {
      previewGeneration.current++;
    },
    [],
  );
  const readOnly = draft.id === BUILTIN_AGENT_PRESET_ID;
  const dirty = newPreset || JSON.stringify(draft) !== JSON.stringify(baseline);
  function change(next: AgentPromptPreset) {
    previewGeneration.current++;
    setPreviewing(false);
    setPreview(null);
    setDraft(next);
    setError(null);
  }
  function copy() {
    const next = {
      ...draft,
      id: crypto.randomUUID(),
      name: `${draft.name} (副本)`,
      messages: draft.messages.map((message) => ({ ...message, id: crypto.randomUUID() })),
    };
    setNewPreset(true);
    setBaseline(next);
    change(next);
  }
  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (!draft.name.trim()) throw new Error("请填写预设名称");
      const next = { ...draft, name: draft.name.trim() };
      const result = await persistSettingsEdit(
        services,
        () => {
          const latest = services.settings.read();
          if (!newPreset && !latest.agentPresets.presets.some((preset) => preset.id === next.id))
            throw new Error("预设已被删除，请返回列表重新创建");
          const list = newPreset
            ? [...latest.agentPresets.presets, next]
            : latest.agentPresets.presets.map((preset) => (preset.id === next.id ? next : preset));
          services.settings.save({
            ...latest,
            agentPresets: { ...latest.agentPresets, presets: list },
          });
        },
        (value) =>
          JSON.stringify(value.agentPresets.presets.find((preset) => preset.id === next.id)) ===
          JSON.stringify(next),
      );
      if (result.saved) {
        setBaseline(next);
        setDraft(next);
        setNewPreset(false);
        setNotice(result.error ? `预设已保存，后续刷新失败：${result.error}` : "预设已保存。");
      } else setError(result.error ?? "预设未保存");
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
        () => {
          const latest = services.settings.read();
          services.settings.save({
            ...latest,
            agentPresets: deleteAgentPreset(latest.agentPresets, draft.id),
          });
        },
        (value) => !value.agentPresets.presets.some((preset) => preset.id === draft.id),
      );
      if (!result.saved) throw new Error(result.error ?? "预设未删除");
      onSaved(result.error ? `预设已删除，后续刷新失败：${result.error}` : "预设已删除。");
    } finally {
      setBusy(false);
    }
  }
  async function expand() {
    const token = ++previewGeneration.current;
    const context = presets.currentContext();
    const ports = presets.agentPreview;
    setPreviewing(true);
    setError(null);
    try {
      const snapshot = ports.getPromptSnapshot();
      const spaceId = ports.readSpaceId();
      const [digest, worldbook] = await Promise.all([
        spaceId ? ports.readDigest(spaceId) : Promise.resolve(undefined),
        input.trim()
          ? ports.scanWorldbook(input)
          : Promise.resolve({ text: "", status: "skipped" as const }),
      ]);
      if (token !== previewGeneration.current) return;
      if (context?.chatIdentity !== presets.currentContext()?.chatIdentity)
        throw new Error("对话已切换，请重新展开预览");
      setPreview(
        buildAgentPresetPreviewItems({
          preset: draft,
          snapshot: { ...snapshot, msgText: input, worldbookText: worldbook.text },
          digest,
          worldbookState: worldbook.status,
        }),
      );
    } catch (cause) {
      if (token === previewGeneration.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (token === previewGeneration.current) setPreviewing(false);
    }
  }
  function exportFile() {
    downloadTextFile(
      serializeAgentPresetExport(draft, new Date().toISOString()),
      `agent-preset-${draft.name.replace(/[\\/:*?"<>|]/g, "_") || "unnamed"}.json`,
    );
  }
  return (
    <SettingsEditor
      title={readOnly ? "系统默认提示词" : "编辑 Agent 预设"}
      scope="settings-agent-preset"
      controls={controls}
      onBack={onBack}
      registerLeaveGuard={registerLeaveGuard}
      dirty={dirty}
      busy={busy}
      onDiscard={() => {
        setDraft(baseline);
        setNewPreset(false);
      }}
      onSave={() => void save()}
      error={error}
      notice={notice}
    >
      <PageSection
        title="预设"
        action={
          <div className="ste:flex ste:flex-wrap ste:items-center ste:justify-end ste:gap-2">
            <Button type="button" size="sm" variant="outline" onClick={copy}>
              <Copy />
              复制为自定义
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={exportFile}>
              <Download />
              导出草稿
            </Button>
            {!readOnly && !newPreset ? (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={() => setDeleting(true)}
              >
                <Trash2 />
                删除
              </Button>
            ) : null}
          </div>
        }
      >
        <div className="ste:flex ste:flex-col ste:gap-4">
          <Field>
            <FieldLabel htmlFor="agent-preset-name">预设名称</FieldLabel>
            <Input
              id="agent-preset-name"
              required
              value={draft.name}
              disabled={readOnly}
              onChange={(event) => change({ ...draft, name: event.target.value })}
            />
          </Field>
          {!containsDigestReference(draft) ? (
            <StatusNotice>
              未引用表结构摘要，填写 Agent 将无法获取表与字段定义；可加入 {"{{tablesDigest}}"} 或{" "}
              {"{{systemDefaultPrompt}}"}。
            </StatusNotice>
          ) : null}
        </div>
      </PageSection>
      <PageSection
        title="消息"
        action={
          !readOnly ? (
            <div className="ste:flex ste:flex-wrap ste:items-center ste:justify-end ste:gap-2">
              <span className="ste:text-xs ste:text-muted-foreground">
                {draft.messages.length} 条
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  change({
                    ...draft,
                    messages: [
                      ...draft.messages,
                      {
                        id: crypto.randomUUID(),
                        name: "",
                        role: "system",
                        content: "",
                        enabled: true,
                      },
                    ],
                  })
                }
              >
                <Plus />
                添加消息
              </Button>
            </div>
          ) : (
            <span className="ste:text-xs ste:text-muted-foreground">
              {draft.messages.length} 条
            </span>
          )
        }
      >
        <div className="ste:flex ste:flex-col ste:gap-4">
          {draft.messages.map((message, index) => (
            <Card key={message.id} size="sm">
              <CardHeader>
                <CardTitle>消息 {index + 1}</CardTitle>
              </CardHeader>
              <CardContent className="ste:flex ste:flex-col ste:gap-4">
                <Field>
                  <FieldLabel htmlFor={`preset-message-name-${message.id}`}>
                    消息 {index + 1} 名称
                  </FieldLabel>
                  <Input
                    id={`preset-message-name-${message.id}`}
                    value={message.name}
                    disabled={readOnly}
                    onChange={(event) =>
                      change({
                        ...draft,
                        messages: draft.messages.map((item) =>
                          item.id === message.id ? { ...item, name: event.target.value } : item,
                        ),
                      })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`preset-message-role-${message.id}`}>
                    消息 {index + 1} 角色
                  </FieldLabel>
                  <NativeSelect
                    id={`preset-message-role-${message.id}`}
                    disabled={readOnly}
                    className="ste:w-full"
                    value={message.role}
                    onChange={(event) =>
                      change({
                        ...draft,
                        messages: draft.messages.map((item) =>
                          item.id === message.id
                            ? { ...item, role: event.target.value as AgentPresetRole }
                            : item,
                        ),
                      })
                    }
                  >
                    {AGENT_PRESET_ROLES.map((role) => (
                      <NativeSelectOption key={role} value={role}>
                        {role}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <SwitchField
                  label={`启用消息 ${index + 1}`}
                  checked={message.enabled}
                  disabled={readOnly}
                  onCheckedChange={(enabled) =>
                    change({
                      ...draft,
                      messages: draft.messages.map((item) =>
                        item.id === message.id ? { ...item, enabled } : item,
                      ),
                    })
                  }
                />
                <Field>
                  <FieldLabel htmlFor={`preset-message-content-${message.id}`}>
                    消息 {index + 1} 内容
                  </FieldLabel>
                  <Textarea
                    id={`preset-message-content-${message.id}`}
                    className="ste:min-h-40"
                    readOnly={readOnly}
                    value={message.content}
                    onChange={(event) =>
                      change({
                        ...draft,
                        messages: draft.messages.map((item) =>
                          item.id === message.id ? { ...item, content: event.target.value } : item,
                        ),
                      })
                    }
                  />
                </Field>
                {!readOnly ? (
                  <>
                    <div className="ste:flex ste:flex-wrap ste:gap-2">
                      {(
                        Object.entries(AGENT_PRESET_PLACEHOLDERS) as [
                          AgentPresetPlaceholderName,
                          string,
                        ][]
                      ).map(([name, value]) => (
                        <Button
                          key={name}
                          type="button"
                          size="sm"
                          variant="outline"
                          title={AGENT_PRESET_PLACEHOLDER_HINTS[name]}
                          onClick={() =>
                            change({
                              ...draft,
                              messages: draft.messages.map((item) =>
                                item.id === message.id
                                  ? { ...item, content: item.content + value }
                                  : item,
                              ),
                            })
                          }
                        >
                          {value}
                        </Button>
                      ))}
                    </div>
                    <div className="ste:flex ste:flex-wrap ste:gap-2">
                      {([-1, 1] as const).map((offset) => (
                        <Button
                          key={offset}
                          type="button"
                          variant="ghost"
                          disabled={index + offset < 0 || index + offset >= draft.messages.length}
                          onClick={() => {
                            const messages = [...draft.messages];
                            [messages[index], messages[index + offset]] = [
                              messages[index + offset]!,
                              messages[index]!,
                            ];
                            change({ ...draft, messages });
                          }}
                        >
                          {offset < 0 ? <ArrowUp /> : <ArrowDown />}
                          {offset < 0 ? "上移" : "下移"}消息 {index + 1}
                        </Button>
                      ))}
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          change({
                            ...draft,
                            messages: draft.messages.filter((item) => item.id !== message.id),
                          })
                        }
                      >
                        <Trash2 />
                        删除消息 {index + 1}
                      </Button>
                    </div>
                  </>
                ) : null}
              </CardContent>
            </Card>
          ))}
          {draft.messages.length === 0 ? (
            <p className="ste:text-sm ste:text-muted-foreground">还没有消息。</p>
          ) : null}
        </div>
      </PageSection>
      <PageSection
        title="预览"
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={previewing}
            onClick={() => void expand()}
          >
            {previewing ? "正在展开…" : "展开预览"}
          </Button>
        }
      >
        <div className="ste:flex ste:flex-col ste:gap-4">
          <Field>
            <FieldLabel htmlFor="preset-preview-input">预览剧情输入</FieldLabel>
            <Textarea
              id="preset-preview-input"
              value={input}
              onChange={(event) => {
                previewGeneration.current++;
                setPreviewing(false);
                setPreview(null);
                setInput(event.target.value);
              }}
            />
            <FieldDescription>仅展开当前草稿和上下文；有输入时执行世界书试扫描。</FieldDescription>
          </Field>
          {preview?.length === 0 ? (
            <StatusNotice>没有启用且非空的消息。</StatusNotice>
          ) : preview ? (
            <div className="ste:flex ste:flex-col ste:gap-3">
              {preview.map((item) => (
                <Card key={item.id} size="sm">
                  <CardHeader>
                    <CardTitle className="ste:break-words">
                      {item.sourceName} <Badge variant="secondary">{item.role}</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <pre className="ste:whitespace-pre-wrap ste:break-words ste:text-sm">
                      {item.text}
                    </pre>
                    {item.note ? (
                      <p className="ste:mt-3 ste:text-xs ste:text-muted-foreground">{item.note}</p>
                    ) : null}
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : null}
        </div>
      </PageSection>
      <ConfirmAction
        open={deleting}
        onOpenChange={setDeleting}
        title={`删除预设「${draft.name}」？`}
        description="删除活动预设后将使用系统默认提示词。"
        confirmLabel="删除预设"
        destructive
        onConfirm={remove}
      />
    </SettingsEditor>
  );
}
