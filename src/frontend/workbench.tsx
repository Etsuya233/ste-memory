import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BookOpen, TableProperties, ListTodo, Settings, Search } from "lucide-react";
import { Button } from "../ui/primitives/button.tsx";
import { RecordsPage, type RecordsPageProps } from "./pages/records-page.tsx";
import type { NavigationGuard } from "./components/confirmation.tsx";
import { TablesPage } from "./pages/tables/tables-page.tsx";
import type { TablesWorkspace } from "./pages/tables/tables-workspace.ts";
import type { TasksWorkspace } from "./pages/tasks/tasks-workspace.ts";
import type { AutoFillServices } from "./pages/tasks/auto-fill-overrides.tsx";
import { TasksPage } from "./pages/tasks/tasks-page.tsx";
import {
  SettingsPage,
  type SettingsServices,
  type SettingsSection,
} from "./pages/settings/SettingsPage.tsx";
import { SearchPage, type SearchServices } from "./pages/search/search-page.tsx";
import type { CleaningServices } from "./pages/settings/cleaning-rules-page.tsx";
import type { MacroServices } from "./pages/settings/macros-page.tsx";
import type { PresetSettingsServices } from "./pages/settings/preset-settings-services.ts";
import type { SettingsTools } from "./pages/settings/SettingsPage.tsx";
import { PageHeader } from "./components/page-layout.tsx";
import { PageEmpty } from "./components/page-state.tsx";

export interface WorkbenchProps extends RecordsPageProps {
  tables: TablesWorkspace;
  tasks: TasksWorkspace;
  autoFill: AutoFillServices;
  settings: SettingsServices;
  search: SearchServices;
  cleaning: CleaningServices;
  macros: MacroServices;
  presets: PresetSettingsServices;
  tools: SettingsTools;
  active?: boolean;
}

export function WorkbenchApp(props: WorkbenchProps) {
  const [page, setPage] = useState<"records" | "tables" | "tasks" | "search" | "settings">(
    "records",
  );
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("overview");
  const [logKey, setLogKey] = useState("");
  const { context } = useSyncExternalStore(props.workspace.subscribe, props.workspace.getSnapshot);
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
        props.tasks.hasUnsavedChanges() ||
        props.tools.query.store.hasPendingWrites() ||
        props.tools.query.store.storageError() !== null
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [props.workspace, props.tables, props.tasks, props.tools.query.store]);
  const controls = { onClose: () => navigate(props.onClose), onToggleTone: props.onToggleTone };
  const enabled = props.settings.settings.read().enabled;
  return (
    <div className="ste:flex ste:h-full ste:min-h-0 ste:flex-col ste:md:flex-row">
      <div className="ste:min-h-0 ste:min-w-0 ste:flex-1">
        {!enabled && page !== "settings" ? (
          <div className="ste:flex ste:h-full ste:flex-col">
            <PageHeader title="记忆工作台" {...controls} />
            <PageEmpty
              title="插件已停用"
              description="在设置页重新开启后，可以继续查看和管理当前对话的记忆。"
            />
          </div>
        ) : page === "records" ? (
          <RecordsPage {...props} {...controls} registerLeaveGuard={registerLeaveGuard} />
        ) : page === "tables" ? (
          <TablesPage
            workspace={props.tables}
            controls={controls}
            registerLeaveGuard={registerLeaveGuard}
          />
        ) : page === "search" ? (
          <SearchPage
            {...props.search}
            context={context}
            controls={controls}
            active={props.active ?? true}
            connection={props.settings.settings.read().embeddingConnection}
            onRecord={async (tableId, recordId) => {
              if (!context) throw new Error("请先打开对话");
              const epoch = props.search.service.getState().epoch;
              props.search.assertContext(context);
              await props.workspace.selectTable(tableId);
              props.search.assertContext(context);
              if (epoch !== props.search.service.getState().epoch) return;
              await props.workspace.openRecord(recordId);
              if (epoch === props.search.service.getState().epoch) setPage("records");
            }}
            onIndex={() => setPage("tables")}
            onSettings={() => {
              setSettingsSection("embedding");
              setPage("settings");
            }}
          />
        ) : page === "tasks" ? (
          <TasksPage
            workspace={props.tasks}
            autoFill={props.autoFill}
            onOpenLog={(key) =>
              navigate(() => {
                setLogKey(key);
                setSettingsSection("logs");
                setPage("settings");
              })
            }
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
            initialSection={settingsSection}
            initialLogKey={logKey}
            cleaning={props.cleaning}
            macros={props.macros}
            presets={props.presets}
            context={context}
            tools={props.tools}
            active={props.active ?? true}
          />
        )}
      </div>
      <nav
        aria-label="工作台页面"
        className="ste:flex ste:shrink-0 ste:gap-1 ste:border-t ste:border-border ste:bg-background ste:px-3 ste:pt-2 ste:pb-[max(0.5rem,env(safe-area-inset-bottom))] ste:md:order-first ste:md:w-20 ste:md:flex-col ste:md:justify-start ste:md:border-t-0 ste:md:border-r ste:md:p-2 ste:md:pt-4"
      >
        {(
          [
            { id: "records", label: "记录", icon: BookOpen },
            { id: "tables", label: "表格", icon: TableProperties },
            { id: "tasks", label: "任务", icon: ListTodo },
            { id: "search", label: "检索", icon: Search },
            { id: "settings", label: "设置", icon: Settings },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <Button
            key={id}
            variant={page === id ? "secondary" : "ghost"}
            className="ste:h-auto ste:min-h-12 ste:flex-1 ste:flex-col ste:gap-1 ste:py-2 ste:transition-colors ste:md:h-14 ste:md:flex-none"
            aria-current={page === id ? "page" : undefined}
            data-action={`nav-${id}`}
            onClick={() => {
              if (page !== id)
                navigate(() => {
                  if (id === "settings") {
                    setSettingsSection("overview");
                    setLogKey("");
                  }
                  setPage(id);
                });
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
