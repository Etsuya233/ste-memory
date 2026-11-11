import { useEffect, useId, useRef, useState } from "react";
import type { HistoryVersion } from "../../../features/memory-history/history.ts";
import {
  ConfirmAction,
  usePageLeave,
  type RegisterLeaveGuard,
} from "../../components/confirmation.tsx";
import { formatCompactTime } from "../../components/format-time.ts";
import { PageContent, PageHeader, type PageControls } from "../../components/page-layout.tsx";
import { PageSection } from "../../components/page-section.tsx";
import { PageEmpty, PageError, StatusNotice } from "../../components/page-state.tsx";
import { SaveErrorDetails } from "../../components/save-error-details.tsx";
import { usePageScroll } from "../../components/use-page-scroll.ts";
import { Button } from "../../primitives/button.tsx";
import { Field, FieldLabel } from "../../primitives/field.tsx";
import { Input } from "../../primitives/input.tsx";
import type {
  MaintenanceContext,
  MaintenanceImportPreview,
  MaintenanceOutcome,
} from "./maintenance-page.tsx";

export interface HistoryServices {
  onAutomaticChange?(listener: (chatKey: string) => void): () => void;
  list(target: MaintenanceContext): Promise<HistoryVersion[]>;
  failure(target: MaintenanceContext): string | undefined;
  retryAutomatic(target: MaintenanceContext): Promise<void>;
  save(target: MaintenanceContext, name: string): Promise<void>;
  rename(target: MaintenanceContext, id: string, name: string): Promise<void>;
  remove(target: MaintenanceContext, id: string): Promise<void>;
  exportBackup(target: MaintenanceContext, id: string): Promise<boolean>;
  prepareRestore(target: MaintenanceContext, id: string): Promise<MaintenanceImportPreview>;
}

const sourceNames = {
  manual: "手动保存",
  automatic: "填表自动保存",
  "before-restore": "恢复前保存",
};

function rangeText(ranges: HistoryVersion["processedRanges"]) {
  return (
    ranges.map(({ from, to }) => (from === to ? `#${from}` : `#${from}–#${to}`)).join("、") || "无"
  );
}

type VersionAction =
  | { kind: "save" }
  | { kind: "rename"; version: HistoryVersion }
  | { kind: "remove"; version: HistoryVersion }
  | {
      kind: "restore";
      version: HistoryVersion;
      preview: MaintenanceImportPreview;
      spaceId: MaintenanceContext["spaceId"];
    };

