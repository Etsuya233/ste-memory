import { FormField, Button, Input, Select, Switch } from "../kit/controls.tsx";
import { ListGroup, NavigationRow } from "../kit/list.tsx";
/**
 * Agent 提示词预设管理器（ticket 17 / ADR 0006 + 消息编排扩展）：设置 Tab 的
 * 「Agent 提示词预设」区块。
 *
 * 纯展示层：所有状态变更走 preset-model 纯函数 → onChange(nextSettings)（宿主写 settings）。
 * 结构：
 * - 预设选择行（下拉 = 系统默认 + 用户预设）+ 操作按钮（新建/复制/删除/导入/导出）；
 * - 编辑区：系统默认 = 只读视图 + 「复制为自定义」；自定义预设 = 消息卡片列表
 *   （开关 + dnd-kit 拖拽排序 + 名称 + 角色（system/user/assistant）+ 展开编辑内容
 *   + 占位符插入 chips + 删除）；
 * - 当前预设未引用 {{tablesDigest}}/{{systemDefaultPrompt}} 时编辑区常驻提示。
 */
import { SettingsActionMenu } from "./settings-action-menu.tsx";
import { Disclosure } from "../shell/disclosure.tsx";
import { PageChrome } from "../shell/page-layout.tsx";
import { PanelBar, PanelBarAction } from "../shell/panel-bar.tsx";
import { useSettingsPageNavigation } from "./settings-page-navigation.ts";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useId, useRef, useState } from "react";
import { PROPOSAL_AGENT_BASE_INSTRUCTIONS } from "../../features/agent/index.ts";
import type { PluginSettings } from "../../features/settings/plugin-settings.ts";
import {
  AGENT_PRESET_ROLES,
  BUILTIN_AGENT_PRESET_ID,
  addAgentPresetMessage,
  containsDigestReference,
  createAgentPreset,
  deleteAgentPreset,
  duplicateAgentPreset,
  importAgentPreset,
  moveAgentPreset,
  moveAgentPresetMessage,
  parseAgentPresetExport,
  presetPromptText,
  removeAgentPresetMessage,
  renameAgentPreset,
  serializeAgentPresetExport,
  setActiveAgentPreset,
  updateAgentPresetMessage,
  type AgentPresetRole,
  type AgentPresetSettings,
  type AgentPresetMessage,
  type AgentPromptPreset,
} from "../../features/agent-presets/preset-model.ts";
import {
  AGENT_PRESET_PLACEHOLDERS,
  AGENT_PRESET_PLACEHOLDER_HINTS,
  type AgentPresetPlaceholderName,
} from "../../features/agent-presets/preset-composer.ts";
import {
  EMPTY_PREVIEW_SNAPSHOT,
  buildAgentPresetPreviewItems,
  type AgentPresetPreviewData,
  type AgentPresetPreviewItem,
  type AgentPresetPreviewPorts,
  type PreviewWorldbookState,
} from "../../features/agent-presets/preset-preview-model.ts";
import {
  copyText,
  createUiId,
  reportError,
  reportSuccess,
  reportWarning,
} from "../shell/ui-helpers.tsx";
import { PreviewModal } from "../memory/preview-modal.tsx";

/** 角色显示名（编辑器角色下拉 + 卡片预览标签共用） */
export const AGENT_PRESET_ROLE_LABELS: Record<AgentPresetRole, string> = {
  system: "System",
  user: "User",
  assistant: "Assistant",
};

/** 下载文本文件（导出预设 JSON） */
function downloadTextFile(text: string, filename: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "agent-preset";
}

