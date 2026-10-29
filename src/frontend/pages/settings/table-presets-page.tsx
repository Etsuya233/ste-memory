import { useEffect, useRef, useState } from "react";
import { ChevronRight, Copy, Download, Trash2, Save } from "lucide-react";
import { Button } from "../../../ui/primitives/button.tsx";
import { Input } from "../../../ui/primitives/input.tsx";
import { Textarea } from "../../../ui/primitives/textarea.tsx";
import { Field, FieldDescription, FieldLabel } from "../../../ui/primitives/field.tsx";
import { NativeSelect, NativeSelectOption } from "../../../ui/primitives/native-select.tsx";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../../../ui/primitives/item.tsx";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "../../../ui/primitives/alert-dialog.tsx";
import { PageContent, PageHeader } from "../../components/page-layout.tsx";
import { PageSection } from "../../components/page-section.tsx";
import { usePageScroll } from "../../components/use-page-scroll.ts";
import { ConfirmAction, usePageLeave } from "../../components/confirmation.tsx";
import { StatusNotice } from "../../components/page-state.tsx";
import {
  listTablePresets,
  type ResolvedTablePreset,
  type TablePresetSettings,
} from "../../../features/table-presets/preset-model.ts";
import { SYSTEM_TABLE_PRESET } from "../../../features/table-presets/system-preset.ts";
import {
  saveUserTablePreset,
  renameUserTablePreset,
  overwriteUserTablePreset,
  deleteUserTablePreset,
  setDefaultTablePreset,
} from "../../../features/table-presets/table-preset-library.ts";
import {
  importTablePreset,
  parseTablePresetExport,
  serializeTablePresetExport,
} from "../../../features/table-presets/preset-transfer.ts";
import { copyMemoryMacros } from "../../../features/macros/macro-expression.ts";
import { downloadTextFile } from "../../../infrastructure/browser/download.ts";
import { presetDisplayStrategySummary } from "../../../ui/settings/table-preset-editor-model.ts";
import { SettingsEditor, type SettingsSubpageProps } from "./connection-settings-editor.tsx";
import { persistSettingsEdit } from "./connection-settings-model.ts";
import type { PresetContext, PresetSettingsServices } from "./preset-settings-services.ts";
import { TablePresetStructureEditor } from "./table-presets-structure-editor.tsx";
import { PresetUpdatePage } from "./preset-update-page.tsx";

type Props = SettingsSubpageProps & { presets: PresetSettingsServices };

export function TablePresetsPage(props: Props) {
  const [detail, setDetail] = useState<ResolvedTablePreset | null>(null);
  const [capture, setCapture] = useState<PresetContext | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const saved = (message: string) => {
    setNotice(message);
    setDetail(null);
    setCapture(null);
  };
  if (detail)
    return (
      <TablePresetDetail
        {...props}
        key={detail.id}
        initial={detail}
        onBack={() => setDetail(null)}
        onSaved={saved}
      />
    );
  if (capture)
    return (
      <CaptureTablePreset
        {...props}
        context={capture}
        onBack={() => setCapture(null)}
        onSaved={saved}
      />
    );
  return <TablePresetList {...props} notice={notice} onOpen={setDetail} onCapture={setCapture} />;
}

