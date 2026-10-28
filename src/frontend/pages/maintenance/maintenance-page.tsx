import { useEffect, useRef, useState } from "react";
import { ArchiveRestore, Download, Trash2 } from "lucide-react";
import type { RecordsContext } from "../records-workspace.ts";
import { Button } from "../../../ui/primitives/button.tsx";
import { Input } from "../../../ui/primitives/input.tsx";
import { NativeSelect } from "../../../ui/primitives/native-select.tsx";
import { Field, FieldLabel, FieldDescription } from "../../../ui/primitives/field.tsx";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "../../../ui/primitives/card.tsx";
import { PageContent, PageHeader, type PageControls } from "../../components/page-layout.tsx";
import { SwitchField } from "../../components/form-fields.tsx";
import { StatusNotice } from "../../components/page-state.tsx";
import {
  ConfirmAction,
  usePageLeave,
  type RegisterLeaveGuard,
} from "../../components/confirmation.tsx";

export type MaintenanceScope = "all" | "current";
export interface MaintenanceOutcome {
  kind: "done" | "applied-with-sync-issue";
  message: string;
}
export interface MaintenanceImportPreview {
  scope: MaintenanceScope;
  spaceCount: number;
  recordCount: number;
  summary: string;
  confirmMessage: string;
  apply: () => Promise<MaintenanceOutcome>;
}
export interface MaintenanceServices {
  currentContext: () => RecordsContext | null;
  canImportCurrent: () => boolean;
  exportBackup: (scope: MaintenanceScope, includeHistory: boolean) => Promise<boolean>;
  previewImport: (text: string, scope: MaintenanceScope) => Promise<MaintenanceImportPreview>;
  clearRecords: (target: RecordsContext) => Promise<MaintenanceOutcome>;
}

