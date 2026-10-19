import type { AutoFillNotification } from "../../features/fill-tasks/auto-fill-service.ts";

/** 提醒复用同一个按钮，更新范围时不重复弹出。正文通过 textContent 写入。 */
export function showAutoFillNotification(notice: AutoFillNotification): void {
  const id = notice.kind === "reminder" ? "stm-auto-fill-reminder" : "stm-auto-fill-notice";
  let button = document.getElementById(id) as HTMLButtonElement | null;
  if (!button) {
    button = document.createElement("button");
    button.id = id;
    button.type = "button";
    button.className = "stm-auto-fill-notice";
    button.setAttribute("role", "status");
    document.body.append(button);
  }
  button.textContent = `${notice.message} · 点击查看`;
  button.onclick = () => {
    document.dispatchEvent(new CustomEvent("ste-memory:open-tasks", { detail: notice }));
    button.remove();
  };
  if (notice.kind !== "reminder") {
    const current = button;
    setTimeout(() => {
      if (current.textContent === `${notice.message} · 点击查看`) current.remove();
    }, 8000);
  }
}
