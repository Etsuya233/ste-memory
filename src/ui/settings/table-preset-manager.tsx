import { TablePresetEditor } from "./table-preset-editor.tsx";
import { useEffect, useRef, useState } from "react";
import type { MemorySpace } from "../../features/memory/index.ts";
import type { SpaceContextStatus } from "../../features/chat-binding/chat-space-manager.ts";
import type { ApplyTablePresetOutcome } from "../../features/table-presets/table-preset-apply-service.ts";
import {
  copyTablePresetAsUserPreset,
  deleteUserTablePreset,
  overwriteUserTablePreset,
  renameUserTablePreset,
  saveUserTablePreset,
  setDefaultTablePreset,
} from "../../features/table-presets/table-preset-library.ts";
import {
  resolveTablePreset,
  type ResolvedTablePreset,
  type TablePresetSettings,
  type TablePresetStructure,
} from "../../features/table-presets/preset-model.ts";
import { SYSTEM_TABLE_PRESET } from "../../features/table-presets/system-preset.ts";
import {
  importTablePreset,
  validateTablePresetContent,
  parseTablePresetExport,
  serializeTablePresetExport,
} from "../../features/table-presets/preset-transfer.ts";
import { createUiId, reportError, reportSuccess, reportWarning } from "../shell/ui-helpers.tsx";
import {
  BUILTIN_PRESET_READONLY_HINT,
  SAVE_PRESET_HINT,
  applyPresetActionLabel,
  applyPresetConfirmText,
  applyPresetConfirmTitle,
  applyPresetUnavailableReason,
  deletePresetConfirmText,
  initializationSourceLabel,
  overwritePresetConfirmText,
  presetPreviewViewModel,
  tablePresetOptions,
  tablePresetRows,
} from "./table-preset-manager-model.ts";

/**
 * 设置 Tab「表格预设」分组（spec 6）：新空间默认设置 / 当前空间应用区 / 预设管理区。
 *
 * - 预设库与默认选择是全局设置（不随对话切换），组件只负责草稿与展示，写入经
 *   onPresetsChange（设置服务保存）；
 * - 选择目标、展开预览只改界面草稿：不写空间、不改默认选择、不触发清空确认；
 * - 用户确认执行后停止目标空间的进行中填表写入；
 *   确认框提供「备份并应用 / 直接清空并应用 / 取消」，备份未完成不清空；
 * - 应用过程中固定目标空间与预设、禁止重复提交。
 */
