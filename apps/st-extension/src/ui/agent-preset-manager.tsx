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
import { useRef, useState } from "react";
import { PROPOSAL_AGENT_BASE_INSTRUCTIONS } from "@ste-memory/core/memory/agent";
import type { PluginSettings } from "../settings/plugin-settings.ts";
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
} from "../agent-presets/preset-model.ts";
import {
  AGENT_PRESET_PLACEHOLDERS,
  AGENT_PRESET_PLACEHOLDER_HINTS,
  type AgentPresetPlaceholderName,
} from "../agent-presets/preset-composer.ts";
import {
  EMPTY_PREVIEW_SNAPSHOT,
  buildAgentPresetPreviewItems,
  type AgentPresetPreviewData,
  type AgentPresetPreviewItem,
  type AgentPresetPreviewPorts,
  type PreviewWorldbookState,
} from "../agent-presets/preset-preview-model.ts";
import { copyText, createUiId, reportError, reportSuccess, reportWarning } from "./ui-helpers.tsx";
import { PreviewModal } from "./preview-modal.tsx";

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
  readonly settings: PluginSettings;
  /** 宿主写 settings 并更新面板状态（SettingsTab 包一层 runtime.settings.write） */
  readonly onChange: (settings: PluginSettings) => void;
  /** 预设预览展开数据端口（issue 01）：点击「预览」时即时构建 ST 上下文/digest/世界书扫描 */
  readonly presetPreview: AgentPresetPreviewPorts;
}) {
  const agentPresets = props.settings.agentPresets;
  const activeId = agentPresets.activePresetId;
  const activePreset = agentPresets.presets.find((p) => p.id === activeId);
  const [expandedMessageId, setExpandedMessageId] = useState<string | undefined>(undefined);
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
    props.onChange({ ...props.settings, agentPresets: mutate(agentPresets) });
  }

  function selectPreset(presetId: string): void {
    apply((presets) => setActiveAgentPreset(presets, presetId));
  }

  function createNew(): void {
    const name = window.prompt("预设名称", "我的预设");
    if (name === null) return;
    apply((presets) => createAgentPreset(presets, name.trim() || "未命名预设", createUiId));
  }

  function duplicateCurrent(): void {
    if (!activePreset) return;
    apply((presets) => duplicateAgentPreset(presets, activePreset.id, createUiId));
  }

  /** 复制系统默认（虚拟预设）为自定义：基础指令消息 + {{tablesDigest}} 摘要消息 */
  function copyBuiltinAsCustom(): void {
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
    if (!activePreset) return;
    if (!window.confirm(`删除预设「${activePreset.name}」？删除后不可恢复。`)) return;
    apply((presets) => deleteAgentPreset(presets, activePreset.id));
  }

  async function exportCurrent(): Promise<void> {
    if (!activePreset) return;
    const text = serializeAgentPresetExport(activePreset, new Date().toISOString());
    downloadTextFile(text, `agent-preset-${sanitizeFilename(activePreset.name)}.json`);
    reportSuccess(`已导出预设「${activePreset.name}」`);
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
    reportSuccess(`已导入预设「${imported.name}」并设为当前`);
  }

  async function copyCurrentText(): Promise<void> {
    if (!activePreset) return;
    const text = presetPromptText(activePreset);
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
    if (!activePreset) return;
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
  const previewItems = activePreset
    ? buildAgentPresetPreviewItems({
        preset: activePreset,
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
    if (!activePreset) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromIndex = activePreset.messages.findIndex((m) => m.id === active.id);
    const toIndex = activePreset.messages.findIndex((m) => m.id === over.id);
    if (fromIndex < 0 || toIndex < 0) return;
    apply((presets) =>
      moveAgentPresetMessage(presets, activePreset.id, String(active.id), toIndex),
    );
  }

  const digestMissing = activePreset !== undefined && !containsDigestReference(activePreset);

  return (
    <div className="stm-setting-group" data-stm-section="agent-presets">
      <div className="stm-setting-group-title">Agent 提示词预设</div>
      <div className="stm-setting-row">
        <div className="stm-setting-label">
          <div className="stm-setting-name">当前预设</div>
          <div className="stm-setting-hint">
            填表任务触发时使用；占位符展开当前对话与记忆空间信息
          </div>
        </div>
        <div className="stm-preset-list" data-stm-field="preset-list">
          <PresetRow
            name="系统默认"
            active={activeId === BUILTIN_AGENT_PRESET_ID}
            builtin
            onSelect={() => selectPreset(BUILTIN_AGENT_PRESET_ID)}
          />
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onPresetDragEnd}
          >
            <SortableContext
              items={agentPresets.presets.map((p) => p.id)}
              strategy={verticalListSortingStrategy}
            >
              {agentPresets.presets.map((preset) => (
                <SortablePresetRow
                  key={preset.id}
                  preset={preset}
                  active={activeId === preset.id}
                  onSelect={() => selectPreset(preset.id)}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      </div>
      <div className="stm-setting-actions">
        <button
          type="button"
          className="stm-button"
          data-action="create-preset"
          onClick={createNew}
        >
          新建
        </button>
        <button
          type="button"
          className="stm-button"
          data-action="duplicate-preset"
          disabled={!activePreset}
          onClick={duplicateCurrent}
        >
          复制
        </button>
        <button
          type="button"
          className="stm-button"
          data-action="delete-preset"
          disabled={!activePreset}
          onClick={removeCurrent}
        >
          删除
        </button>
        <button
          type="button"
          className="stm-button"
          data-action="export-preset"
          disabled={!activePreset}
          onClick={() => void exportCurrent()}
        >
          导出
        </button>
        <button
          type="button"
          className="stm-button"
          data-action="import-preset"
          onClick={() => importInputRef.current?.click()}
        >
          导入
        </button>
      </div>
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importFile(file);
          event.target.value = "";
        }}
      />
      {activePreset === undefined ? (
        <div className="stm-preset-builtin" data-stm-section="builtin-preset">
          <div className="stm-preset-builtin-text">
            系统默认预设 = 未配置时的系统提示词：工作流指令 + 表/字段摘要（{"{{tablesDigest}}"}）。
            只读锚点，不可修改；需要调整时先复制为自定义。
          </div>
          <button
            type="button"
            className="stm-button"
            data-action="copy-builtin-preset"
            onClick={copyBuiltinAsCustom}
          >
            复制为自定义
          </button>
        </div>
      ) : (
        <div className="stm-preset-editor" data-stm-section="preset-editor">
          <div className="stm-setting-row">
            <label className="stm-setting-name">
              <input
                type="text"
                className="stm-input"
                data-stm-field="preset-name"
                value={activePreset.name}
                placeholder="预设名称"
                onChange={(event) => {
                  const name = event.target.value;
                  apply((presets) => renameAgentPreset(presets, activePreset.id, name));
                }}
              />
            </label>
            <button
              type="button"
              className="stm-button"
              data-action="copy-preset-text"
              onClick={() => void copyCurrentText()}
            >
              复制全文
            </button>
            <button
              type="button"
              className="stm-button"
              data-action="preview-preset"
              onClick={togglePreview}
              title="预览活动预设按编排形态展开后的最终消息（点击时读取当前时刻上下文）"
            >
              {previewOpen ? "收起预览" : "预览"}
            </button>
          </div>
          {previewOpen && (
            <AgentPresetPreviewDialog
              presetName={activePreset.name}
              items={previewItems}
              loading={previewLoading}
              error={previewError}
              previewText={previewText}
              onPreviewTextChange={setPreviewText}
              onRefresh={() => void loadPreview()}
              onClose={() => setPreviewOpen(false)}
            />
          )}
          {digestMissing && (
            <div className="stm-preset-warning" data-stm-field="digest-warning">
              当前预设未引用 {"{{tablesDigest}}"} 或 {"{{systemDefaultPrompt}}"}：Agent
              将失去表/字段摘要， 工具可用性下降。可点击下方占位符插入。
            </div>
          )}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext
              items={activePreset.messages.map((m) => m.id)}
              strategy={verticalListSortingStrategy}
            >
              {activePreset.messages.map((message, index) => (
                <MessageCard
                  key={message.id}
                  message={message}
                  index={index}
                  expanded={expandedMessageId === message.id}
                  onToggleExpand={() =>
                    setExpandedMessageId((current) =>
                      current === message.id ? undefined : message.id,
                    )
                  }
                  onUpdate={(patch) =>
                    apply((presets) =>
                      updateAgentPresetMessage(presets, activePreset.id, message.id, patch),
                    )
                  }
                  onRemove={() =>
                    apply((presets) =>
                      removeAgentPresetMessage(presets, activePreset.id, message.id),
                    )
                  }
                />
              ))}
            </SortableContext>
          </DndContext>
          <button
            type="button"
            className="stm-button stm-preset-add-fragment"
            data-action="add-message"
            onClick={() =>
              apply((presets) => addAgentPresetMessage(presets, activePreset.id, createUiId))
            }
          >
            + 添加消息
          </button>
        </div>
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

/** 消息卡片：拖拽手柄 + 开关 + 角色标签 + 名称 + 内容预览（点击展开编辑 + 占位符插入） */
function MessageCard(props: {
  readonly message: AgentPresetMessage;
  readonly index: number;
  readonly expanded: boolean;
  readonly onToggleExpand: () => void;
  readonly onUpdate: (
    patch: Partial<Pick<AgentPresetMessage, "name" | "role" | "content" | "enabled">>,
  ) => void;
  readonly onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.message.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const preview = props.message.name || props.message.content.split("\n")[0] || "未命名消息";

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`stm-preset-fragment${isDragging ? " stm-preset-fragment--dragging" : ""}`}
      data-stm-field={`message-${props.message.id}`}
    >
      <div className="stm-preset-fragment-head">
        <span
          className="stm-preset-fragment-drag"
          aria-label="拖动排序"
          data-action="drag-message"
          {...attributes}
          {...listeners}
        >
          ⠿
        </span>
        <label className="stm-switch">
          <input
            type="checkbox"
            data-stm-field={`message-enabled-${props.message.id}`}
            checked={props.message.enabled}
            onChange={(event) => props.onUpdate({ enabled: event.target.checked })}
          />
          <span className="stm-switch-track" aria-hidden="true"></span>
        </label>
        <button
          type="button"
          className="stm-preset-fragment-title"
          data-action="toggle-message"
          onClick={props.onToggleExpand}
          title={props.expanded ? "收起" : "展开编辑"}
        >
          <span className={`stm-preset-fragment-index stm-mono`}>{props.index + 1}</span>
          <span
            className={`stm-preset-role-tag stm-preset-role-tag--${props.message.role}`}
            data-stm-field={`message-role-${props.message.id}`}
          >
            {AGENT_PRESET_ROLE_LABELS[props.message.role]}
          </span>
          <span className="stm-preset-fragment-preview">{preview}</span>
        </button>
        <button
          type="button"
          className="stm-preset-fragment-remove"
          data-action="remove-message"
          onClick={props.onRemove}
          title="删除消息"
        >
          ✕
        </button>
      </div>
      {props.expanded && (
        <div className="stm-preset-fragment-body">
          <div className="stm-preset-fragment-fields">
            <input
              type="text"
              className="stm-input"
              data-stm-field={`message-name-${props.message.id}`}
              value={props.message.name}
              placeholder="消息名（可选，空则显示内容首行）"
              onChange={(event) => props.onUpdate({ name: event.target.value })}
            />
            <select
              className="stm-input stm-preset-role-select"
              data-stm-field={`message-role-select-${props.message.id}`}
              value={props.message.role}
              title="消息角色：System 合并进系统提示词；User/Assistant 作为对话消息"
              onChange={(event) => props.onUpdate({ role: event.target.value as AgentPresetRole })}
            >
              {AGENT_PRESET_ROLES.map((role) => (
                <option key={role} value={role}>
                  {AGENT_PRESET_ROLE_LABELS[role]}
                </option>
              ))}
            </select>
          </div>
          <textarea
            className="stm-textarea"
            data-stm-field={`message-content-${props.message.id}`}
            value={props.message.content}
            placeholder="消息内容：提示词文本，可插入占位符"
            rows={6}
            onChange={(event) => props.onUpdate({ content: event.target.value })}
          />
          <div className="stm-preset-placeholders">
            <span className="stm-preset-placeholders-label">占位符：</span>
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
                onClick={() => props.onUpdate({ content: props.message.content + placeholder })}
              >
                {placeholder}
              </button>
            ))}
          </div>
        </div>
      )}
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
        <button
          type="button"
          className="stm-button"
          data-action="refresh-preset-preview"
          onClick={props.onRefresh}
          disabled={props.loading}
        >
          重新展开
        </button>
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
        <button
          type="button"
          className="stm-button stm-preset-preview-copy"
          data-action="copy-preset-preview-message"
          onClick={() => void copy()}
        >
          复制
        </button>
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
