import { useLayoutEffect, useState } from "react";
import type { AutoFillNotification } from "../../features/fill-tasks/auto-fill-service.ts";
import { Toaster, toast, useToastManager } from "../primitives/toast.tsx";

const reminderId = "auto-fill-reminder";
const titles = {
  reminder: "有待填写的楼层",
  started: "自动填表已入队",
  completed: "自动填表已完成",
  failed: "自动填表需要处理",
} as const;
const types = { reminder: "info", started: "info", completed: "success", failed: "error" } as const;

// Runtime starts before React mounts. Keep startup notices until the Toast provider is ready.
let pending: AutoFillNotification[] = [];
let show: ((notice: AutoFillNotification) => void) | undefined;
export const autoFillNotifications = {
  show(notice: AutoFillNotification) {
    if (show) show(notice);
    else pending.push(notice);
  },
  dismissReminder() {
    pending = pending.filter((notice) => notice.kind !== "reminder");
    toast.close(reminderId);
  },
};

function NotificationLifecycle({
  surface,
  panelOpen,
  identity,
  onOpenTasks,
}: {
  surface: HTMLElement | null;
  panelOpen: boolean;
  identity: string | undefined;
  onOpenTasks: (identity: string) => void;
}) {
  const { toasts, add, close } = useToastManager();
  const visible = toasts.length > 0;
  useLayoutEffect(() => {
    show = (notice) => {
      if (notice.identity !== identity) return;
      const id = notice.kind === "reminder" ? reminderId : "auto-fill-status";
      add({
        id,
        title: titles[notice.kind],
        description: notice.message,
        type: types[notice.kind],
        timeout: notice.kind === "reminder" ? 0 : notice.kind === "failed" ? 12000 : 8000,
        priority: notice.kind === "failed" ? "high" : "low",
        actionProps: {
          children: "查看任务",
          onClick: () => {
            onOpenTasks(notice.identity);
            close(id);
          },
        },
      });
    };
    pending.forEach(show);
    pending = [];
    return () => {
      show = undefined;
      close();
    };
  }, [identity, onOpenTasks, add, close]);
  useLayoutEffect(() => {
    if (!surface || !visible) return;
    // Re-enter after the workbench so the native top layer never covers a notification.
    surface.showPopover();
    return () => surface.hidePopover();
  }, [surface, visible, panelOpen]);
  return null;
}

/** Global notices stay visible while the workbench is closed and share its theme. */
export function AutoFillToasts({
  tone,
  ...props
}: {
  tone: "light" | "dark";
  panelOpen: boolean;
  identity: string | undefined;
  onOpenTasks: (identity: string) => void;
}) {
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  return (
    <>
      <div
        id="ste-memory-notifications"
        ref={setSurface}
        popover="manual"
        className="stm-luma"
        data-tone={tone}
      />
      <Toaster container={surface} limit={3}>
        <NotificationLifecycle surface={surface} {...props} />
      </Toaster>
    </>
  );
}