export function AgentPresetManager(props: {
  readonly onBack?: () => void;
  readonly registerLeaveGuard?: (guard: (() => boolean) | null) => void;
  readonly onEditingChange?: (editing: boolean) => void;
  readonly settings: PluginSettings;
  /** 宿主写 settings 并更新面板状态（SettingsTab 包一层 runtime.settings.write） */
  readonly onChange: (settings: PluginSettings) => void;
  /** 预设预览展开数据端口（issue 01）：点击「预览」时即时构建 ST 上下文/digest/世界书扫描 */
  readonly presetPreview: AgentPresetPreviewPorts;
}) {
  const agentPresets = props.settings.agentPresets;
  const activeId = agentPresets.activePresetId;
  const [detailPresetId, setDetailPresetId] = useState(BUILTIN_AGENT_PRESET_ID);
  const detailPreset = agentPresets.presets.find((p) => p.id === detailPresetId);
  const [expandedMessageId, setExpandedMessageId] = useState<string | undefined>(undefined);
  const [detailOpen, setDetailOpen] = useState(false);
  const [messageDraft, setMessageDraft] = useState<AgentPresetMessage | null>(null);
  const [pendingMessage, setPendingMessage] = useState(false);
  const initialMessageDraft = useRef("");
  const [renaming, setRenaming] = useState(false);
  const initialPresetName = useRef("我的预设");
  const [creatingName, setCreatingName] = useState<string | null>(null);
  const createFormId = useId();
  const creationDirty = useRef(false);
  creationDirty.current =
    (creatingName !== null && creatingName !== initialPresetName.current) ||
    (messageDraft !== null && JSON.stringify(messageDraft) !== initialMessageDraft.current);
  useEffect(() => {
    props.registerLeaveGuard?.(
      () => !creationDirty.current || window.confirm("有未保存的修改，放弃并离开吗？"),
    );
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (creationDirty.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      props.registerLeaveGuard?.(null);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [props.registerLeaveGuard]);
  const { screenRef, rememberScroll } = useSettingsPageNavigation(
    creatingName !== null
      ? "new:preset"
      : expandedMessageId
        ? `edit:message:${expandedMessageId}`
        : detailOpen
          ? `detail:${detailPresetId}`
          : "list",
  );
  const chrome = props.onBack !== undefined;
  useEffect(() => {
    props.onEditingChange?.(chrome);
    return () => props.onEditingChange?.(false);
  }, [chrome, props.onEditingChange]);
  function back() {
    rememberScroll();
    if (creatingName !== null) {
      if (!creationDirty.current || window.confirm("预设名称尚未保存，放弃并返回吗？"))
        setCreatingName(null);
    } else if (messageDraft) {
      if (!creationDirty.current || window.confirm("消息有未保存的修改，放弃并返回吗？")) {
        setMessageDraft(null);
        setExpandedMessageId(undefined);
      }
    } else if (detailOpen) setDetailOpen(false);
    else props.onBack?.();
  }
  function openPreset(id: string) {
    rememberScroll();
    setDetailPresetId(id);
    setDetailOpen(true);
  }

  // ---- 预设预览（issue 01）：预览展开数据在点击时即时构建，纯逻辑在 preset-preview-model ----
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewText, setPreviewText] = useState("");
  const [previewData, setPreviewData] = useState<AgentPresetPreviewData | undefined>(undefined);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | undefined>(undefined);
  const importInputRef = useRef<HTMLInputElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  /** 变更入口：mutate 预设设置 → 宿主写 settings */
  function apply(mutate: (presets: AgentPresetSettings) => AgentPresetSettings): void {
    const next = mutate(agentPresets);
    if (next.activePresetId !== agentPresets.activePresetId) setDetailPresetId(next.activePresetId);
    props.onChange({ ...props.settings, agentPresets: next });
  }

  function selectPreset(presetId: string): void {
    apply((presets) => setActiveAgentPreset(presets, presetId));
  }

  function createNew(): void {
    rememberScroll();
    initialPresetName.current = "我的预设";
    setRenaming(false);
    setCreatingName("我的预设");
  }
  function saveNewPreset() {
    if (!creatingName?.trim()) return;
    try {
      apply((presets) =>
        renaming
          ? renameAgentPreset(presets, detailPreset!.id, creatingName.trim())
          : createAgentPreset(presets, creatingName.trim(), createUiId),
      );
      rememberScroll();
      setCreatingName(null);
      setDetailOpen(true);
    } catch (error) {
      reportError(error);
    }
  }

  function duplicateCurrent(): void {
    if (!detailPreset) return;
    apply((presets) => duplicateAgentPreset(presets, detailPreset.id, createUiId));
    setDetailOpen(true);
  }

  /** 复制系统默认（虚拟预设）为自定义：基础指令消息 + {{tablesDigest}} 摘要消息 */
  function copyBuiltinAsCustom(): void {
    rememberScroll();
    setDetailOpen(true);
    apply((presets) => {
      let next = createAgentPreset(presets, "系统默认 (副本)", createUiId);
      const created = next.presets[next.presets.length - 1]!;
      next = updateAgentPresetMessage(next, created.id, created.messages[0]!.id, {
        name: "系统默认指令",
        content: PROPOSAL_AGENT_BASE_INSTRUCTIONS,
      });
      next = addAgentPresetMessage(next, created.id, createUiId);
      const digestMessage = next.presets[next.presets.length - 1]!.messages[1]!;
      next = updateAgentPresetMessage(next, created.id, digestMessage.id, {
        name: "表格摘要",
        content: AGENT_PRESET_PLACEHOLDERS.tablesDigest,
      });
      return next;
    });
  }

  function removeCurrent(): void {
    if (!detailPreset) return;
    if (!window.confirm(`删除预设「${detailPreset.name}」？删除后不可恢复。`)) return;
    apply((presets) => deleteAgentPreset(presets, detailPreset.id));
    setDetailOpen(false);
    setExpandedMessageId(undefined);
  }

  async function exportCurrent(): Promise<void> {
    if (!detailPreset) return;
    const text = serializeAgentPresetExport(detailPreset, new Date().toISOString());
    downloadTextFile(text, `agent-preset-${sanitizeFilename(detailPreset.name)}.json`);
    reportSuccess(`已导出预设「${detailPreset.name}」`);
  }

  async function importFile(file: File): Promise<void> {
    let text: string;
    try {
      text = await file.text();
    } catch (error) {
      reportError(error);
      return;
    }
    let imported;
    try {
      imported = parseAgentPresetExport(text);
    } catch (error) {
      reportError(error);
      return;
    }
    apply((presets) => importAgentPreset(presets, imported));
    rememberScroll();
    setDetailOpen(true);
    reportSuccess(`已导入预设「${imported.name}」并设为当前`);
  }

  async function copyCurrentText(): Promise<void> {
    if (!detailPreset) return;
    const text = presetPromptText(detailPreset);
    const ok = await copyText(text);
    if (ok) reportSuccess("已复制预设全文到剪贴板");
    else reportWarning("复制失败：浏览器不支持剪贴板写入");
  }

  // ---- 预设预览（issue 01）----

  function togglePreview(): void {
    if (previewOpen) {
      setPreviewOpen(false);
      return;
    }
    setPreviewOpen(true);
    void loadPreview();
  }

  /**
   * 即时构建展开数据：ST 上下文快照（对话双方名字/角色卡/Persona）+ 活动空间摘要
   * （digest）+ 世界书扫描（预览输入文本；输入为空 → 不扫描，标注）。
   */
  async function loadPreview(): Promise<void> {
    if (!detailPreset) return;
    setPreviewLoading(true);
    setPreviewError(undefined);
    try {
      const snapshotBase = props.presetPreview.getPromptSnapshot();
      const spaceId = props.presetPreview.readSpaceId();
      const digest =
        spaceId === undefined ? undefined : await props.presetPreview.readDigest(spaceId);
      let worldbookText = "";
      let worldbookState: PreviewWorldbookState = "skipped";
      if (previewText.trim() !== "") {
        const scan = await props.presetPreview.scanWorldbook(previewText);
        worldbookText = scan.text;
        worldbookState = scan.status;
      }
      setPreviewData({
        snapshot: { ...snapshotBase, msgText: previewText, worldbookText },
        digest,
        worldbookState,
      });
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreviewLoading(false);
    }
  }

  /** 预览条目：编辑预设消息/切换预设后随渲染即时重算（展开数据为最近一次构建） */
  const previewItems = detailPreset
    ? buildAgentPresetPreviewItems({
        preset: detailPreset,
        snapshot: previewData?.snapshot ?? EMPTY_PREVIEW_SNAPSHOT,
        digest: previewData?.digest,
        worldbookState: previewData?.worldbookState ?? "skipped",
      })
    : [];

  function onPresetDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromIndex = agentPresets.presets.findIndex((p) => p.id === active.id);
    const toIndex = agentPresets.presets.findIndex((p) => p.id === over.id);
    if (fromIndex < 0 || toIndex < 0) return;
    apply((presets) => moveAgentPreset(presets, String(active.id), toIndex));
  }

  function onDragEnd(event: DragEndEvent): void {
    if (!detailPreset) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromIndex = detailPreset.messages.findIndex((m) => m.id === active.id);
    const toIndex = detailPreset.messages.findIndex((m) => m.id === over.id);
    if (fromIndex < 0 || toIndex < 0) return;
    apply((presets) =>
      moveAgentPresetMessage(presets, detailPreset.id, String(active.id), toIndex),
    );
  }

  const digestMissing = detailPreset !== undefined && !containsDigestReference(detailPreset);

  const message = messageDraft;
  function updateMessage(
    patch: Partial<Pick<AgentPresetMessage, "name" | "role" | "content" | "enabled">>,
  ) {
    setMessageDraft({ ...message!, ...patch });
  }
  function beginMessage(value: AgentPresetMessage, pending = false) {
    rememberScroll();
    setPendingMessage(pending);
    setExpandedMessageId(value.id);
    setMessageDraft({ ...value });
    initialMessageDraft.current = JSON.stringify(value);
  }
  function addMessage() {
    beginMessage(
      { id: createUiId(), name: "新消息", role: "system", content: "", enabled: true },
      true,
    );
  }
  function saveMessage() {
    try {
      apply((presets) => {
        const next = pendingMessage
          ? addAgentPresetMessage(presets, detailPreset!.id, () => message!.id)
          : presets;
        return updateAgentPresetMessage(next, detailPreset!.id, message!.id, message!);
      });
      rememberScroll();
      setMessageDraft(null);
      setExpandedMessageId(undefined);
    } catch (error) {
      reportError(error);
    }
  }
  return (
    <div ref={screenRef} className="stm-settings-detail-page" data-stm-section="agent-presets">
      {props.onBack && (
        <PageChrome
          pageKey={
            creatingName !== null
              ? "preset-name"
              : message
                ? message.id
                : detailOpen
                  ? "detail"
                  : "list"
          }
          header={
            <PanelBar
              title={
                creatingName !== null
                  ? renaming
                    ? "预设名称"
                    : "新建 Agent 预设"
                  : message
                    ? message.name || "编辑消息"
                    : detailOpen
                      ? (detailPreset?.name ?? "系统默认")
                      : "Agent 提示词预设"
              }
              subtitle={
                creatingName !== null
                  ? undefined
                  : message
                    ? "保存后生效"
                    : detailOpen
                      ? detailPresetId === activeId
                        ? "当前使用"
                        : "未启用"
                      : undefined
              }
              leading={
                <PanelBarAction
                  icon="fa-arrow-left"
                  label={
                    creatingName !== null
                      ? renaming
                        ? "取消修改"
                        : "取消新建"
                      : message
                        ? "返回预设消息"
                        : detailOpen
                          ? "返回预设列表"
                          : "返回设置"
                  }
                  data-action={
                    creatingName !== null
                      ? "cancel-agent-preset"
                      : message
                        ? "back-agent-message"
                        : detailOpen
                          ? "back-agent-presets"
                          : "settings-back"
                  }
                  onClick={back}
                />
              }
              trailing={
                creatingName !== null ? (
                  <PanelBarAction
                    icon="fa-check"
                    label={renaming ? "保存名称" : "创建预设"}
                    data-action="save-agent-preset"
                    type="submit"
                    form={createFormId}
                    disabled={!creatingName.trim()}
                  />
                ) : message ? (
                  <>
                    {!pendingMessage && (
                      <PanelBarAction
                        icon="fa-trash"
                        label="删除消息"
                        data-action="remove-message"
                        danger
                        onClick={() => {
                          if (window.confirm(`删除消息「${message.name || "未命名消息"}」？`)) {
                            apply((presets) =>
                              removeAgentPresetMessage(presets, detailPreset!.id, message.id),
                            );
                            setMessageDraft(null);
                            setExpandedMessageId(undefined);
                          }
                        }}
                      />
                    )}
                    <PanelBarAction
                      icon="fa-check"
                      label="保存消息"
                      data-action="save-agent-message"
                      onClick={saveMessage}
                    />
                  </>
                ) : detailOpen ? (
                  detailPreset ? (
                    <>
                      <PanelBarAction
                        icon="fa-eye"
                        label="预览预设"
                        data-action="preview-preset"
                        onClick={togglePreview}
                      />
                      <SettingsActionMenu
                        actions={[
                          {
                            label: "预设名称",
                            dataAction: "rename-agent-preset",
                            onSelect: () => {
                              rememberScroll();
                              initialPresetName.current = detailPreset.name;
                              setRenaming(true);
                              setCreatingName(detailPreset.name);
                            },
                          },
                          {
                            label: "复制全文",
                            dataAction: "copy-preset-text",
                            onSelect: () => void copyCurrentText(),
                          },
                          {
                            label: "导出",
                            dataAction: "export-preset",
                            onSelect: () => void exportCurrent(),
                          },
                          {
                            label: "复制为新预设",
                            dataAction: "duplicate-preset",
                            onSelect: duplicateCurrent,
                          },
                          {
                            label: "删除预设",
                            dataAction: "delete-preset",
                            danger: true,
                            onSelect: removeCurrent,
                          },
                        ]}
                      />
                      <PanelBarAction
                        icon="fa-plus"
                        label="添加消息"
                        data-action="add-message"
                        onClick={addMessage}
                      />
                    </>
                  ) : (
                    <PanelBarAction
                      icon="fa-copy"
                      label="复制为自定义"
                      data-action="copy-builtin-preset"
                      onClick={copyBuiltinAsCustom}
                    />
                  )
                ) : (
                  <>
                    <PanelBarAction
                      icon="fa-file-import"
                      label="导入预设"
                      data-action="import-preset"
                      onClick={() => importInputRef.current!.click()}
                    />
                    <PanelBarAction
                      icon="fa-plus"
                      label="新建预设"
                      data-action="create-preset"
                      onClick={createNew}
                    />
                  </>
                )
              }
            />
          }
        />
      )}
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importFile(file);
          event.target.value = "";
        }}
      />
      {creatingName !== null ? (
        <form
          id={createFormId}
          className="stm-settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            saveNewPreset();
          }}
        >
          <FormField className="stm-form-row" label={<>预设名称</>}>
            {(field) => (
              <Input
                {...field}

                data-stm-field="new-agent-preset-name"
                value={creatingName}
                required
                autoFocus
                onChange={(event) => setCreatingName(event.target.value)}
              />
            )}
          </FormField>
          {!props.onBack && (
            <Button type="submit" data-action="save-agent-preset">
              创建预设
            </Button>
          )}
        </form>
      ) : message ? (
        <div data-stm-section="agent-message-editor">
          <FormField className="stm-form-row" label={<>消息名称</>}>
            {(field) => (
              <Input
                {...field}

                aria-label="消息名称"
                data-stm-field={`message-name-${message.id}`}
                value={message.name}
                onChange={(event) => updateMessage({ name: event.target.value })}
              />
            )}
          </FormField>
          <label className="stm-form-row">
            <span className="stm-form-label">消息角色</span>
            <Select
              aria-label="消息角色"
              data-stm-field={`message-role-select-${message.id}`}
              value={message.role}
              onChange={(event) => updateMessage({ role: event.target.value as AgentPresetRole })}
            >
              {AGENT_PRESET_ROLES.map((role) => (
                <option key={role} value={role}>
                  {AGENT_PRESET_ROLE_LABELS[role]}
                </option>
              ))}
            </Select>
          </label>
          <label className="stm-form-row">
            <span className="stm-form-label">消息内容</span>
            <textarea
              className="stm-textarea"
              rows={10}
              aria-label="消息内容"
              data-stm-field={`message-content-${message.id}`}
              value={message.content}
              onChange={(event) => updateMessage({ content: event.target.value })}
            />
          </label>
          <Disclosure icon="fa-code" title="插入占位符">
            <div className="stm-preset-placeholders">
              {(
                Object.entries(AGENT_PRESET_PLACEHOLDERS) as Array<
                  [AgentPresetPlaceholderName, string]
                >
              ).map(([name, placeholder]) => (
                <button
                  key={placeholder}
                  type="button"
                  className="stm-chip"
                  title={AGENT_PRESET_PLACEHOLDER_HINTS[name]}
                  data-action="insert-placeholder"
                  data-placeholder={placeholder}
                  onClick={() => updateMessage({ content: message.content + placeholder })}
                >
                  {placeholder}
                </button>
              ))}
            </div>
          </Disclosure>
        </div>
      ) : detailOpen ? (
        detailPreset ? (
          <>
            {detailPresetId !== activeId && (
              <Button
                type="button"

                data-action="activate-agent-preset"
                disabled={detailPresetId === activeId}
                onClick={() => selectPreset(detailPresetId)}
              >
                {detailPresetId === activeId ? "当前使用" : "设为当前预设"}
              </Button>
            )}
            {digestMissing && (
              <div className="stm-preset-warning" data-stm-field="digest-warning">
                缺少表格摘要占位符，Agent 无法读取表与字段说明。
              </div>
            )}
            <ListGroup as="ul" className="stm-settings-item-list">
              {detailPreset.messages.map((item, index) => (
                <li key={item.id} className="stm-settings-item-with-toggle">
                  <NavigationRow
                    data-action="toggle-message"
                    onClick={() => beginMessage(item)}
                    title={item.name || `消息 ${index + 1}`}
                    description=<>
                      {AGENT_PRESET_ROLE_LABELS[item.role]} ·{" "}
                      {item.content.split("\n")[0] || "空内容"}
                    </>
                  />
                  <Switch
                    aria-label={`启用消息 ${index + 1}`}
                    checked={item.enabled}
                    onChange={(event) =>
                      apply((presets) =>
                        updateAgentPresetMessage(presets, detailPreset.id, item.id, {
                          enabled: event.target.checked,
                        }),
                      )
                    }
                  />
                </li>
              ))}
            </ListGroup>
            <Disclosure icon="fa-arrows-up-down" title="消息顺序">
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={onDragEnd}
              >
                <SortableContext
                  items={detailPreset.messages.map((item) => item.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {detailPreset.messages.map((item) => (
                    <SortableMessageRow key={item.id} message={item} />
                  ))}
                </SortableContext>
              </DndContext>
            </Disclosure>
          </>
        ) : (
          <div data-stm-section="builtin-preset">
            {activeId !== BUILTIN_AGENT_PRESET_ID && (
              <Button
                type="button"

                data-action="activate-agent-preset"
                disabled={activeId === BUILTIN_AGENT_PRESET_ID}
                onClick={() => selectPreset(BUILTIN_AGENT_PRESET_ID)}
              >
                {activeId === BUILTIN_AGENT_PRESET_ID ? "当前使用" : "设为当前预设"}
              </Button>
            )}
            <p className="stm-setting-hint">系统默认预设 · 工作流指令与表格摘要 · 只读</p>
            {!props.onBack && (
              <Button
                type="button"

                data-action="copy-builtin-preset"
                onClick={copyBuiltinAsCustom}
              >
                复制为自定义
              </Button>
            )}
            <Disclosure icon="fa-eye" title="系统指令">
              <pre className="stm-modal-text">{PROPOSAL_AGENT_BASE_INSTRUCTIONS}</pre>
            </Disclosure>
          </div>
        )
      ) : (
        <>
          <ListGroup as="ul" className="stm-settings-item-list">
            <li>
              <NavigationRow
                data-action="select-agent-preset"
                data-preset-id={BUILTIN_AGENT_PRESET_ID}
                onClick={() => openPreset(BUILTIN_AGENT_PRESET_ID)}
                title=<>系统默认</>
                description=<>内置{activeId === BUILTIN_AGENT_PRESET_ID ? " · 当前使用" : ""}</>
              />
            </li>
            {agentPresets.presets.map((preset) => (
              <li key={preset.id}>
                <NavigationRow
                  data-action="select-agent-preset"
                  data-preset-id={preset.id}
                  onClick={() => openPreset(preset.id)}
                  title={preset.name}
                  description=<>
                    {preset.messages.length} 条消息{preset.id === activeId ? " · 当前使用" : ""}
                  </>
                />
              </li>
            ))}
          </ListGroup>
          {!props.onBack && (
            <div className="stm-setting-actions">
              <Button
                type="button"

                data-action="create-preset"
                onClick={createNew}
              >
                新建预设
              </Button>
              <Button
                type="button"

                data-action="import-preset"
                onClick={() => importInputRef.current!.click()}
              >
                导入
              </Button>
            </div>
          )}
          {agentPresets.presets.length > 1 && (
            <Disclosure icon="fa-arrows-up-down" title="预设顺序">
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={onPresetDragEnd}
              >
                <SortableContext
                  items={agentPresets.presets.map((item) => item.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {agentPresets.presets.map((preset) => (
                    <SortablePresetRow
                      key={preset.id}
                      preset={preset}
                      active={activeId === preset.id}
                      onSelect={() => openPreset(preset.id)}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            </Disclosure>
          )}
        </>
      )}
      {previewOpen && detailPreset && (
        <AgentPresetPreviewDialog
          presetName={detailPreset.name}
          items={previewItems}
          loading={previewLoading}
          error={previewError}
          previewText={previewText}
          onPreviewTextChange={setPreviewText}
          onRefresh={() => void loadPreview()}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </div>
  );
}

/** 预设行（系统默认固定行）：点击选中 */
function PresetRow(props: {
  readonly name: string;
  readonly active: boolean;
  readonly builtin?: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`stm-preset-row${props.active ? " stm-preset-row--active" : ""}`}
      data-action="select-agent-preset"
      data-preset-id={props.builtin ? BUILTIN_AGENT_PRESET_ID : undefined}
      onClick={props.onSelect}
      aria-pressed={props.active}
    >
      <span className="stm-preset-row-dot" aria-hidden="true"></span>
      <span className="stm-preset-row-name">{props.name}</span>
      {props.builtin && <span className="stm-preset-row-tag">内置</span>}
    </button>
  );
}

/** 预设行（用户预设）：点击选中 + 拖拽排序 */
function SortablePresetRow(props: {
  readonly preset: AgentPromptPreset;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.preset.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`stm-preset-row-wrap${isDragging ? " stm-preset-row-wrap--dragging" : ""}`}
    >
      <span
        className="stm-preset-row-drag"
        aria-label="拖动排序"
        data-action="drag-preset"
        {...attributes}
        {...listeners}
      >
        ⠿
      </span>
      <PresetRow name={props.preset.name} active={props.active} onSelect={props.onSelect} />
    </div>
  );
}

function SortableMessageRow(props: { readonly message: AgentPresetMessage }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: props.message.id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="stm-settings-order-row"
    >
      <span>{props.message.name || "未命名消息"}</span>
      <button
        type="button"
        className="stm-table-action"
        aria-label={`拖动排序 ${props.message.name}`}
        data-action="drag-message"
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>
    </div>
  );
}

/**
 * 预设预览弹窗（issue 01 UI 改版）：内容 = 原内嵌只读面板（差异提示 + 预览输入
 * 文本 + 「重新展开」+ 按编排形态分组卡片），外层套统一 PreviewModal——底部右侧
 * 「复制（全部展开消息）/ 关闭」；复制全部由 onCopyAll 注入（join 展开文本序列）。
 * 纯展示组件：展开条目由宿主用 buildAgentPresetPreviewItems 构建后传入。
 */
export function AgentPresetPreviewDialog(props: {
  readonly presetName: string;
  readonly items: readonly AgentPresetPreviewItem[];
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly previewText: string;
  readonly onPreviewTextChange: (text: string) => void;
  readonly onRefresh: () => void;
  readonly onClose: () => void;
}) {
  return (
    <PreviewModal
      title={`预览「${props.presetName}」`}
      onCopy={() => {
        const text = props.items.map((item) => item.text).join("\n\n");
        void copyText(text).then((ok) => {
          if (ok) reportSuccess("已复制全部展开消息到剪贴板");
          else reportWarning("复制失败：浏览器不支持剪贴板写入");
        });
      }}
      onClose={props.onClose}
    >
      <AgentPresetPreviewPanel
        items={props.items}
        loading={props.loading}
        error={props.error}
        previewText={props.previewText}
        onPreviewTextChange={props.onPreviewTextChange}
        onRefresh={props.onRefresh}
      />
    </PreviewModal>
  );
}

/**
 * 预设预览面板（issue 01）：只读面板内容区，按编排形态分组展示活动预设展开后的
 * 最终消息（system 合并进系统提示词 / user、assistant 进入对话前缀）。顶部差异
 * 提示一行；输入框文本同时作为 {{msg}} 展开源与世界书扫描输入；「重新展开」用
 * 当前输入即时重建展开数据；卡片 = 角色标签 + 来源预设消息名 + 展开后文本 + 复制。
 * 纯展示组件：展开条目由宿主用 buildAgentPresetPreviewItems 构建后传入。
 */
export function AgentPresetPreviewPanel(props: {
  readonly items: readonly AgentPresetPreviewItem[];
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly previewText: string;
  readonly onPreviewTextChange: (text: string) => void;
  readonly onRefresh: () => void;
}) {
  const systemItems = props.items.filter((item) => item.role === "system");
  const prefixItems = props.items.filter((item) => item.role !== "system");

  return (
    <div className="stm-preset-preview" data-stm-section="preset-preview">
      <div className="stm-preset-preview-hint" data-stm-field="preset-preview-hint">
        预览为当前时刻内容，任务提交时以最新数据重新展开
      </div>
      <label className="stm-setting-label">
        <div className="stm-setting-name">预览输入文本</div>
        <div className="stm-setting-hint">
          同时作为 {"{{msg}}"} 的展开内容与世界书扫描输入；为空时 {"{{msg}}"} 展开空串、
          不执行世界书扫描
        </div>
      </label>
      <textarea
        className="stm-textarea"
        data-stm-field="preset-preview-text"
        value={props.previewText}
        placeholder="输入要模拟的消息内容（可为空）"
        rows={3}
        onChange={(event) => props.onPreviewTextChange(event.target.value)}
      />
      <div className="stm-setting-actions">
        <Button
          type="button"

          data-action="refresh-preset-preview"
          onClick={props.onRefresh}
          disabled={props.loading}
        >
          重新展开
        </Button>
      </div>
      {props.loading && (
        <div className="stm-setting-hint" data-stm-field="preset-preview-loading">
          正在构建展开数据…
        </div>
      )}
      {!props.loading && props.error !== undefined && (
        <div className="stm-preset-warning" data-stm-field="preset-preview-error">
          {props.error}
        </div>
      )}
      {!props.loading && props.error === undefined && (
        <>
          <PreviewGroup title="系统提示词（合并进系统提示词，按预设顺序）" items={systemItems} />
          <PreviewGroup
            title="对话前缀（User / Assistant 按预设顺序进入对话）"
            items={prefixItems}
          />
        </>
      )}
    </div>
  );
}

/** 编排形态分组：组标题 + 组内条目卡片 */
function PreviewGroup(props: {
  readonly title: string;
  readonly items: readonly AgentPresetPreviewItem[];
}) {
  if (props.items.length === 0) return null;
  return (
    <div className="stm-preset-preview-group">
      <div className="stm-preset-preview-group-title">{props.title}</div>
      {props.items.map((item) => (
        <PreviewItemCard key={item.id} item={item} />
      ))}
    </div>
  );
}

/** 预览条目卡片：角色标签 + 来源预设消息名 + 展开后文本（等宽只读）+ 复制 */
function PreviewItemCard(props: { readonly item: AgentPresetPreviewItem }) {
  async function copy(): Promise<void> {
    const ok = await copyText(props.item.text);
    if (ok) reportSuccess("已复制展开消息到剪贴板");
    else reportWarning("复制失败：浏览器不支持剪贴板写入");
  }

  return (
    <div className="stm-preset-preview-card" data-stm-field={`preview-message-${props.item.id}`}>
      <div className="stm-preset-fragment-head">
        <span
          className={`stm-preset-role-tag stm-preset-role-tag--${props.item.role}`}
          data-stm-field="preview-message-role"
        >
          {AGENT_PRESET_ROLE_LABELS[props.item.role]}
        </span>
        <span className="stm-preset-preview-source" title={props.item.sourceName}>
          {props.item.sourceName}
        </span>
        <Button
          type="button"
          className="stm-preset-preview-copy"
          data-action="copy-preset-preview-message"
          onClick={() => void copy()}
        >
          复制
        </Button>
      </div>
      <pre className="stm-preset-preview-text" data-stm-field="preset-preview-text-content">
        {props.item.text}
      </pre>
      {props.item.note !== undefined && (
        <div className="stm-preset-warning" data-stm-field="preset-preview-note">
          {props.item.note}
        </div>
      )}
    </div>
  );
}
