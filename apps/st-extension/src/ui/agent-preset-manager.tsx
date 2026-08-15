/**
 * Agent 提示词预设管理器（ticket 17 / ADR 0006）：设置 Tab 的「Agent 提示词预设」区块。
 *
 * 纯展示层：所有状态变更走 preset-model 纯函数 → onChange(nextSettings)（宿主写 settings）。
 * 结构：
 * - 预设选择行（下拉 = 系统默认 + 用户预设）+ 操作按钮（新建/复制/删除/导入/导出）；
 * - 编辑区：系统默认 = 只读视图 + 「复制为自定义」；自定义预设 = 片段卡片列表
 *   （开关 + dnd-kit 拖拽排序 + 名称 + 展开编辑内容 + 占位符插入 chips + 删除）；
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
  BUILTIN_AGENT_PRESET_ID,
  addAgentPresetFragment,
  containsDigestReference,
  createAgentPreset,
  deleteAgentPreset,
  duplicateAgentPreset,
  importAgentPreset,
  moveAgentPreset,
  moveAgentPresetFragment,
  parseAgentPresetExport,
  presetPromptText,
  removeAgentPresetFragment,
  renameAgentPreset,
  serializeAgentPresetExport,
  setActiveAgentPreset,
  updateAgentPresetFragment,
  type AgentPresetSettings,
  type AgentPromptFragment,
  type AgentPromptPreset,
} from "../agent-presets/preset-model.ts";
import {
  AGENT_PRESET_PLACEHOLDERS,
  AGENT_PRESET_PLACEHOLDER_HINTS,
  type AgentPresetPlaceholderName,
} from "../agent-presets/preset-composer.ts";
import { createUiId, reportError, reportSuccess, reportWarning } from "./ui-helpers.tsx";

/** 复制文本：优先 Clipboard API；非安全上下文降级 textarea + execCommand */
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand("copy");
  textarea.remove();
  return ok;
}

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
}) {
  const agentPresets = props.settings.agentPresets;
  const activeId = agentPresets.activePresetId;
  const activePreset = agentPresets.presets.find((p) => p.id === activeId);
  const [expandedFragmentId, setExpandedFragmentId] = useState<string | undefined>(undefined);
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

  /** 复制系统默认（虚拟预设）为自定义：基础指令片段 + {{tablesDigest}} 摘要片段 */
  function copyBuiltinAsCustom(): void {
    apply((presets) => {
      let next = createAgentPreset(presets, "系统默认 (副本)", createUiId);
      const created = next.presets[next.presets.length - 1]!;
      next = updateAgentPresetFragment(next, created.id, created.fragments[0]!.id, {
        name: "系统默认指令",
        content: PROPOSAL_AGENT_BASE_INSTRUCTIONS,
      });
      next = addAgentPresetFragment(next, created.id, createUiId);
      const digestFragment = next.presets[next.presets.length - 1]!.fragments[1]!;
      next = updateAgentPresetFragment(next, created.id, digestFragment.id, {
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
    const fromIndex = activePreset.fragments.findIndex((f) => f.id === active.id);
    const toIndex = activePreset.fragments.findIndex((f) => f.id === over.id);
    if (fromIndex < 0 || toIndex < 0) return;
    apply((presets) =>
      moveAgentPresetFragment(presets, activePreset.id, String(active.id), toIndex),
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
          </div>
          {digestMissing && (
            <div className="stm-preset-warning" data-stm-field="digest-warning">
              当前预设未引用 {"{{tablesDigest}}"} 或 {"{{systemDefaultPrompt}}"}：Agent
              将失去表/字段摘要， 工具可用性下降。可点击下方占位符插入。
            </div>
          )}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext
              items={activePreset.fragments.map((f) => f.id)}
              strategy={verticalListSortingStrategy}
            >
              {activePreset.fragments.map((fragment, index) => (
                <FragmentCard
                  key={fragment.id}
                  fragment={fragment}
                  index={index}
                  expanded={expandedFragmentId === fragment.id}
                  onToggleExpand={() =>
                    setExpandedFragmentId((current) =>
                      current === fragment.id ? undefined : fragment.id,
                    )
                  }
                  onUpdate={(patch) =>
                    apply((presets) =>
                      updateAgentPresetFragment(presets, activePreset.id, fragment.id, patch),
                    )
                  }
                  onRemove={() =>
                    apply((presets) =>
                      removeAgentPresetFragment(presets, activePreset.id, fragment.id),
                    )
                  }
                />
              ))}
            </SortableContext>
          </DndContext>
          <button
            type="button"
            className="stm-button stm-preset-add-fragment"
            data-action="add-fragment"
            onClick={() =>
              apply((presets) => addAgentPresetFragment(presets, activePreset.id, createUiId))
            }
          >
            + 添加片段
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

/** 片段卡片：拖拽手柄 + 开关 + 名称 + 内容预览（点击展开编辑 + 占位符插入） */
function FragmentCard(props: {
  readonly fragment: AgentPromptFragment;
  readonly index: number;
  readonly expanded: boolean;
  readonly onToggleExpand: () => void;
  readonly onUpdate: (
    patch: Partial<Pick<AgentPromptFragment, "name" | "content" | "enabled">>,
  ) => void;
  readonly onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.fragment.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const preview = props.fragment.name || props.fragment.content.split("\n")[0] || "未命名片段";

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`stm-preset-fragment${isDragging ? " stm-preset-fragment--dragging" : ""}`}
      data-stm-field={`fragment-${props.fragment.id}`}
    >
      <div className="stm-preset-fragment-head">
        <span
          className="stm-preset-fragment-drag"
          aria-label="拖动排序"
          data-action="drag-fragment"
          {...attributes}
          {...listeners}
        >
          ⠿
        </span>
        <label className="stm-switch">
          <input
            type="checkbox"
            data-stm-field={`fragment-enabled-${props.fragment.id}`}
            checked={props.fragment.enabled}
            onChange={(event) => props.onUpdate({ enabled: event.target.checked })}
          />
          <span className="stm-switch-track" aria-hidden="true"></span>
        </label>
        <button
          type="button"
          className="stm-preset-fragment-title"
          data-action="toggle-fragment"
          onClick={props.onToggleExpand}
          title={props.expanded ? "收起" : "展开编辑"}
        >
          <span className={`stm-preset-fragment-index stm-mono`}>{props.index + 1}</span>
          <span className="stm-preset-fragment-preview">{preview}</span>
        </button>
        <button
          type="button"
          className="stm-preset-fragment-remove"
          data-action="remove-fragment"
          onClick={props.onRemove}
          title="删除片段"
        >
          ✕
        </button>
      </div>
      {props.expanded && (
        <div className="stm-preset-fragment-body">
          <input
            type="text"
            className="stm-input"
            data-stm-field={`fragment-name-${props.fragment.id}`}
            value={props.fragment.name}
            placeholder="片段名（可选，空则显示内容首行）"
            onChange={(event) => props.onUpdate({ name: event.target.value })}
          />
          <textarea
            className="stm-textarea"
            data-stm-field={`fragment-content-${props.fragment.id}`}
            value={props.fragment.content}
            placeholder="片段内容：提示词文本，可插入占位符"
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
                onClick={() => props.onUpdate({ content: props.fragment.content + placeholder })}
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
