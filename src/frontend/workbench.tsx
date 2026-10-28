import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, TableProperties, ListTodo, Settings } from "lucide-react";
import { Button } from "../ui/primitives/button.tsx";
import { RecordsApp, type RecordsAppProps } from "./app.tsx";
import type { NavigationGuard } from "./components/confirmation.tsx";
import { TablesPage } from "./pages/tables/tables-page.tsx";
import type { TablesWorkspace } from "./pages/tables/tables-workspace.ts";
import type { TasksWorkspace } from "./pages/tasks/tasks-workspace.ts";
import { TasksPage } from "./pages/tasks/tasks-page.tsx";
import { SettingsPage, type SettingsServices } from "./pages/settings/SettingsPage.tsx";
import { PageHeader } from "./components/page-layout.tsx";
import { PageEmpty } from "./components/page-state.tsx";

export interface WorkbenchProps extends RecordsAppProps {
  tables: TablesWorkspace;
  tasks: TasksWorkspace;
  settings: SettingsServices;
  active?: boolean;
}

export function WorkbenchApp(props: WorkbenchProps) {
  const [page, setPage] = useState<"records" | "tables" | "tasks" | "settings">("records");
  const leaveGuard = useRef<NavigationGuard | null>(null);
  const registerLeaveGuard = useCallback((guard: NavigationGuard | null) => {
    leaveGuard.current = guard;
  }, []);
  function navigate(action: () => void) {
    if (leaveGuard.current) leaveGuard.current(action);
    else action();
  }
  useEffect(() => {
    const onUnload = (event: BeforeUnloadEvent) => {
      if (
        props.workspace.hasUnsavedChanges() ||
        props.tables.hasUnsavedChanges() ||
        props.tasks.hasUnsavedChanges()
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [props.workspace, props.tables, props.tasks]);
  const controls = { onClose: () => navigate(props.onClose), onToggleTone: props.onToggleTone };
  const enabled = props.settings.settings.read().enabled;
  return (
    <div className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <div className="ste:min-h-0 ste:flex-1">
        {!enabled && page !== "settings" ? (
          <div className="ste:flex ste:h-full ste:flex-col">
            <PageHeader title="记忆工作台" {...controls} />
            <PageEmpty
              title="插件已停用"
              description="在设置页重新开启后，可以继续查看和管理当前对话的记忆。"
            />
          </div>
        ) : page === "records" ? (
          <RecordsApp {...props} {...controls} registerLeaveGuard={registerLeaveGuard} />
        ) : page === "tables" ? (
          <TablesPage
            workspace={props.tables}
            controls={controls}
            registerLeaveGuard={registerLeaveGuard}
          />
        ) : page === "tasks" ? (
          <TasksPage
            workspace={props.tasks}
            controls={controls}
            registerLeaveGuard={registerLeaveGuard}
            active={props.active ?? true}
          />
        ) : (
          <SettingsPage
            services={props.settings}
            controls={controls}
            registerLeaveGuard={registerLeaveGuard}
            mirror={props.mirror}
          />
        )}
      </div>
      <nav
        aria-label="工作台页面"
        className="ste:flex ste:shrink-0 ste:gap-1 ste:border-t ste:border-border ste:bg-background ste:px-3 ste:pt-2 ste:pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        {(
          [
            { id: "records", label: "记录", icon: BookOpen },
            { id: "tables", label: "表格", icon: TableProperties },
            { id: "tasks", label: "任务", icon: ListTodo },
            { id: "settings", label: "设置", icon: Settings },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <Button
            key={id}
            variant={page === id ? "secondary" : "ghost"}
            className="ste:h-auto ste:min-h-12 ste:flex-1 ste:flex-col ste:gap-1 ste:py-2"
            aria-current={page === id ? "page" : undefined}
            data-action={`nav-${id}`}
            onClick={() => {
              if (page !== id) navigate(() => setPage(id));
            }}
          >
            <Icon />
            <span className="ste:text-xs">{label}</span>
          </Button>
        ))}
      </nav>
    </div>
  );
}