export function TablePresetManager(props: {
  readonly presets: TablePresetSettings;
  readonly registerLeaveGuard?: (guard: (() => boolean) | null) => void;
  readonly status: SpaceContextStatus | undefined;
  readonly pluginEnabled: boolean;
  readonly onPresetsChange: (presets: TablePresetSettings) => void;
  /** 读取当前活动空间的实际结构（另存为预设 / 覆盖预设用） */
  readonly readSpaceStructure: () => Promise<TablePresetStructure>;
  /** 用户确认执行后，应用前停止目标空间的进行中填表写入 */
  readonly onPrepareApply: (
    memorySpaceId: MemorySpace["id"],
    chatIdentity: string,
  ) => Promise<void>;
  /** 应用预设（原子重建 + 成功后同步） */
  readonly onApplyPreset: (
    memorySpaceId: MemorySpace["id"],
    preset: ResolvedTablePreset,
    chatIdentity: string,
  ) => Promise<ApplyTablePresetOutcome>;
  /** 空间备份导出：返回是否完成（取消/失败 = false，不清空） */
  readonly onBackupSpace: (spaceId: MemorySpace["id"], chatIdentity: string) => Promise<boolean>;
  /** 重建成功后刷新面板数据 */
  readonly onDataChanged: () => void;
}) {
  const [editor, setEditor] = useState<{ initial: ResolvedTablePreset; isNew: boolean } | null>(
    null,
  );
  const active = props.status?.kind === "active" ? props.status : undefined;
  const space = active?.space;
  const rows = tablePresetRows(props.presets, SYSTEM_TABLE_PRESET);
  const options = tablePresetOptions(props.presets, SYSTEM_TABLE_PRESET);
  const sourcePresetId = space?.initializationSource?.presetId;

  // ---- 新空间默认设置（草稿 + 保存） ----
  const [defaultDraft, setDefaultDraft] = useState(props.presets.defaultPresetId);
  // ---- 当前空间应用区（草稿：目标预设；选择不动空间、不动默认、不弹确认） ----
  const [applyTargetId, setApplyTargetId] = useState(
    sourcePresetId ?? props.presets.defaultPresetId,
  );
  const [applyPreviewOpen, setApplyPreviewOpen] = useState(false);
  // 切换对话或空间来源变化（含应用预设后的来源更新）→ 目标草稿回到该空间的来源预设
  useEffect(() => {
    setApplyTargetId(sourcePresetId ?? props.presets.defaultPresetId);
    setApplyPreviewOpen(false);
  }, [space?.id, sourcePresetId]);
  // ---- 预设管理草稿 ----
  const [newPresetName, setNewPresetName] = useState("");
  const [newPresetDescription, setNewPresetDescription] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState({ name: "", description: "" });
  const [previewPresetId, setPreviewPresetId] = useState<string | null>(null);
  // ---- 应用确认流程状态（应用期间固定空间与预设，禁止重复提交） ----
  const [confirming, setConfirming] = useState<
    | {
        readonly spaceId: MemorySpace["id"];
        readonly spaceName: string;
        readonly chatIdentity: string;
        readonly preset: ResolvedTablePreset;
        readonly backupIssue: string | undefined;
        readonly failure: string | undefined;
      }
    | undefined
  >(undefined);
  const [busy, setBusy] = useState(false);
  const operationRunning = useRef(false);
  const importInput = useRef<HTMLInputElement>(null);

  const targetExists = options.some((option) => option.id === applyTargetId);
  const applyTarget = targetExists
    ? resolveTablePreset(props.presets, SYSTEM_TABLE_PRESET, applyTargetId)
    : undefined;
  const applyUnavailable = applyPresetUnavailableReason({
    pluginEnabled: props.pluginEnabled,
    hasActiveSpace: space !== undefined,
  });
  const applyBusy = busy || confirming !== undefined;

  function changePresets(next: TablePresetSettings): void {
    props.onPresetsChange(next);
  }

  async function importPresetFile(file: File): Promise<void> {
    setBusy(true);
    try {
      const imported = parseTablePresetExport(await file.text());
      const { settings, preset } = importTablePreset(props.presets, SYSTEM_TABLE_PRESET, imported, {
        id: createUiId(),
        now: new Date().toISOString(),
      });
      changePresets(settings);
      setPreviewPresetId(preset.id);
      reportSuccess(`已导入「${preset.name}」，默认选择保持不变`);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  function exportPreset(preset: ResolvedTablePreset): void {
    const text = serializeTablePresetExport(preset, new Date().toISOString());
    const url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `table-preset-${preset.name.replace(/[\\/:*?"<>|]/g, "_")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    reportSuccess(`已导出「${preset.name}」`);
  }

  function saveDefaultPreset(): void {
    try {
      changePresets(setDefaultTablePreset(props.presets, SYSTEM_TABLE_PRESET, defaultDraft));
      reportSuccess("已保存新空间默认预设（仅影响之后创建的全新记忆空间）");
    } catch (error) {
      reportError(error);
    }
  }

  async function saveCurrentStructureAsPreset(): Promise<void> {
    if (!active) return;
    setBusy(true);
    try {
      const structure = await props.readSpaceStructure();
      const { settings, preset } = saveUserTablePreset(props.presets, {
        id: createUiId(),
        name: newPresetName,
        description: newPresetDescription,
        structure,
        now: new Date().toISOString(),
      });
      changePresets(settings);
      setNewPresetName("");
      setNewPresetDescription("");
      reportSuccess(`已另存为预设「${preset.name}」`);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  function saveRename(): void {
    if (renamingId === null) return;
    try {
      changePresets(
        renameUserTablePreset(props.presets, renamingId, {
          name: renameDraft.name,
          description: renameDraft.description,
          now: new Date().toISOString(),
        }),
      );
      setRenamingId(null);
      reportSuccess("预设已更新");
    } catch (error) {
      reportError(error);
    }
  }

  function copyPreset(preset: ResolvedTablePreset): void {
    try {
      const { settings, preset: created } = copyTablePresetAsUserPreset(props.presets, preset, {
        id: createUiId(),
        now: new Date().toISOString(),
      });
      changePresets(settings);
      reportSuccess(`已复制为预设「${created.name}」`);
    } catch (error) {
      reportError(error);
    }
  }

  function deletePreset(presetId: string, name: string, isDefault: boolean): void {
    if (!window.confirm(deletePresetConfirmText(name, isDefault))) return;
    try {
      const next = deleteUserTablePreset(props.presets, presetId);
      changePresets(next);
      if (previewPresetId === presetId) setPreviewPresetId(null);
      if (defaultDraft === presetId) {
        setDefaultDraft(next.defaultPresetId);
      }
      reportSuccess(`已删除预设「${name}」`);
    } catch (error) {
      reportError(error);
    }
  }

  async function overwritePreset(presetId: string, name: string): Promise<void> {
    if (!active) return;
    if (!window.confirm(overwritePresetConfirmText(name))) return;
    setBusy(true);
    try {
      const structure = await props.readSpaceStructure();
      changePresets(
        overwriteUserTablePreset(props.presets, presetId, {
          structure,
          now: new Date().toISOString(),
        }),
      );
      reportSuccess(`已用当前表结构覆盖预设「${name}」`);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  /** 选择和确认阶段不停止任务；固定对话身份，后续不能借用新对话的上下文。 */
  function beginApply(): void {
    if (!space || !active || active.binding.version !== 2 || !applyTarget) return;
    setConfirming({
      spaceId: space.id,
      spaceName: space.name,
      chatIdentity: active.binding.chatIdentity,
      preset: applyTarget,
      backupIssue: undefined,
      failure: undefined,
    });
  }

  /** 执行应用（确认框固定了目标空间与预设；重建失败保留确认框以便重试）。 */
  async function runApply(withBackup: boolean): Promise<void> {
    const target = confirming;
    if (!target || operationRunning.current) return;
    operationRunning.current = true;
    setBusy(true);
    try {
      if (withBackup) {
        const completed = await props.onBackupSpace(target.spaceId, target.chatIdentity);
        if (!completed) {
          setConfirming({
            ...target,
            backupIssue: "备份未完成（已取消），未执行清空；可重试或取消。",
            failure: undefined,
          });
          return;
        }
      } else {
        await props.onPrepareApply(target.spaceId, target.chatIdentity);
      }
      const outcome = await props.onApplyPreset(target.spaceId, target.preset, target.chatIdentity);
      if (outcome.kind === "applied") {
        reportSuccess(`已按预设「${target.preset.name}」重建「${target.spaceName}」`);
      } else {
        reportWarning(`空间已重建，但同步未完成：${outcome.message}`);
      }
      setConfirming(undefined);
      props.onDataChanged();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportError(error);
      setConfirming({ ...target, failure: message, backupIssue: undefined });
    } finally {
      operationRunning.current = false;
      setBusy(false);
    }
  }

  if (editor)
    return (
      <TablePresetEditor
        initial={editor.initial}
        isNew={editor.isNew}
        registerLeaveGuard={props.registerLeaveGuard}
        onClose={() => setEditor(null)}
        onSave={(draft) => {
          const now = new Date().toISOString();
          const validated = validateTablePresetContent({
            name: draft.name,
            description: draft.description,
            prompt: draft.prompt,
            tables: draft.tables,
          });
          const next = editor.isNew
            ? saveUserTablePreset(props.presets, {
                id: draft.id,
                name: validated.name,
                description: validated.description,
                structure: validated,
                now,
              }).settings
            : overwriteUserTablePreset(
                renameUserTablePreset(props.presets, draft.id, {
                  name: validated.name,
                  description: validated.description,
                  now,
                }),
                draft.id,
                { structure: validated, now },
              );
          changePresets(next);
          setEditor(null);
          reportSuccess(`已保存预设「${draft.name.trim()}」`);
        }}
      />
    );

  return (
    <div className="stm-preset-manager" data-stm-section="table-presets">
      {/* 新空间默认设置 */}
      <div className="stm-setting-subgroup" data-stm-section="preset-default">
        <div className="stm-setting-name">新空间默认预设</div>
        <div className="stm-setting-hint">
          仅影响之后创建的全新记忆空间；保存不会清空或改变当前空间。
        </div>
        <div className="stm-preset-row">
          <select
            className="stm-select"
            data-stm-field="preset-default-select"
            value={defaultDraft}
            onChange={(event) => setDefaultDraft(event.target.value)}
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="stm-button"
            data-action="save-default-preset"
            disabled={busy || defaultDraft === props.presets.defaultPresetId}
            onClick={saveDefaultPreset}
          >
            保存
          </button>
        </div>
      </div>

      <div className="stm-setting-divider" />

      {/* 当前空间应用区 */}
      <div className="stm-setting-subgroup" data-stm-section="preset-apply">
        <div className="stm-setting-name">应用到当前空间</div>
        <div className="stm-setting-rows">
          <div className="stm-setting-row">
            <div className="stm-setting-name">当前空间</div>
            <div className="stm-setting-value" data-stm-field="preset-space-name">
              {space ? space.name : "无活动记忆空间"}
            </div>
          </div>
          <div className="stm-setting-row">
            <div className="stm-setting-name">初始化来源</div>
            <div className="stm-setting-value" data-stm-field="preset-source-label">
              {initializationSourceLabel(space)}
            </div>
          </div>
        </div>
        <div className="stm-setting-hint">
          来源信息只说明最近一次创建或应用时使用的预设，不代表当前结构与预设一致。
        </div>
        <div className="stm-preset-row">
          <select
            className="stm-select"
            data-stm-field="preset-apply-target"
            value={targetExists ? applyTargetId : ""}
            disabled={applyUnavailable !== undefined}
            onChange={(event) => {
              setApplyTargetId(event.target.value);
              setApplyPreviewOpen(false);
            }}
          >
            <option value="" disabled>
              请选择有效的表格预设
            </option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="stm-button"
            data-action="toggle-preset-apply-preview"
            aria-pressed={applyPreviewOpen}
            disabled={!applyTarget}
            onClick={() => setApplyPreviewOpen(!applyPreviewOpen)}
          >
            {applyPreviewOpen ? "收起预览" : "结构预览"}
          </button>
          <button
            type="button"
            className="stm-button stm-button--danger"
            data-action="apply-preset"
            disabled={applyUnavailable !== undefined || applyBusy || !applyTarget}
            title={applyUnavailable}
            onClick={() => void beginApply()}
          >
            {applyPresetActionLabel(space, applyTargetId)}
          </button>
        </div>
        {applyUnavailable && <div className="stm-setting-hint">{applyUnavailable}</div>}
        {applyPreviewOpen && applyTarget && (
          <div className="stm-preset-preview" data-stm-field="preset-apply-preview">
            <PresetStructurePreview preset={applyTarget} />
          </div>
        )}
      </div>

      <div className="stm-setting-divider" />

      {/* 预设管理区 */}
      <div className="stm-setting-subgroup" data-stm-section="preset-library">
        <button
          type="button"
          className="stm-button"
          data-action="new-table-preset"
          disabled={busy}
          onClick={() =>
            setEditor({
              isNew: true,
              initial: {
                id: createUiId(),
                name: "",
                description: "",
                prompt: "",
                tables: [],
                builtIn: false,
              },
            })
          }
        >
          新建空白预设
        </button>
        <div className="stm-setting-name">预设管理</div>
        <div className="stm-setting-actions">
          <button
            type="button"
            className="stm-button"
            data-action="import-table-preset"
            disabled={busy}
            onClick={() => importInput.current!.click()}
          >
            导入表格预设
          </button>
          <input
            ref={importInput}
            type="file"
            accept=".json,application/json"
            hidden
            data-stm-field="table-preset-import-file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importPresetFile(file);
            }}
          />
        </div>
        <div className="stm-setting-hint">
          导入会新增用户预设，不更改默认选择或当前空间；同名自动编号。
        </div>
        <ul className="stm-preset-list">
          {rows.map((row) => {
            const preset = resolveTablePreset(props.presets, SYSTEM_TABLE_PRESET, row.id);
            const previewOpen = previewPresetId === row.id;
            const renaming = renamingId === row.id;
            return (
              <li key={row.id} className="stm-preset-card" data-preset-id={row.id}>
                <div className="stm-preset-card-main">
                  <div className="stm-preset-card-title">
                    {row.name}
                    {row.builtIn && <span className="stm-preset-badge">系统自带</span>}
                    {row.isDefault && <span className="stm-preset-badge">新空间默认</span>}
                  </div>
                  <div className="stm-preset-card-meta">
                    {`${row.tableCount} 张表 · ${row.fieldCount} 个字段`}
                  </div>
                  {row.description && (
                    <div className="stm-setting-hint stm-preset-card-description">
                      {row.description}
                    </div>
                  )}
                </div>
                <div className="stm-table-actions">
                  <button
                    type="button"
                    className="stm-table-action"
                    data-action="edit-table-preset"
                    disabled={busy}
                    onClick={() => setEditor({ initial: preset, isNew: false })}
                  >
                    {preset.builtIn ? "查看" : "编辑"}
                  </button>
                  {preset.builtIn && (
                    <button
                      type="button"
                      className="stm-table-action"
                      disabled={busy}
                      onClick={() =>
                        setEditor({
                          isNew: true,
                          initial: {
                            ...preset,
                            id: createUiId(),
                            name: `${preset.name} 副本`,
                            builtIn: false,
                          },
                        })
                      }
                    >
                      复制并编辑
                    </button>
                  )}
                  <button
                    type="button"
                    className="stm-table-action"
                    data-action="export-table-preset"
                    data-preset-id={row.id}
                    disabled={busy}
                    onClick={() => exportPreset(preset)}
                  >
                    导出
                  </button>
                  <button
                    type="button"
                    className="stm-table-action"
                    data-action="preview-preset"
                    data-preset-id={row.id}
                    aria-pressed={previewOpen}
                    onClick={() => setPreviewPresetId(previewOpen ? null : row.id)}
                  >
                    {previewOpen ? "收起预览" : "结构预览"}
                  </button>
                  <button
                    type="button"
                    className="stm-table-action"
                    data-action="copy-preset"
                    data-preset-id={row.id}
                    disabled={busy}
                    onClick={() => copyPreset(preset)}
                  >
                    复制为新预设
                  </button>
                  <button
                    type="button"
                    className="stm-table-action"
                    data-action="rename-preset"
                    data-preset-id={row.id}
                    disabled={row.builtIn}
                    title={row.builtIn ? BUILTIN_PRESET_READONLY_HINT : undefined}
                    onClick={() => {
                      setRenamingId(renaming ? null : row.id);
                      setRenameDraft({ name: row.name, description: row.description });
                    }}
                  >
                    重命名
                  </button>
                  <button
                    type="button"
                    className="stm-table-action"
                    data-action="overwrite-preset"
                    data-preset-id={row.id}
                    disabled={row.builtIn || busy || !active}
                    title={row.builtIn ? BUILTIN_PRESET_READONLY_HINT : "用当前表结构覆盖该预设"}
                    onClick={() => void overwritePreset(row.id, row.name)}
                  >
                    用当前结构覆盖
                  </button>
                  <button
                    type="button"
                    className="stm-table-action stm-table-action--danger"
                    data-action="delete-preset"
                    data-preset-id={row.id}
                    disabled={row.builtIn || busy}
                    title={row.builtIn ? BUILTIN_PRESET_READONLY_HINT : undefined}
                    onClick={() => deletePreset(row.id, row.name, row.isDefault)}
                  >
                    删除
                  </button>
                </div>
                {renaming && (
                  <div className="stm-preset-editor" data-stm-field="preset-rename-editor">
                    <input
                      className="stm-input"
                      type="text"
                      data-stm-field="preset-rename-name"
                      value={renameDraft.name}
                      onChange={(event) =>
                        setRenameDraft({ ...renameDraft, name: event.target.value })
                      }
                    />
                    <input
                      className="stm-input"
                      type="text"
                      data-stm-field="preset-rename-description"
                      placeholder="说明（可选）"
                      value={renameDraft.description}
                      onChange={(event) =>
                        setRenameDraft({ ...renameDraft, description: event.target.value })
                      }
                    />
                    <div className="stm-setting-actions">
                      <button
                        type="button"
                        className="stm-button"
                        data-action="save-preset-rename"
                        onClick={saveRename}
                      >
                        保存
                      </button>
                      <button
                        type="button"
                        className="stm-button"
                        data-action="cancel-preset-rename"
                        onClick={() => setRenamingId(null)}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
                {previewOpen && (
                  <div className="stm-preset-preview" data-stm-field="preset-structure-preview">
                    <PresetStructurePreview preset={preset} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {/* 另存为预设 */}
        <div className="stm-setting-subgroup" data-stm-section="preset-save">
          <div className="stm-setting-name">将当前表结构另存为预设</div>
          <div className="stm-setting-hint">{SAVE_PRESET_HINT}</div>
          <div className="stm-setting-hint">
            自动配置将保存为当前分组快照；请先修正失效的来源字段。此操作本身不会发送向量请求。
          </div>
          <div className="stm-preset-editor">
            <input
              className="stm-input"
              type="text"
              data-stm-field="preset-save-name"
              placeholder="预设名称"
              value={newPresetName}
              onChange={(event) => setNewPresetName(event.target.value)}
            />
            <input
              className="stm-input"
              type="text"
              data-stm-field="preset-save-description"
              placeholder="说明（可选）"
              value={newPresetDescription}
              onChange={(event) => setNewPresetDescription(event.target.value)}
            />
            <button
              type="button"
              className="stm-button"
              data-action="save-space-as-preset"
              disabled={busy || !active}
              title={active ? undefined : "当前对话没有活动的记忆空间"}
              onClick={() => void saveCurrentStructureAsPreset()}
            >
              另存为预设
            </button>
          </div>
        </div>
      </div>

      {/* 应用确认（一次确认；备份未完成不清空；重建失败可重试） */}
      {confirming && (
        <div
          className="stm-modal-overlay"
          data-stm-section="preset-apply-confirm"
          onClick={() => {
            if (!busy) setConfirming(undefined);
          }}
        >
          <div
            className="stm-modal"
            role="dialog"
            aria-modal="true"
            aria-label={applyPresetConfirmTitle(space, confirming.preset.id)}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="stm-modal-title" data-stm-field="preset-confirm-title">
              {applyPresetConfirmTitle(space, confirming.preset.id)}
            </div>
            <div className="stm-modal-body">
              <pre className="stm-mono stm-modal-text" data-stm-field="preset-confirm-text">
                {applyPresetConfirmText(confirming.spaceName, confirming.preset.name)}
              </pre>
              {confirming.backupIssue && (
                <div className="stm-form-error" data-stm-field="preset-confirm-backup-issue">
                  {confirming.backupIssue}
                </div>
              )}
              {confirming.failure && (
                <div className="stm-form-error" data-stm-field="preset-confirm-failure">
                  {`操作失败：${confirming.failure}`}
                </div>
              )}
            </div>
            <div className="stm-modal-footer">
              <button
                type="button"
                className="stm-button"
                data-action="cancel-apply-preset"
                disabled={busy}
                onClick={() => setConfirming(undefined)}
              >
                取消
              </button>
              <button
                type="button"
                className="stm-button"
                data-action="backup-and-apply-preset"
                disabled={busy}
                onClick={() => void runApply(true)}
              >
                备份并应用
              </button>
              <button
                type="button"
                className="stm-button stm-button--danger"
                data-action="apply-preset-directly"
                disabled={busy}
                onClick={() => void runApply(false)}
              >
                直接清空并应用
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 结构预览（只读）：说明 + 表名/字段数量 + 字段定义与填写规则详情（spec 6.2）。 */
function PresetStructurePreview(props: { readonly preset: ResolvedTablePreset }) {
  const preview = presetPreviewViewModel(props.preset);
  return (
    <div className="stm-preset-preview-body">
      {preview.description && <div className="stm-setting-hint">{preview.description}</div>}
      {props.preset.prompt && (
        <div className="stm-setting-hint" data-stm-field="preset-shared-prompt">
          通用填写规则：{props.preset.prompt}
        </div>
      )}
      {preview.tables.map((table) => (
        <div key={table.key} className="stm-preset-preview-table">
          <div className="stm-preset-preview-title">
            {table.name}
            <span className="stm-preset-card-meta">
              {`${table.key} · ${table.fieldCount} 个字段`}
              {table.enabled ? "" : " · 已停用"}
            </span>
          </div>
          {table.description && <div className="stm-setting-hint">{table.description}</div>}
          {table.prompt && <div className="stm-setting-hint">{table.prompt}</div>}
          <ul className="stm-preset-preview-fields">
            {table.fields.map((field) => (
              <li key={field.key} className="stm-preset-preview-field">
                <div className="stm-preset-preview-field-name">
                  {field.name}
                  {field.required ? <span className="stm-field-required">*</span> : null}
                  <span className="stm-preset-card-meta">
                    {`${field.key} · ${field.typeLabel}`}
                    {field.enabled ? "" : " · 已停用"}
                  </span>
                </div>
                {field.prompt && <div className="stm-setting-hint">{field.prompt}</div>}
                {field.detail && <div className="stm-setting-hint">{field.detail}</div>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