export function MemoryHistoryPage({
  context,
  currentContext,
  services,
  controls,
  onBack,
  onSettings,
  registerLeaveGuard,
}: {
  context: MaintenanceContext | null;
  currentContext: () => MaintenanceContext | null;
  services: HistoryServices;
  controls: PageControls;
  onBack: () => void;
  onSettings: () => void;
  registerLeaveGuard?: RegisterLeaveGuard;
}) {
  const chatKey = context?.chatKey;
  const [versions, setVersions] = useState<HistoryVersion[] | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<VersionAction | null>(null);
  const [name, setName] = useState("");
  const [notice, setNotice] = useState<MaintenanceOutcome | null>(null);
  const [error, setError] = useState<string>();
  const nameId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const scroll = usePageScroll(services, `memory-history:${chatKey}`, versions !== null);
  const naming = action?.kind === "save" || action?.kind === "rename" ? action : null;
  const dirty = naming !== null && name !== (naming.kind === "rename" ? naming.version.name : "");
  const { requestLeave, confirmation } = usePageLeave({
    dirty,
    busy,
    scope: `memory-history:${chatKey}`,
    discard: () => setAction(null),
    register: registerLeaveGuard,
  });

  useEffect(() => {
    if (!chatKey) {
      return;
    }
    const target = currentContext();
    if (target?.chatKey !== chatKey) {
      return;
    }
    let active = true;
    void services.list(target).then(
      (result) => {
        if (active) {
          setVersions(result);
          setLoadError(undefined);
        }
      },
      (cause) => {
        if (active) {
          setLoadError(cause instanceof Error ? cause.message : String(cause));
        }
      },
    );
    return () => {
      active = false;
    };
  }, [chatKey, currentContext, services, reload]);

  useEffect(
    () =>
      services.onAutomaticChange?.((key) => {
        if (key === chatKey) {
          setReload((value) => value + 1);
        }
      }),
    [chatKey, services],
  );

  useEffect(() => {
    if (!busy && !dirty) {
      return;
    }
    const protect = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [busy, dirty]);
  useEffect(() => {
    if (naming) {
      nameInput.current?.focus();
    }
  }, [naming]);

  async function run(work: () => Promise<void>, confirm = false) {
    setBusy(true);
    setError(undefined);
    setNotice(null);
    try {
      await work();
    } catch (cause) {
      if (currentContext()?.chatKey === chatKey) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      if (confirm) {
        throw cause;
      }
    } finally {
      setReload((value) => value + 1);
      setBusy(false);
    }
  }

  const restoreAction =
    action?.kind === "restore" && action.spaceId === context?.spaceId ? action : null;
  const automaticFailure = context && services.failure(context);
  const removal = action?.kind === "remove" ? action : null;

  return (
    <div className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <PageHeader
        title="历史版本"
        subtitle={context?.title}
        {...controls}
        busy={busy}
        onBack={() => requestLeave(onBack)}
      />
      <PageContent ref={scroll.ref} onScroll={scroll.onScroll} className="ste:space-y-4">
        {error && (
          <StatusNotice variant="destructive">
            <SaveErrorDetails message={error} />
          </StatusNotice>
        )}
        {notice && (
          <StatusNotice variant={notice.kind === "done" ? "default" : "destructive"}>
            {notice.kind === "done" ? (
              notice.message
            ) : (
              <SaveErrorDetails message={notice.message} />
            )}
          </StatusNotice>
        )}
        {automaticFailure && context && (
          <StatusNotice variant="destructive">
            <SaveErrorDetails message={automaticFailure} />
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => services.retryAutomatic(context))}
            >
              重试保存自动版本
            </Button>
          </StatusNotice>
        )}
        <PageSection title="当前对话的版本">
          <p className="ste:mb-3 ste:text-sm ste:text-muted-foreground">
            历史保存在当前浏览器。换设备前可导出备份文件，清除站点数据会删除本机历史。
          </p>
          <div className="ste:flex ste:flex-wrap ste:gap-2">
            <Button
              disabled={busy || !context?.spaceId}
              onClick={() => {
                setName("");
                setAction({ kind: "save" });
              }}
            >
              保存版本
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => requestLeave(onSettings)}>
              自动保存设置
            </Button>
          </div>
        </PageSection>
        {naming && context && (
          <PageSection title={naming.kind === "rename" ? "重命名版本" : "保存当前记忆版本"}>
            <form
              className="ste:space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (busy) {
                  return;
                }
                void run(async () => {
                  if (naming.kind === "rename") {
                    await services.rename(context, naming.version.id, name.trim());
                    setNotice({ kind: "done", message: "版本已改名。" });
                  } else {
                    await services.save(context, name.trim());
                    setNotice({ kind: "done", message: "当前记忆版本已保存。" });
                  }
                  setAction(null);
                });
              }}
            >
              <Field>
                <FieldLabel htmlFor={nameId}>
                  版本名称{naming.kind === "save" ? "（可选）" : ""}
                </FieldLabel>
                <Input
                  ref={nameInput}
                  id={nameId}
                  value={name}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <div className="ste:flex ste:gap-2">
                <Button type="submit" disabled={busy || (naming.kind === "rename" && !name.trim())}>
                  保存
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setAction(null)}
                >
                  取消
                </Button>
              </div>
            </form>
          </PageSection>
        )}
        {loadError ? (
          <PageError error={loadError} onRetry={() => setReload((value) => value + 1)} />
        ) : !context ? (
          <PageEmpty title="请先打开对话" />
        ) : versions === null ? (
          <p role="status">正在加载历史版本…</p>
        ) : versions.length === 0 ? (
          <PageEmpty title="暂无历史版本" />
        ) : (
          <ul className="ste:m-0 ste:flex ste:list-none ste:flex-col ste:gap-3 ste:p-0">
            {versions.map((version) => (
              <li key={version.id}>
                <PageSection title={<span className="ste:break-all">{version.name}</span>}>
                  <p className="ste:text-sm ste:text-muted-foreground">
                    <time dateTime={version.createdAt}>{formatCompactTime(version.createdAt)}</time>{" "}
                    · {sourceNames[version.source]} · {version.recordCount} 条记录
                  </p>
                  <p className="ste:text-sm ste:text-muted-foreground">
                    {version.processedRanges.reduce(
                      (sum, range) => sum + range.to - range.from + 1,
                      0,
                    )}{" "}
                    层已处理 ·{" "}
                    {version.errorRanges.reduce((sum, range) => sum + range.to - range.from + 1, 0)}{" "}
                    层出错
                  </p>
                  <details className="ste:my-3 ste:text-sm">
                    <summary className="ste:cursor-pointer">版本详情</summary>
                    <dl className="ste:mt-2 ste:space-y-2 ste:break-words">
                      <div>
                        <dt>保存时间</dt>
                        <dd>
                          {new Date(version.createdAt).toLocaleString("zh-CN", { hour12: false })}
                        </dd>
                      </div>
                      <div>
                        <dt>已处理楼层</dt>
                        <dd>{rangeText(version.processedRanges)}</dd>
                      </div>
                      <div>
                        <dt>出错楼层</dt>
                        <dd>{rangeText(version.errorRanges)}</dd>
                      </div>
                      <div>
                        <dt>其余楼层</dt>
                        <dd>未跟踪</dd>
                      </div>
                      <div>
                        <dt>存储大小</dt>
                        <dd>
                          {version.compression} {version.compressedBytes.toLocaleString()} 字节 ·
                          原始 {version.originalBytes.toLocaleString()} 字节
                        </dd>
                      </div>
                    </dl>
                  </details>
                  <div className="ste:flex ste:flex-wrap ste:gap-2">
                    <Button
                      size="sm"
                      disabled={busy || !context.spaceId}
                      onClick={() =>
                        void run(async () => {
                          const preview = await services.prepareRestore(context, version.id);
                          if (
                            currentContext()?.chatKey === chatKey &&
                            currentContext()?.spaceId === context.spaceId
                          ) {
                            setAction({
                              kind: "restore",
                              version,
                              preview,
                              spaceId: context.spaceId,
                            });
                          }
                        })
                      }
                    >
                      恢复
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setName(version.name);
                        setAction({ kind: "rename", version });
                      }}
                    >
                      改名
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const saved = await services.exportBackup(context, version.id);
                          setNotice({
                            kind: "done",
                            message: saved ? "版本备份已导出。" : "已取消导出。",
                          });
                        })
                      }
                    >
                      导出
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => setAction({ kind: "remove", version })}
                    >
                      删除
                    </Button>
                  </div>
                </PageSection>
              </li>
            ))}
          </ul>
        )}
      </PageContent>
      {removal && context && (
        <ConfirmAction
          open
          onOpenChange={(open) => {
            if (!open) {
              setAction(null);
            }
          }}
          title="删除历史版本？"
          description={`将删除「${removal.version.name}」的本机副本，当前记忆空间保留。`}
          confirmLabel="确认删除"
          destructive
          onConfirm={() => run(() => services.remove(context, removal.version.id), true)}
        />
      )}
      {restoreAction && (
        <ConfirmAction
          open
          onOpenChange={(open) => {
            if (!open) {
              setAction(null);
            }
          }}
          title="恢复此版本并替换当前空间？"
          description={
            <span className="ste:block ste:max-h-[40vh] ste:overflow-auto ste:whitespace-pre-wrap ste:break-words">{`「${restoreAction.version.name}」 · ${restoreAction.preview.recordCount} 条记录\n已处理：${rangeText(restoreAction.version.processedRanges)}\n出错：${rangeText(restoreAction.version.errorRanges)}\n${restoreAction.preview.summary}\n${restoreAction.preview.confirmMessage}\n恢复前会保存当前已提交的记忆空间。聊天正文保留。`}</span>
          }
          confirmLabel="确认恢复"
          destructive
          onConfirm={() =>
            run(async () => {
              try {
                setNotice(await restoreAction.preview.apply());
              } finally {
                // A preparation describes one specific state. Open a fresh preview before another attempt.
                setAction(null);
              }
            })
          }
        />
      )}
      {confirmation}
    </div>
  );
}
