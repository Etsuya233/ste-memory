import type { ChatSnapshotSaveStatus } from "../../features/chat-mirror/chat-snapshot-persistence.ts";
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
  const cleanup = status.cleanupWarning && status.kind !== "failed";
  if (
    !cleanup &&
    (status.kind !== "failed" || status.operation === "force-sync") &&
    request.kind === "idle"
  ) {
    return null;
  }
  const busy =
    request.kind === "running" || status.kind === "saving" || status.kind === "verifying";
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
    >
      {busy ? (
        <span>
          {request.kind === "running"
            ? cleanup
              ? "正在重试清理…"
              : "正在重试保存…"
            : "正在保存记忆…"}
        </span>
      ) : (
        <SaveErrorDetails
          message={
            status.kind === "failed"
              ? status.humanMsg
              : cleanup
                ? status.cleanupWarning!
                : request.kind === "failed"
                  ? request.message
                  : ""
          }
        />
      )}
      <Button variant="link" size="xs" disabled={!available || busy} onClick={() => void retry()}>
        {cleanup ? "重试清理" : "重试保存"}
      </Button>
    </div>
  );
}