function TablePresetList({
  services,
  presets,
  controls,
  onBack,
  registerLeaveGuard,
  notice: initialNotice,
  onOpen,
  onCapture,
}: Props & {
  notice: string | null;
  onOpen: (preset: ResolvedTablePreset) => void;
  onCapture: (context: PresetContext) => void;
}) {
  const [settings, setSettings] = useState(() => services.settings.read().tablePresets);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState(initialNotice);
  const scroll = usePageScroll(services, "global-table-presets", true);
  const { confirmation } = usePageLeave({
    dirty: false,
    busy,
    scope: "table-presets-list",
    discard: () => {},
    register: registerLeaveGuard,
  });
  const rows = listTablePresets(settings, SYSTEM_TABLE_PRESET);
  async function change(
    update: (latest: TablePresetSettings) => TablePresetSettings,
    wasSaved: (saved: TablePresetSettings) => boolean,
    text: string,
  ) {
    setBusy(true);
    setError(null);
    try {
      const result = await persistSettingsEdit(
        services,
        () => {
          const latest = services.settings.read();
          services.settings.save({ ...latest, tablePresets: update(latest.tablePresets) });
        },
        (value) => wasSaved(value.tablePresets),
      );
      setSettings(result.settings.tablePresets);
      if (result.error)
        setError(
          `${result.saved ? "预设设置已保存，后续刷新失败" : "预设设置未保存"}：${result.error}`,
        );
      else setNotice(text);
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
      const imported = parseTablePresetExport(await file.text());
      const validated = await presets.validateTablePreset({
        ...imported,
        id: "import-validation",
        builtIn: false,
      });
      const id = crypto.randomUUID();
      await change(
        (latest) =>
          importTablePreset(
            latest,
            SYSTEM_TABLE_PRESET,
            {
              ...imported,
              ...parseTablePresetExport(
                serializeTablePresetExport(validated, new Date().toISOString()),
              ),
            },
            { id, now: new Date().toISOString() },
          ).settings,
        (value) => value.userPresets.some((preset) => preset.id === id),
        "表格预设已导入；默认选择和当前空间保持原有内容。",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  const context = presets.currentContext();
  return (
    <div className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <PageHeader title="表格预设" {...controls} onBack={onBack} busy={busy} />
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
        <PageSection title="新空间默认">
          <Field>
            <FieldLabel htmlFor="default-table-preset">新空间默认预设</FieldLabel>
            <NativeSelect
              id="default-table-preset"
              className="ste:w-full"
              disabled={busy}
              value={settings.defaultPresetId}
              onChange={(event) => {
                const id = event.target.value;
                void change(
                  (latest) => setDefaultTablePreset(latest, SYSTEM_TABLE_PRESET, id),
                  (value) => value.defaultPresetId === id,
                  "默认预设已保存，只影响之后创建的新空间。",
                );
              }}
            >
              {rows.map((preset) => (
                <NativeSelectOption key={preset.id} value={preset.id}>
                  {preset.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription>已有对话的表格、字段和记录保持原有内容。</FieldDescription>
          </Field>
        </PageSection>
        <PageSection
          title="表格预设"
          action={
            <div className="ste:flex ste:flex-wrap ste:items-center ste:justify-end ste:gap-2">
              <span className="ste:text-xs ste:text-muted-foreground">{rows.length} 个</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || !context}
                onClick={() => onCapture(context!)}
              >
                <Save />
                将当前表结构另存为预设
              </Button>
            </div>
          }
          bodyClassName="ste:p-0"
        >
          <ItemGroup className="ste:gap-0 ste:divide-y ste:divide-border">
            {rows.map((preset) => (
              <div role="listitem" key={preset.id}>
                <Item
                  render={<button type="button" disabled={busy} />}
                  className="ste:cursor-pointer ste:rounded-none ste:border-0 ste:px-4 ste:py-2.5 ste:text-left ste:hover:bg-muted/60 ste:focus-visible:ring-inset"
                  onClick={() => onOpen(preset)}
                  data-action="open-table-preset"
                >
                  <ItemContent>
                    <ItemTitle>{preset.name}</ItemTitle>
                    <ItemDescription className="ste:line-clamp-1">
                      {preset.builtIn ? "内置 · " : ""}
                      {preset.tables.length} 张表 · {preset.description}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <ChevronRight className="ste:size-4 ste:text-muted-foreground" />
                  </ItemActions>
                </Item>
              </div>
            ))}
          </ItemGroup>
          {!context ? (
            <p className="ste:border-t ste:border-border ste:px-4 ste:py-2 ste:text-xs ste:break-words ste:text-muted-foreground">
              打开已绑定记忆空间的对话后，可以另存结构或应用预设。
            </p>
          ) : null}
        </PageSection>
        <PageSection title="导入">
          <Field>
            <FieldLabel htmlFor="import-table-preset">导入表格预设 JSON</FieldLabel>
            <Input
              id="import-table-preset"
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

function CaptureTablePreset({
  services,
  presets,
  controls,
  onBack,
  registerLeaveGuard,
  context,
  onSaved,
}: Props & { context: PresetContext; onSaved: (message: string) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const structure = await presets.readCurrentStructure(context);
      const id = crypto.randomUUID();
      const validated = await presets.validateTablePreset({
        ...structure,
        id,
        name,
        description,
        builtIn: false,
      });
      const result = await persistSettingsEdit(
        services,
        () => {
          const latest = services.settings.read();
          const next = saveUserTablePreset(latest.tablePresets, {
            id,
            name,
            description,
            structure: validated,
            now: new Date().toISOString(),
          });
          services.settings.save({ ...latest, tablePresets: next.settings });
        },
        (value) => value.tablePresets.userPresets.some((preset) => preset.id === id),
      );
      if (result.saved)
        onSaved(
          result.error
            ? `预设已保存，后续刷新失败：${result.error}`
            : `已将「${context.title}」的表结构另存为预设。`,
        );
      else setError(result.error ?? "预设未保存");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsEditor
      title="另存当前表结构"
      scope="capture-table-preset"
      controls={controls}
      onBack={onBack}
      registerLeaveGuard={registerLeaveGuard}
      dirty={Boolean(name || description)}
      busy={busy}
      onDiscard={() => {
        setName("");
        setDescription("");
      }}
      onSave={() => void save()}
      error={error}
    >
      <PageSection
        title="预设内容"
        meta={
          <span className="ste:text-xs ste:break-words ste:text-muted-foreground">
            来源：{context.title}
          </span>
        }
      >
        <div className="ste:flex ste:flex-col ste:gap-4">
          <Field>
            <FieldLabel htmlFor="capture-preset-name">预设名称</FieldLabel>
            <Input
              id="capture-preset-name"
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <FieldDescription>
              保存表结构、填写规则、向量分组和宏，不包含记忆记录、索引或连接密钥。
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="capture-preset-description">预设说明</FieldLabel>
            <Textarea
              id="capture-preset-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
        </div>
      </PageSection>
    </SettingsEditor>
  );
}

function TablePresetDetail({
  services,
  presets,
  controls,
  onBack,
  registerLeaveGuard,
  initial,
  onSaved,
}: Props & { initial: ResolvedTablePreset; onSaved: (message: string) => void }) {
  const [draft, setDraft] = useState(initial);
  const [baseline, setBaseline] = useState(initial);
  const [structureOpen, setStructureOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [applying, setApplying] = useState<{
    context: PresetContext;
    preset: ResolvedTablePreset;
  } | null>(null);
  const [updateTarget, setUpdateTarget] = useState<PresetContext | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const context = presets.currentContext();
  const scroll = usePageScroll(
    presets,
    `table-preset-detail:${initial.id}`,
    !structureOpen && !updateTarget,
  );
  useEffect(() => {
    setApplying(null);
    setApplyError(null);
  }, [context?.chatIdentity, context?.spaceId]);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const validated = await presets.validateTablePreset(draft);
      const result = await persistSettingsEdit(
        services,
        () => {
          const latest = services.settings.read();
          let next = renameUserTablePreset(latest.tablePresets, draft.id, {
            name: validated.name,
            description: validated.description,
            now: new Date().toISOString(),
          });
          next = overwriteUserTablePreset(next, draft.id, {
            structure: validated,
            now: new Date().toISOString(),
          });
          services.settings.save({ ...latest, tablePresets: next });
        },
        (value) => {
          const saved = value.tablePresets.userPresets.find((preset) => preset.id === draft.id);
          return (
            saved !== undefined &&
            serializeTablePresetExport({ ...saved, builtIn: false }, "") ===
              serializeTablePresetExport(
                {
                  ...validated,
                  name: validated.name.trim(),
                  description: validated.description.trim(),
                },
                "",
              )
          );
        },
      );
      if (result.saved) {
        const saved = result.settings.tablePresets.userPresets.find(
          (preset) => preset.id === draft.id,
        )!;
        const next = { ...saved, builtIn: false };
        setDraft(next);
        setBaseline(next);
        setNotice(
          result.error
            ? `预设已保存，后续刷新失败：${result.error}`
            : "预设已保存，不影响已有空间。",
        );
      } else setError(result.error ?? "预设未保存");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    setBusy(true);
    setError(null);
    try {
      const id = crypto.randomUUID();
      const source = await presets.validateTablePreset({
        ...draft,
        macros: copyMemoryMacros(draft.macros ?? [], () => crypto.randomUUID()),
      });
      const latest = services.settings.read();
      const names = new Set(
        listTablePresets(latest.tablePresets, SYSTEM_TABLE_PRESET).map((preset) => preset.name),
      );
      let name = `${draft.name} 副本`;
      for (let suffix = 2; names.has(name); suffix++) name = `${draft.name} 副本 (${suffix})`;
      const result = await persistSettingsEdit(
        services,
        () => {
          const current = services.settings.read();
          const next = saveUserTablePreset(current.tablePresets, {
            id,
            name,
            description: source.description,
            structure: source,
            now: new Date().toISOString(),
          });
          services.settings.save({ ...current, tablePresets: next.settings });
        },
        (value) => value.tablePresets.userPresets.some((preset) => preset.id === id),
      );
      if (result.saved)
        onSaved(
          result.error ? `副本已保存，后续刷新失败：${result.error}` : `已保存副本「${name}」。`,
        );
      else setError(result.error ?? "副本未保存");
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
            tablePresets: deleteUserTablePreset(latest.tablePresets, draft.id),
          });
        },
        (value) => !value.tablePresets.userPresets.some((preset) => preset.id === draft.id),
      );
      if (!result.saved) throw new Error(result.error ?? "预设未删除");
      onSaved(
        result.error
          ? `预设已删除，后续刷新失败：${result.error}`
          : "预设已删除，已有空间保持原有内容。",
      );
    } finally {
      setBusy(false);
    }
  }
  function exportFile() {
    downloadTextFile(
      serializeTablePresetExport(draft, new Date().toISOString()),
      `table-preset-${draft.name.replace(/[\\/:*?"<>|]/g, "_")}.json`,
    );
  }
  async function apply(withBackup: boolean) {
    const target = applying;
    if (!target || busy) return;
    setBusy(true);
    setApplyError(null);
    try {
      if (withBackup && !(await presets.backupCurrentSpace(target.context))) {
        setApplyError("备份已取消，未应用预设。");
        return;
      }
      const outcome = await presets.applyTablePreset(target.context, target.preset);
      setApplying(null);
      setNotice(
        outcome.kind === "applied"
          ? `已按「${target.preset.name}」重建「${target.context.title}」。`
          : `空间已重建，同步未完成：${outcome.message}`,
      );
    } catch (cause) {
      setApplyError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  if (updateTarget)
    return (
      <PresetUpdatePage
        services={services}
        presets={presets}
        controls={controls}
        registerLeaveGuard={registerLeaveGuard}
        target={updateTarget}
        preset={structuredClone(baseline)}
        onBack={() => setUpdateTarget(null)}
      />
    );
  if (structureOpen)
    return (
      <TablePresetStructureEditor
        services={services}
        controls={controls}
        onBack={() => setStructureOpen(false)}
        registerLeaveGuard={registerLeaveGuard}
        value={draft}
        dirty={dirty}
        onChange={setDraft}
        onDiscard={() => setDraft(baseline)}
      />
    );
  return (
    <SettingsEditor
      title={draft.builtIn ? "内置表格预设" : "编辑表格预设"}
      scope="settings-table-preset"
      controls={controls}
      onBack={onBack}
      registerLeaveGuard={registerLeaveGuard}
      dirty={dirty}
      busy={busy}
      onDiscard={() => setDraft(baseline)}
      onSave={() => void save()}
      error={error}
      notice={notice}
      contentProps={{ ref: scroll.ref, onScroll: scroll.onScroll }}
    >
      <PageSection
        title="基本信息"
        action={
          <div className="ste:flex ste:flex-wrap ste:items-center ste:justify-end ste:gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void copy()}>
              <Copy />
              复制为用户预设
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={exportFile}>
              <Download />
              导出草稿
            </Button>
          </div>
        }
      >
        <div className="ste:flex ste:flex-col ste:gap-4">
          <Field>
            <FieldLabel htmlFor="table-preset-name">预设名称</FieldLabel>
            <Input
              id="table-preset-name"
              required
              maxLength={120}
              disabled={draft.builtIn}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="table-preset-description">预设说明</FieldLabel>
            <Textarea
              id="table-preset-description"
              disabled={draft.builtIn}
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="table-preset-prompt">跨表填写规则</FieldLabel>
            <Textarea
              id="table-preset-prompt"
              disabled={draft.builtIn}
              value={draft.prompt ?? ""}
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
            />
          </Field>
        </div>
      </PageSection>
      <PageSection
        title="表格与字段"
        action={
          draft.builtIn ? (
            <div className="ste:flex ste:flex-wrap ste:items-center ste:justify-end ste:gap-2">
              <span className="ste:text-xs ste:text-muted-foreground">
                {draft.tables.length} 张表
              </span>
              <span className="ste:text-xs ste:break-words ste:text-muted-foreground">
                内置结构只读；复制为用户预设后可以编辑。
              </span>
            </div>
          ) : (
            <div className="ste:flex ste:flex-wrap ste:items-center ste:justify-end ste:gap-2">
              <span className="ste:text-xs ste:text-muted-foreground">
                {draft.tables.length} 张表
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setStructureOpen(true)}
              >
                编辑表格与字段结构
              </Button>
            </div>
          )
        }
        bodyClassName="ste:p-0"
      >
        <ItemGroup className="ste:gap-0 ste:divide-y ste:divide-border">
          {draft.tables.map((table) => (
            <div role="listitem" key={table.key}>
              <Item className="ste:rounded-none ste:border-0 ste:px-4 ste:py-2.5">
                <ItemContent className="ste:min-w-0">
                  <ItemTitle className="ste:w-full ste:line-clamp-none ste:break-words">
                    {table.name} · {table.key}
                  </ItemTitle>
                  <ItemDescription className="ste:line-clamp-none ste:break-words">
                    {table.description}
                  </ItemDescription>
                  <p className="ste:text-xs ste:break-words ste:text-muted-foreground">
                    {presetDisplayStrategySummary(table)} · 向量分组：
                    {table.vectorIndex?.groups.length ?? 0}
                  </p>
                  {table.fields.length > 0 ? (
                    <p className="ste:text-xs ste:break-words">
                      {table.fields
                        .map(
                          (field) =>
                            `${field.name} · ${field.key} · ${field.type}${field.required ? " · 必填" : ""}${field.enabled ? "" : " · 停用"}`,
                        )
                        .join("，")}
                    </p>
                  ) : null}
                </ItemContent>
              </Item>
            </div>
          ))}
        </ItemGroup>
      </PageSection>
      <PageSection
        title="应用到空间"
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={dirty || !context}
            data-action="open-preset-update"
            onClick={() => setUpdateTarget(context!)}
          >
            比较并增量更新当前空间
          </Button>
        }
      >
        <div className="ste:flex ste:flex-col ste:gap-2">
          <Button
            type="button"
            variant="destructive"
            disabled={!context || dirty}
            onClick={() => {
              setApplyError(null);
              setApplying({ context: context!, preset: structuredClone(draft) });
            }}
          >
            应用到当前空间
          </Button>
          {dirty ? (
            <p className="ste:text-xs ste:text-muted-foreground">
              先保存预设修改，再应用到当前空间。
            </p>
          ) : null}
        </div>
      </PageSection>
      {!draft.builtIn ? (
        <Button type="button" variant="destructive" onClick={() => setDeleting(true)}>
          <Trash2 />
          删除预设
        </Button>
      ) : null}
      <ConfirmAction
        open={deleting}
        onOpenChange={setDeleting}
        title={`删除预设「${draft.name}」？`}
        description="已有空间保持原有内容；删除默认用户预设后，新空间改用系统默认。"
        confirmLabel="删除预设"
        destructive
        onConfirm={remove}
      />
      <AlertDialog
        open={applying !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setApplying(null);
        }}
      >
        <AlertDialogContent initialFocus={cancel}>
          <AlertDialogHeader>
            <AlertDialogTitle>应用表格预设并清空空间？</AlertDialogTitle>
            <AlertDialogDescription>
              将用「{applying?.preset.name}」重建「{applying?.context.title}
              」。当前表格、字段、全部记录、历史、证据与进度将被清除，对话文件镜像也会更新。建议先保存完整备份。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {applyError ? <StatusNotice variant="destructive">{applyError}</StatusNotice> : null}
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancel} disabled={busy}>
              取消
            </AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void apply(false)}
            >
              直接清空并应用
            </Button>
            <Button type="button" disabled={busy} onClick={() => void apply(true)}>
              {busy ? "正在处理…" : "备份并应用"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsEditor>
  );
}
