import { Dialog } from "../kit/dialog.tsx";
import { FormField, Button, Input } from "../kit/controls.tsx";
import { ActionRow, ListGroup, NavigationRow } from "../kit/list.tsx";
import { PageChrome } from "../shell/page-layout.tsx";
import { PanelBar, PanelBarAction } from "../shell/panel-bar.tsx";
import { Disclosure } from "../shell/disclosure.tsx";
import { useSettingsPageNavigation } from "./settings-page-navigation.ts";
import { TablePresetEditor } from "./table-preset-editor.tsx";
import { useEffect, useId, useRef, useState } from "react";
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
  listTablePresets,
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
  SAVE_PRESET_HINT,
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
  readonly onBack?: () => void;
  readonly onEditingChange?: (editing: boolean) => void;
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
  const [editor, setEditor] = useState<{
    initial: ResolvedTablePreset;
    isNew: boolean;
  } | null>(null);
  const [utilityPage, setUtilityPage] = useState<"default" | "apply" | "capture" | null>(null);
  const captureFormId = useId();
  const [previewPresetId, setPreviewPresetId] = useState<string | null>(null);
  const { screenRef, rememberScroll } = useSettingsPageNavigation(
    editor ? `edit:preset:${editor.initial.id}` : utilityPage ? `edit:${utilityPage}` : "list",
  );
  function openEditor(value: { initial: ResolvedTablePreset; isNew: boolean }) {
    rememberScroll();
    setEditor(value);
  }
  const editing = editor !== null || props.onBack !== undefined;
  useEffect(() => {
    props.onEditingChange?.(editing);
    return () => props.onEditingChange?.(false);
  }, [editing, props.onEditingChange]);
  const active = props.status?.kind === "active" ? props.status : undefined;
  const space = active?.space;
  const rows = tablePresetRows(props.presets, SYSTEM_TABLE_PRESET);
  const options = tablePresetOptions(props.presets, SYSTEM_TABLE_PRESET);
  const sourcePresetId = space?.initializationSource?.presetId;
  const previewPreset = previewPresetId
    ? listTablePresets(props.presets, SYSTEM_TABLE_PRESET).find(
        (preset) => preset.id === previewPresetId,
      )
    : undefined;

  // ---- 新空间默认设置（草稿 + 保存） ----
  const [defaultDraft, setDefaultDraft] = useState(props.presets.defaultPresetId);
  // ---- 当前空间应用区（草稿：目标预设；选择不动空间、不动默认、不弹确认） ----
  const [applyTargetId, setApplyTargetId] = useState(
    sourcePresetId ?? props.presets.defaultPresetId,
  );
  // 切换对话或空间来源变化（含应用预设后的来源更新）→ 目标草稿回到该空间的来源预设
  useEffect(() => {
    setApplyTargetId(sourcePresetId ?? props.presets.defaultPresetId);
  }, [space?.id, sourcePresetId]);
  // ---- 预设管理草稿 ----
  const [newPresetName, setNewPresetName] = useState("");
  const [newPresetDescription, setNewPresetDescription] = useState("");
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

  const utilityDirty =
    utilityPage === "default"
      ? defaultDraft !== props.presets.defaultPresetId
      : utilityPage === "capture" && (newPresetName !== "" || newPresetDescription !== "");
  const utilityDirtyRef = useRef(utilityDirty);
  utilityDirtyRef.current = utilityDirty;
  useEffect(() => {
    if (!utilityPage) return;
    props.registerLeaveGuard?.(
      () => !utilityDirtyRef.current || window.confirm("有未保存的设置，放弃修改并离开吗？"),
    );
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (utilityDirtyRef.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      props.registerLeaveGuard?.(null);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [utilityPage, props.registerLeaveGuard]);
  function openUtility(page: "default" | "apply" | "capture") {
    rememberScroll();
    setDefaultDraft(props.presets.defaultPresetId);
    setNewPresetName("");
    setNewPresetDescription("");
    setUtilityPage(page);
  }
  function closeUtility() {
    if (utilityDirty && !window.confirm("有未保存的设置，放弃修改并返回吗？")) return;
    rememberScroll();
    setUtilityPage(null);
  }

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
      openEditor({ initial: { ...preset, builtIn: false }, isNew: false });
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
      setUtilityPage(null);
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
      setUtilityPage(null);
      openEditor({ initial: { ...preset, builtIn: false }, isNew: false });
      reportSuccess(`已另存为预设「${preset.name}」`);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
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
      setEditor(null);
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
      setEditor(null);
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

  /** 预设编辑即时落库：每次完成表格/字段/属性操作都写回预设库。 */
  function commitPreset(draft: ResolvedTablePreset): ResolvedTablePreset {
    if (!editor) return draft;
    const now = new Date().toISOString();
    const validated = validateTablePresetContent({
      name: draft.name,
      description: draft.description,
      prompt: draft.prompt,
      tables: draft.tables,
    });
    const exists = props.presets.userPresets.some((preset) => preset.id === draft.id);
    const next = exists
      ? overwriteUserTablePreset(
          renameUserTablePreset(props.presets, draft.id, {
            name: validated.name,
            description: validated.description,
            now,
          }),
          draft.id,
          { structure: validated, now },
        )
      : saveUserTablePreset(props.presets, {
          id: draft.id,
          name: validated.name,
          description: validated.description,
          structure: validated,
          now,
        }).settings;
    changePresets(next);
    const saved = resolveTablePreset(next, SYSTEM_TABLE_PRESET, draft.id);
    setEditor({ isNew: false, initial: saved });
    return saved;
  }

  if (editor)
    return (
      <div ref={screenRef}>
        <TablePresetEditor
          chrome={props.onEditingChange !== undefined}
          initial={editor.initial}
          isNew={editor.isNew}
          presetActions={(draft) => [
            {
              label: "导出预设",
              dataAction: "export-table-preset",
              onSelect: () => exportPreset(draft),
            },
            { label: "复制为新预设", dataAction: "copy-preset", onSelect: () => copyPreset(draft) },
            ...(!editor.isNew
              ? [
                  {
                    label: "用当前结构覆盖",
                    dataAction: "overwrite-preset",
                    disabled: busy || !active,
                    onSelect: () => void overwritePreset(draft.id, draft.name),
                  },
                  {
                    label: "删除预设",
                    dataAction: "delete-preset",
                    danger: true,
                    onSelect: () =>
                      deletePreset(
                        draft.id,
                        draft.name,
                        draft.id === props.presets.defaultPresetId,
                      ),
                  },
                ]
              : []),
          ]}
          registerLeaveGuard={props.registerLeaveGuard}
          onChange={commitPreset}
          onClose={() => {
            rememberScroll();
            setEditor(null);
          }}
        />
      </div>
    );

  /** 列表点击直接进入编辑；内置预设先复制，避免修改只读库。 */
  function openPreset(id: string): void {
    const preset = resolveTablePreset(props.presets, SYSTEM_TABLE_PRESET, id);
    openEditor(
      preset.builtIn
        ? {
            isNew: true,
            initial: {
              ...preset,
              id: createUiId(),
              name: `${preset.name} 副本`,
              builtIn: false,
            },
          }
        : { isNew: false, initial: preset },
    );
  }
  function createPreset() {
    const names = new Set(rows.map((row) => row.name));
    let name = "未命名预设";
    for (let index = 2; names.has(name); index++) name = `未命名预设 ${index}`;
    openEditor({
      isNew: true,
      initial: {
        id: createUiId(),
        name,
        description: "",
        prompt: "",
        tables: [],
        builtIn: false,
      },
    });
  }
  return (
    <div ref={screenRef} className="stm-settings-detail-page" data-stm-section="table-presets">
      {utilityPage ? (
        <>
          {props.onBack && (
            <PageChrome
              pageKey={utilityPage}
              header={
                <PanelBar
                  title={
                    utilityPage === "default"
                      ? "新空间默认预设"
                      : utilityPage === "apply"
                        ? "应用到当前空间"
                        : "保存当前表结构"
                  }
                  leading={
                    <PanelBarAction
                      icon="fa-arrow-left"
                      label="返回预设列表"
                      data-action="back-preset-utility"
                      disabled={busy}
                      onClick={closeUtility}
                    />
                  }
                  trailing={
                    utilityPage === "default" ? (
                      <PanelBarAction
                        icon="fa-check"
                        label="保存默认预设"
                        data-action="save-default-preset"
                        disabled={busy || defaultDraft === props.presets.defaultPresetId}
                        onClick={saveDefaultPreset}
                      />
                    ) : utilityPage === "capture" ? (
                      <PanelBarAction
                        icon="fa-check"
                        label="另存为预设"
                        data-action="save-space-as-preset"
                        form={captureFormId}
                        type="submit"
                        disabled={busy || !active}
                      />
                    ) : (
                      <PanelBarAction
                        icon="fa-arrow-rotate-right"
                        label="应用预设"
                        data-action="apply-preset"
                        danger
                        disabled={applyUnavailable !== undefined || applyBusy || !applyTarget}
                        onClick={beginApply}
                      />
                    )
                  }
                />
              }
            />
          )}
          {utilityPage === "capture" ? (
            <form
              id={captureFormId}
              className="stm-settings-form"
              data-stm-section="preset-save"
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy) void saveCurrentStructureAsPreset();
              }}
            >
              <FormField className="stm-form-row" label={<>预设名称</>}>
                {(field) => (
                  <Input
                    {...field}

                    data-stm-field="preset-save-name"
                    value={newPresetName}
                    onChange={(event) => setNewPresetName(event.target.value)}
                    required
                  />
                )}
              </FormField>
              <FormField className="stm-form-row" label={<>说明</>}>
                {(field) => (
                  <Input
                    {...field}

                    data-stm-field="preset-save-description"
                    value={newPresetDescription}
                    onChange={(event) => setNewPresetDescription(event.target.value)}
                  />
                )}
              </FormField>
              <Disclosure icon="fa-circle-info" title="保存范围" open>
                <div className="stm-setting-hint">
                  {SAVE_PRESET_HINT} 自动配置保存为分组快照，不发送向量请求。
                </div>
              </Disclosure>
            </form>
          ) : (
            <>
              {utilityPage === "apply" ? (
                <>
                  <ListGroup className="stm-preset-space-summary">
                    <div>
                      <span>当前空间</span>
                      <strong data-stm-field="preset-space-name">
                        {space ? space.name : "无活动记忆空间"}
                      </strong>
                    </div>
                    <div>
                      <span>初始化来源</span>
                      <strong data-stm-field="preset-source-label">
                        {space?.initializationSource ? initializationSourceLabel(space) : "未记录"}
                      </strong>
                    </div>
                  </ListGroup>
                  <div className="stm-section-label">选择应用的预设</div>
                </>
              ) : (
                <p className="stm-setting-hint">仅用于之后新建的记忆空间。</p>
              )}
              <ListGroup
                as="ul"
                className="stm-settings-item-list"
                data-stm-section={utilityPage === "default" ? "preset-default" : "preset-apply"}
              >
                {rows.map((row) => {
                  const chosen =
                    row.id === (utilityPage === "default" ? defaultDraft : applyTargetId);
                  return (
                    <li key={row.id}>
                      <ActionRow
                        title={row.name}
                        description={
                          <>
                            {row.tableCount} 张表 · {row.fieldCount} 个字段
                            {row.builtIn ? " · 内置" : ""}
                          </>
                        }
                        trailing={
                          <i
                            className={`fa-solid ${chosen ? "fa-check" : "fa-circle"}`}
                            aria-hidden="true"
                          />
                        }
                        data-action={
                          utilityPage === "default"
                            ? "choose-default-preset"
                            : "choose-apply-preset"
                        }
                        data-preset-id={row.id}
                        aria-pressed={chosen}
                        onClick={() =>
                          utilityPage === "default"
                            ? setDefaultDraft(row.id)
                            : setApplyTargetId(row.id)
                        }
                      />
                    </li>
                  );
                })}
              </ListGroup>
              {utilityPage === "apply" && (
                <>
                  <p className="stm-setting-hint">将清空当前空间记录，按所选预设重建表格。</p>
                  {!targetExists && <p className="stm-form-error">来源预设已删除，请重新选择。</p>}
                  {applyTarget && (
                    <Disclosure icon="fa-eye" title="结构预览">
                      <PresetStructurePreview preset={applyTarget} />
                    </Disclosure>
                  )}
                </>
              )}
            </>
          )}
        </>
      ) : (
        <>
          {props.onBack && (
            <PageChrome
              pageKey="preset-list"
              header={
                <PanelBar
                  title="表格预设"
                  leading={
                    <PanelBarAction
                      icon="fa-arrow-left"
                      label="返回设置"
                      data-action="settings-back"
                      onClick={props.onBack}
                    />
                  }
                  trailing={
                    <>
                      <PanelBarAction
                        icon="fa-file-import"
                        label="导入预设"
                        data-action="import-table-preset"
                        disabled={busy}
                        onClick={() => importInput.current!.click()}
                      />
                      <PanelBarAction
                        icon="fa-plus"
                        label="新建预设"
                        data-action="new-table-preset"
                        disabled={busy}
                        onClick={createPreset}
                      />
                    </>
                  }
                />
              }
            />
          )}
          {!props.onBack && (
            <div className="stm-setting-actions">
              <Button
                type="button"

                data-action="new-table-preset"
                disabled={busy}
                onClick={createPreset}
              >
                新建预设
              </Button>
              <Button
                type="button"

                data-action="import-table-preset"
                disabled={busy}
                onClick={() => importInput.current!.click()}
              >
                导入
              </Button>
            </div>
          )}
          <ListGroup as="ul" className="stm-settings-item-list">
            {rows.map((row) => (
              <li key={row.id} className="stm-settings-item-with-action">
                <NavigationRow
                  data-action="open-table-preset"
                  data-preset-id={row.id}
                  onClick={() => openPreset(row.id)}
                  title={row.name}
                  description=<>
                    {row.tableCount} 张表 · {row.fieldCount} 个字段
                    {row.builtIn ? " · 内置" : ""}
                    {row.isDefault ? " · 新空间默认" : ""}
                  </>
                />
                <PanelBarAction
                  icon="fa-eye"
                  label={`预览完整结构 ${row.name}`}
                  data-action="preview-table-preset"
                  data-preset-id={row.id}
                  onClick={() => setPreviewPresetId(row.id)}
                />
              </li>
            ))}
          </ListGroup>
          <div className="stm-section-label">空间设置</div>
          <ListGroup className="stm-settings-utility-list">
            <NavigationRow
              data-action="open-default-preset"
              onClick={() => openUtility("default")}
              title=<>新空间默认预设</>
              description={rows.find((row) => row.id === props.presets.defaultPresetId)!.name}
            />
            <NavigationRow
              data-action="open-preset-apply"
              disabled={applyUnavailable !== undefined}
              onClick={() => openUtility("apply")}
              title=<>应用到当前空间</>
              description={applyUnavailable ?? space!.name}
            />
            <NavigationRow
              data-action="open-preset-capture"
              disabled={!active || busy}
              onClick={() => openUtility("capture")}
              title=<>保存当前表结构</>
              description={active ? "另存为新预设" : "当前对话没有活动的记忆空间"}
            />
          </ListGroup>
        </>
      )}
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
      {/* 应用确认（一次确认；备份未完成不清空；重建失败可重试） */}
      {confirming && (
        <Dialog
          label={applyPresetConfirmTitle(space, confirming.preset.id)}
          onClose={() => {
            if (!busy) setConfirming(undefined);
          }}
          data-stm-section="preset-apply-confirm"
          contentClassName="stm-modal"
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
            <Button
              type="button"

              data-action="cancel-apply-preset"
              disabled={busy}
              onClick={() => setConfirming(undefined)}
            >
              取消
            </Button>
            <Button
              type="button"

              data-action="backup-and-apply-preset"
              disabled={busy}
              onClick={() => void runApply(true)}
            >
              备份并应用
            </Button>
            <Button
              type="button"
              variant="danger"
              data-action="apply-preset-directly"
              disabled={busy}
              onClick={() => void runApply(false)}
            >
              直接清空并应用
            </Button>
          </div>
        </Dialog>
      )}
      {previewPreset && (
        <Dialog
          label={`${previewPreset.name} 完整结构预览`}
          onClose={() => setPreviewPresetId(null)}
          data-stm-section="preset-structure-preview"
          contentClassName="stm-modal"
        >
          <div className="stm-modal-title">完整结构预览 · {previewPreset.name}</div>
          <div className="stm-modal-body">
            <PresetStructurePreview preset={previewPreset} />
          </div>
          <div className="stm-modal-footer">
            <Button
              type="button"

              data-action="close-preset-structure-preview"
              onClick={() => setPreviewPresetId(null)}
            >
              关闭
            </Button>
          </div>
        </Dialog>
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
