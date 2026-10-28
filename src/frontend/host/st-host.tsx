import { createRoot } from "react-dom/client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { chatIdentityKey } from "../../features/chat-binding/chat-space-manager.ts";
import type { SteMemoryRuntime } from "../../runtime.ts";
import { Button } from "../../ui/primitives/button.tsx";
import { BookOpen } from "lucide-react";
import { RecordsWorkspace } from "../pages/records-workspace.ts";
import { RecordsApp } from "../app.tsx";
import { FrontendPanel } from "./panel.tsx";

export function mountRecordsFrontend(runtime: SteMemoryRuntime): void {
  const host = document.createElement("div");
  host.id = "ste-memory-frontend-host";
  host.className = "stm-luma ste:contents";
  host.style.color = "var(--SmartThemeBodyColor)";
  const toolbar = document.getElementById("top-settings-holder");
  if (!toolbar) throw new Error("ST 顶部工具栏尚未就绪，无法挂载记忆工作台");
  toolbar.appendChild(host);
  const workspace = new RecordsWorkspace({
    tables: runtime.tables,
    fields: runtime.fields,
    records: runtime.records,
    assertContext(context) {
      const status = runtime.manager.getStatus();
      if (
        status?.kind !== "active" ||
        status.space.id !== context.spaceId ||
        chatIdentityKey(runtime.adapter.getChatSnapshot()) !== context.chatKey
      )
        throw new Error("当前对话已切换，草稿已保留，请返回原对话后保存");
    },
    onSaved: async (context) => {
      if (
        runtime.manager.getStatus()?.kind === "active" &&
        chatIdentityKey(runtime.adapter.getChatSnapshot()) === context.chatKey
      )
        await runtime.macro.kick();
    },
  });
  createRoot(host).render(<StFrontend runtime={runtime} workspace={workspace} />);
}

function StFrontend({
  runtime,
  workspace,
}: {
  runtime: SteMemoryRuntime;
  workspace: RecordsWorkspace;
}) {
  const [open, setOpen] = useState(false);
  const [tone, setTone] = useState<"light" | "dark">(() =>
    matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const status = useSyncExternalStore(
    (listener) => runtime.manager.onStatusChange(listener),
    () => runtime.manager.getStatus(),
  );
  const mirror = useSyncExternalStore(
    (listener) => runtime.mirror.onStatusChange(listener),
    () => runtime.mirror.getStatus(),
  );
  useEffect(() => {
    const synchronize = () => {
      const current = runtime.manager.getStatus();
      const chatKey = chatIdentityKey(runtime.adapter.getChatSnapshot());
      void workspace.setContext(
        current?.kind === "active" && chatKey
          ? {
              chatKey,
              spaceId: current.space.id,
              title: current.space.name,
            }
          : null,
      );
    };
    synchronize();
    return runtime.manager.onStatusChange(synchronize);
  }, [runtime, workspace]);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label="打开记忆工作台"
        aria-expanded={open}
        data-action="open-frontend"
        onClick={() => setOpen(true)}
      >
        <BookOpen />
      </Button>
      <FrontendPanel open={open} tone={tone}>
        <RecordsApp
          workspace={workspace}
          status={status}
          mirror={mirror}
          onClose={() => setOpen(false)}
          onToggleTone={() => setTone(tone === "light" ? "dark" : "light")}
          onRetryContext={() => runtime.manager.syncToCurrentChat()}
          onResolveBranch={(action) => {
            const current = runtime.manager.getStatus();
            if (current?.kind !== "branch-detected")
              throw new Error("当前对话状态已变化，请重新加载");
            return runtime.manager.resolveBranch(
              action === "clone" ? { action, sourceSpaceId: current.binding.spaceId } : { action },
            );
          }}
          onRetrySave={() => runtime.retryMemorySave()}
          getMessageAt={(floor) => runtime.adapter.getMessageAt(floor)}
          onJumpFloor={(floor) => runtime.adapter.scrollToFloor(floor)}
        />
      </FrontendPanel>
    </>
  );
}
