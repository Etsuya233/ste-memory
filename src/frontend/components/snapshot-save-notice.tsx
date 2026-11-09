import {
  snapshotSaveActions,
  type ChatSnapshotSaveStatus,
} from "../../features/chat-mirror/chat-snapshot-persistence.ts";
import { Button } from "../primitives/button.tsx";
import { useState } from "react";
import { SaveErrorDetails } from "./save-error-details.tsx";

/** 仅在保存需要处理时提示，重试不会重新提交业务操作。 */
export function SnapshotSaveNotice({
  status,
  available,
  onRetry,
}: {
  status: ChatSnapshotSaveStatus;
  available: boolean;
  onRetry: () => Promise<void>;
}) {
  const [request, setRequest] = useState<
    { kind: "idle" | "running" } | { kind: "failed"; message: string }
  >({ kind: "idle" });
  const actions = snapshotSaveActions(status, available);
  const cleanup = actions.recovery === "retry-cleanup" || status.cleanup.kind === "running";
  if (
    !cleanup &&
    (status.kind !== "failed" || status.operation === "force-sync") &&
    request.kind === "idle"
  ) {
    return null;
  }
  const busy = request.kind === "running" || actions.busy;
  async function retry() {
    setRequest({ kind: "running" });
    try {
      await onRetry();
      setRequest({ kind: "idle" });
    } catch (cause) {
      setRequest({
        kind: "failed",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return (
    <div
      className="ste:flex ste:shrink-0 ste:flex-wrap ste:items-center ste:gap-2 ste:border-b ste:border-border ste:px-4 ste:py-2 ste:text-xs ste:break-words ste:text-destructive"
      aria-live="polite"
      data-testid="snapshot-save-notice"
      data-save-state={status.kind}
      data-save-phase={status.kind === "failed" ? status.phase : undefined}
      data-cleanup-state={status.cleanup.kind}
    >
      {busy ? (
        <span>
          {request.kind === "running"
            ? cleanup
              ? "正在重试清理…"
              : "正在重试保存…"
            : status.kind === "queued"
              ? "正在等待保存…"
              : status.kind === "verifying"
                ? "正在核验聊天文件…"
                : status.kind === "confirming"
                  ? "文件已核验，正在完成操作…"
                  : "正在保存记忆…"}
        </span>
      ) : (
        <SaveErrorDetails
          message={
            status.kind === "failed"
              ? status.humanMsg
              : status.cleanup.kind === "failed"
                ? status.cleanup.message
                : request.kind === "failed"
                  ? request.message
                  : ""
          }
        />
      )}
      <Button
        variant="link"
        size="xs"
        disabled={!actions.canRetry || busy}
        title={actions.disabledReason ?? undefined}
        onClick={() => void retry()}
      >
        {cleanup ? "重试清理" : "重试保存"}
      </Button>
    </div>
  );
}