export function MaintenancePage({
  services,
  controls,
  onBack,
  registerLeaveGuard,
}: {
  services: MaintenanceServices;
  controls: PageControls;
  onBack: () => void;
  registerLeaveGuard?: RegisterLeaveGuard;
}) {
  const context = services.currentContext();
  const contextKey = JSON.stringify([context?.chatKey, context?.spaceId]);
  const [exportScope, setExportScope] = useState<MaintenanceScope>("current");
  const [importScope, setImportScope] = useState<MaintenanceScope>("current");
  const [includeHistory, setIncludeHistory] = useState(true);
  const [preview, setPreview] = useState<MaintenanceImportPreview | null>(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<MaintenanceOutcome | null>(null);
  const [confirmImport, setConfirmImport] = useState(false);
  const [clearTarget, setClearTarget] = useState<RecordsContext | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setPreview(null);
    setConfirmImport(false);
    setClearTarget(null);
    setError(null);
    setFileName("");
  }, [contextKey]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const { requestLeave, confirmation } = usePageLeave({
    dirty: false,
    busy,
    scope: "maintenance",
    discard: () => setPreview(null),
    register: registerLeaveGuard,
  });
  useEffect(() => {
    if (!busy) return;
    const onUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [busy]);
  async function exportFile() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const token = generation.current;
    try {
      const saved = await services.exportBackup(exportScope, includeHistory);
      if (token === generation.current)
        setNotice({ kind: "done", message: saved ? "备份文件已导出。" : "已取消导出。" });
    } catch (cause) {
      if (token === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function readFile(file: File) {
    const token = ++generation.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    setPreview(null);
    setFileName(file.name);
    try {
      const prepared = await services.previewImport(await file.text(), importScope);
      if (token === generation.current) setPreview(prepared);
    } catch (cause) {
      if (token === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function mutate(action: () => Promise<MaintenanceOutcome>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const outcome = await action();
      // Synchronizing a restored space can change the current context itself.
      // Keep this operation's result visible through that synchronization.
      // A committed restore with a warning is complete, so remove the preview.
      setPreview(null);
      setFileName("");
      setClearTarget(null);
      setConfirmImport(false);
      setNotice(outcome);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <PageHeader
        title="备份与空间维护"
        subtitle={context?.title ?? "本机记忆数据"}
        {...controls}
        busy={busy}
        onBack={() => requestLeave(onBack)}
      />
      <PageContent className="ste:flex ste:flex-col ste:gap-4">
        {error && <StatusNotice variant="destructive">{error}</StatusNotice>}
        {notice && (
          <StatusNotice
            variant={notice.kind === "applied-with-sync-issue" ? "destructive" : "default"}
          >
            {notice.message}
          </StatusNotice>
        )}
        <Card size="sm">
          <CardHeader>
            <CardTitle>导出备份</CardTitle>
            <CardDescription>
              备份包含记忆结构与记录；插件设置、连接密钥、向量数据和日志分别保存在本机。
            </CardDescription>
          </CardHeader>
          <CardContent className="ste:flex ste:flex-col ste:gap-4">
            <Field>
              <FieldLabel htmlFor="backup-export-scope">导出范围</FieldLabel>
              <NativeSelect
                id="backup-export-scope"
                value={exportScope}
                disabled={busy}
                onChange={(event) => setExportScope(event.target.value as MaintenanceScope)}
              >
                <option value="current">当前对话的记忆空间</option>
                <option value="all">全部记忆空间</option>
              </NativeSelect>
            </Field>
            <SwitchField
              label="包含修订历史"
              checked={includeHistory}
              disabled={busy}
              onCheckedChange={setIncludeHistory}
            />
            <Button
              disabled={busy || (exportScope === "current" && !context)}
              onClick={() => void exportFile()}
            >
              <Download />
              导出 JSON 文件
            </Button>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle>从文件恢复</CardTitle>
            <CardDescription>
              先读取并校验文件，查看预览后再确认恢复。恢复会替换对应范围的数据。
            </CardDescription>
          </CardHeader>
          <CardContent className="ste:flex ste:flex-col ste:gap-4">
            <Field>
              <FieldLabel htmlFor="backup-import-scope">恢复范围</FieldLabel>
              <NativeSelect
                id="backup-import-scope"
                value={importScope}
                disabled={busy}
                onChange={(event) => {
                  setImportScope(event.target.value as MaintenanceScope);
                  generation.current++;
                  setPreview(null);
                  setFileName("");
                }}
              >
                <option value="current">导入当前对话</option>
                <option value="all">替换全部记忆数据</option>
              </NativeSelect>
              <FieldDescription>
                选择范围后重新选择文件，确认弹窗会显示具体替换范围。
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="backup-import-file">选择备份 JSON</FieldLabel>
              <Input
                key={`${importScope}-${contextKey}`}
                id="backup-import-file"
                type="file"
                accept=".json,application/json"
                disabled={busy || (importScope === "current" && !services.canImportCurrent())}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void readFile(file);
                }}
              />
            </Field>
            {preview && (
              <div
                className="ste:flex ste:flex-col ste:gap-3 ste:rounded-xl ste:bg-muted ste:p-3"
                data-testid="backup-preview"
              >
                <p className="ste:break-all ste:text-sm ste:font-medium">{fileName}</p>
                <p className="ste:text-sm">
                  {preview.spaceCount} 个空间 · {preview.recordCount} 条记录
                </p>
                <p className="ste:whitespace-pre-wrap ste:break-words ste:text-xs">
                  {preview.summary}
                </p>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => setConfirmImport(true)}
                >
                  <ArchiveRestore />
                  确认恢复此文件
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle>清除当前空间记录</CardTitle>
            <CardDescription>
              删除当前空间全部记录、修订历史、证据与填表进度，保留表格结构。对话文件镜像中的副本也会更新为空。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="destructive"
              disabled={busy || !context}
              onClick={() => setClearTarget(context)}
            >
              <Trash2 />
              清除当前空间记录
            </Button>
          </CardContent>
        </Card>
      </PageContent>
      <ConfirmAction
        open={confirmImport && preview !== null}
        onOpenChange={setConfirmImport}
        title="确认恢复备份？"
        description={preview?.confirmMessage}
        confirmLabel="执行恢复"
        destructive
        onConfirm={() => mutate(preview!.apply)}
      />
      <ConfirmAction
        open={clearTarget !== null}
        onOpenChange={(open) => {
          if (!open) setClearTarget(null);
        }}
        title={`清除「${clearTarget?.title ?? ""}」的全部记录？`}
        description="将删除记录、历史、证据与填表进度；表格结构保留。此操作无法撤销，建议先导出备份。"
        confirmLabel="确认清除记录"
        destructive
        onConfirm={() => mutate(() => services.clearRecords(clearTarget!))}
      />
      {confirmation}
    </div>
  );
}
