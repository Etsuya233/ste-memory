import { BrainCircuit, PanelLeftClose, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  createMemorySpace,
  deleteMemorySpace,
  listMemorySpaces,
  renameMemorySpace,
  type MemorySpace,
} from "./api/memory-spaces.ts";
import type { MemoryTable } from "./api/memory-tables.ts";
import { fetchSystemHealth, type SystemHealth } from "./api/system-health.ts";
import { MemoryWorkspace } from "./components/MemoryWorkspace.tsx";
import { QuickJump } from "./components/QuickJump.tsx";
import { SpaceDialog } from "./components/SpaceDialog.tsx";
import { Button, IconButton, usePersistedState } from "./ui.tsx";

type DialogState =
  | { readonly mode: "create" }
  | { readonly mode: "rename" | "delete"; readonly space: MemorySpace };

const HEALTH_POLL_MS = 30_000;

export function App() {
  const [spaces, setSpaces] = useState<MemorySpace[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [loadingSpaces, setLoadingSpaces] = useState(true);
  const [pageError, setPageError] = useState<string>();
  const [dialog, setDialog] = useState<DialogState>();
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string>();

  // 顶栏快速跳转用：表格列表由 MemoryWorkspace 上抛
  const [jumpTables, setJumpTables] = useState<readonly MemoryTable[]>([]);
  const [jumpToTable, setJumpToTable] = useState<{ tableId: string; nonce: number }>();

  // 侧栏收起（顶栏按钮 + 侧栏窄条均可切换）
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistedState(
    "sm.sidebar.collapsed",
    false,
  );

  // 服务健康（API + SQLite）
  const [health, setHealth] = useState<SystemHealth>();

  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const next = await fetchSystemHealth();
        if (active) setHealth(next);
      } catch {
        if (active) setHealth(undefined);
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), HEALTH_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const refreshSpaces = useCallback(async () => {
    setLoadingSpaces(true);
    setPageError(undefined);
    try {
      const result = await listMemorySpaces();
      setSpaces(result);
      setSelectedId((current) =>
        current && result.some((space) => space.id === current) ? current : result[0]?.id,
      );
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "无法读取记忆空间");
    } finally {
      setLoadingSpaces(false);
    }
  }, []);

  useEffect(() => void refreshSpaces(), [refreshSpaces]);

  function openDialog(state: DialogState) {
    setDialogError(undefined);
    setDialog(state);
  }

  async function runDialogAction(action: () => Promise<void>) {
    setDialogBusy(true);
    setDialogError(undefined);
    try {
      await action();
      setDialog(undefined);
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : "操作失败");
    } finally {
      setDialogBusy(false);
    }
  }

  async function create(name: string, file: File) {
    await runDialogAction(async () => {
      const created = await createMemorySpace(name, file);
      setSpaces((current) => [created, ...current]);
      setSelectedId(created.id);
    });
  }

  async function rename(name: string) {
    if (!dialog || dialog.mode !== "rename") return;
    const id = dialog.space.id;
    await runDialogAction(async () => {
      const renamed = await renameMemorySpace(id, name);
      setSpaces((current) => current.map((space) => (space.id === id ? renamed : space)));
    });
  }

  async function remove() {
    if (!dialog || dialog.mode !== "delete") return;
    const id = dialog.space.id;
    await runDialogAction(async () => {
      await deleteMemorySpace(id);
      setSpaces((current) => {
        const remaining = current.filter((space) => space.id !== id);
        setSelectedId((selected) => (selected === id ? remaining[0]?.id : selected));
        return remaining;
      });
    });
  }

  function jumpToTableInSpace(spaceId: string, tableId: string) {
    setSelectedId(spaceId);
    setJumpToTable((current) => ({ tableId, nonce: (current?.nonce ?? 0) + 1 }));
  }

  const apiOk = health?.api === "ok";
  const dbOk = health?.database.connected === true;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <BrainCircuit size={19} />
          </div>
          <div className="brand-copy">
            <h1>STE Memory</h1>
            <span>记忆工作台</span>
          </div>
        </div>

        <IconButton
          label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
          className="topbar-sidebar-toggle"
          onClick={() => setSidebarCollapsed((current) => !current)}
        >
          <PanelLeftClose size={16} />
        </IconButton>

        <QuickJump
          spaces={spaces}
          tables={jumpTables}
          selectedSpaceId={selectedId}
          disabled={loadingSpaces && spaces.length === 0}
          onSelectSpace={setSelectedId}
          onSelectTable={jumpToTableInSpace}
        />

        <div className="topbar-actions">
          <span
            className="health-pill"
            title={dbOk ? "API 与数据库正常" : "API 或数据库不可用"}
          >
            <span className={`health-dot ${apiOk && dbOk ? "ok" : "bad"}`} />
            <span className="health-text">
              {apiOk && dbOk ? "服务正常" : apiOk ? "数据库离线" : "API 离线"}
            </span>
          </span>
          <Button
            variant="primary"
            icon={<Plus size={16} />}
            onClick={() => openDialog({ mode: "create" })}
          >
            创建空间
          </Button>
        </div>
      </header>

      <MemoryWorkspace
        spaces={spaces}
        selectedSpaceId={selectedId}
        loadingSpaces={loadingSpaces}
        pageError={pageError}
        jumpToTable={jumpToTable}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((current) => !current)}
        onTablesChange={setJumpTables}
        onRefreshSpaces={() => void refreshSpaces()}
        onSelectSpace={setSelectedId}
        onRenameSpace={(space) => openDialog({ mode: "rename", space })}
        onDeleteSpace={(space) => openDialog({ mode: "delete", space })}
      />

      {dialog ? (
        <SpaceDialog
          mode={dialog.mode}
          space={dialog.mode === "create" ? undefined : dialog.space}
          busy={dialogBusy}
          error={dialogError}
          onClose={() => setDialog(undefined)}
          onCreate={create}
          onRename={rename}
          onDelete={remove}
        />
      ) : null}
    </div>
  );
}
