import { useState } from "react";
import {
  snapshotSaveActions,
  type ChatSnapshotSaveStatus,
} from "../../../features/chat-mirror/chat-snapshot-persistence.ts";
import { PageSection } from "../../components/page-section.tsx";
import { Button } from "../../primitives/button.tsx";
import { SaveErrorDetails } from "../../components/save-error-details.tsx";

/** 工作区切换对话或空间时重新挂载，旧请求结果不会留在新聊天的设置中。 */
export function SnapshotSyncControl({
  status,
  available,
  onSync,
}: {
  status: ChatSnapshotSaveStatus;
  available: boolean;
  onSync: () => Promise<void>;
}) {
  const [request, setRequest] = useState<
    { kind: "idle" | "running" | "done" } | { kind: "failed"; message: string }
  >({ kind: "idle" });
  const actions = snapshotSaveActions(status, available);
  const busy = request.kind === "running" || actions.busy;
  async function sync() {
    setRequest({ kind: "running" });
    try {
      await onSync();
      setRequest({ kind: "done" });
    } catch (cause) {
      // 请求可能在进入保存器前失败，设置页也须显示这部分实际原因。
      setRequest({
        kind: "failed",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  let message = "";
  if (!available) {
    message = "请先打开可用的已保存对话";
  } else if (busy) {
    message =
      status.cleanup.kind === "running"
        ? "正在清理旧辅助数据…"
        : status.kind === "queued"
          ? "正在等待保存…"
          : status.kind === "verifying"
            ? "正在核验聊天文件…"
            : status.kind === "confirming"
              ? "文件已核验，正在完成操作…"
              : "正在同步…";
  } else if (request.kind === "failed") {
    message = `同步失败：${request.message}`;
  } else if (status.kind === "failed") {
    message = status.humanMsg;
  } else if (status.cleanup.kind === "failed") {
    message = status.cleanup.message;
  } else if (request.kind === "done" && status.kind === "verified") {
    message = "同步完成";
  }
  return (
    <PageSection title="当前对话">
      <div
        className="ste:flex ste:flex-wrap ste:items-center ste:justify-between ste:gap-3"
        data-testid="snapshot-sync-control"
        data-save-state={status.kind}
        data-save-phase={status.kind === "failed" ? status.phase : undefined}
        data-cleanup-state={status.cleanup.kind}
      >
        <p className="ste:min-w-0 ste:flex-1 ste:basis-40 ste:text-sm ste:text-muted-foreground">
          保存当前对话在此浏览器中已提交的记忆。
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={!actions.canForceSync || busy}
          title={actions.disabledReason ?? undefined}
          data-action="force-sync-memory"
          onClick={() => void sync()}
        >
          {busy ? "同步中…" : "强制同步"}
        </Button>
        {message && (
          <div
            className="ste:min-w-0 ste:max-w-full ste:basis-full ste:text-xs ste:break-words ste:text-muted-foreground"
            aria-live="polite"
            data-testid="snapshot-sync-result"
          >
            {request.kind === "failed" ||
            status.kind === "failed" ||
            status.cleanup.kind === "failed" ? (
              <SaveErrorDetails message={message} />
            ) : (
              message
            )}
          </div>
        )}
      </div>
    </PageSection>
  );
}
