import { useEffect, useRef, useState } from "react";
import { ArchiveRestore, Download, Trash2 } from "lucide-react";
import type { RecordsContext } from "../records-workspace.ts";
import { Button } from "../../primitives/button.tsx";
import { Input } from "../../primitives/input.tsx";
import { Field, FieldLabel } from "../../primitives/field.tsx";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "../../primitives/card.tsx";
import { PageContent, PageHeader, type PageControls } from "../../components/page-layout.tsx";
import { StatusNotice } from "../../components/page-state.tsx";
import {
  ConfirmAction,
  usePageLeave,
  type RegisterLeaveGuard,
} from "../../components/confirmation.tsx";

export interface MaintenanceOutcome {
  kind: "done" | "applied-with-sync-issue" | "replacement-not-saved";
  message: string;
}
export interface MaintenanceImportPreview {
  recordCount: number;
  summary: string;
  confirmMessage: string;
  apply: () => Promise<MaintenanceOutcome>;
}
export interface MaintenanceServices {
  currentContext: () => RecordsContext | null;
  exportBackup: () => Promise<boolean>;
  previewImport: (text: string) => Promise<MaintenanceImportPreview>;
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
    setNotice(null);
    setFileName("");
    setBusy(false);
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
      const saved = await services.exportBackup();
      if (token === generation.current)
        setNotice({ kind: "done", message: saved ? "备份文件已导出。" : "已取消导出。" });
    } catch (cause) {
      if (token === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (token === generation.current) setBusy(false);
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
      const prepared = await services.previewImport(await file.text());
      if (token === generation.current) setPreview(prepared);
    } catch (cause) {
      if (token === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }
  async function mutate(action: () => Promise<MaintenanceOutcome>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const chatKey = context?.chatKey;
    try {
      const outcome = await action();
      // 导入会更换空间 ID；结果仍属于发起操作的对话，外部切聊后不可覆盖新页。
      if (services.currentContext()?.chatKey !== chatKey) return;
      setPreview(null);
      setFileName("");
      setClearTarget(null);
      setConfirmImport(false);
      setNotice(outcome);
    } catch (cause) {
      if (services.currentContext()?.chatKey === chatKey)
        setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      if (services.currentContext()?.chatKey === chatKey) setBusy(false);
    }
  }
  return (
    <div className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <PageHeader
        title="备份与空间维护"
        subtitle={context?.title ?? "当前对话记忆"}
        {...controls}
        busy={busy}
        onBack={() => requestLeave(onBack)}
      />
      <PageContent className="ste:space-y-4">
        {error && <StatusNotice variant="destructive">{error}</StatusNotice>}
        {notice && (
          <StatusNotice variant={notice.kind === "done" ? "default" : "destructive"}>
            {notice.message}
          </StatusNotice>
        )}
        <Card size="sm">
          <CardHeader>
            <CardTitle>导出备份</CardTitle>
            <CardDescription>
              导出当前对话的完整记忆空间，包含表格、字段、记录、修订历史与证据。插件设置、向量和
              Agent 会话单独保存在本机。
            </CardDescription>
          </CardHeader>
          <CardContent className="ste:flex ste:flex-col ste:gap-4">
            <Button disabled={busy || !context} onClick={() => void exportFile()}>
              <Download />
              导出 JSON 文件
            </Button>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle>导入当前对话</CardTitle>
            <CardDescription>
              先校验单个空间的文件并预览；确认后替换当前对话的记忆空间。
            </CardDescription>
          </CardHeader>
          <CardContent className="ste:flex ste:flex-col ste:gap-4">
            <Field>
              <FieldLabel htmlFor="backup-import-file">选择备份 JSON</FieldLabel>
              <Input
                key={contextKey}
                id="backup-import-file"
                type="file"
                accept=".json,application/json"
                disabled={busy || !context}
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
                <p className="ste:text-sm">{preview.recordCount} 条记录</p>
                <p className="ste:whitespace-pre-wrap ste:break-words ste:text-xs">
                  {preview.summary}
                </p>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => setConfirmImport(true)}
                >
                  <ArchiveRestore />
                  确认导入此文件
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle>清除当前空间记录</CardTitle>
            <CardDescription>
              删除当前空间全部记录、修订历史、证据与填表进度，保留表格结构。清除结果保存到当前对话文件。
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
        title="确认替换当前对话的记忆空间？"
        description={preview?.confirmMessage}
        confirmLabel="执行导入"
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
