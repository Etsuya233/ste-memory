import type { ChatSnapshotSaveStatus } from "../../features/chat-mirror/chat-snapshot-persistence.ts";
import { Button } from "../primitives/button.tsx";

/** 文件状态始终来自 persistence，重试只保存待写快照，不重新提交页面操作。 */
export function SnapshotSaveNotice({
  status,
  onRetry,
}: {
  status: ChatSnapshotSaveStatus;
  onRetry: () => Promise<void>;
}) {
  if (status.kind !== "failed" && status.kind !== "saving") return null;
  return (
    <div
      className="ste:shrink-0 ste:border-b ste:border-border ste:px-4 ste:py-2 ste:text-xs ste:break-words ste:text-muted-foreground"
      aria-live="polite"
    >
      {status.kind === "saving" ? (
        "正在保存到对话文件…"
      ) : (
        <span className="ste:text-destructive">
          {status.humanMsg}{" "}
          <Button
            variant="link"
            size="xs"
            onClick={() => {
              // 保存器在拒绝 Promise 前已发布 failed；统一状态负责显示原因。
              void onRetry().catch((cause: unknown) =>
                console.error("对话快照保存重试失败", cause),
              );
            }}
          >
            重试保存
          </Button>
        </span>
      )}
    </div>
  );
}
