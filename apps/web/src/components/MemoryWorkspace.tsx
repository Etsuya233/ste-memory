import { Database, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  createMemoryTable,
  deleteMemoryTable,
  listMemoryTables,
  updateMemoryTable,
  type MemoryTable,
  type MemoryTableInput,
  type MemoryTablePatch,
} from "../api/memory-tables.ts";
import {
  loadSourceChat,
  type MemorySpace,
  type SourceMessage,
  type SourceParseError,
} from "../api/memory-spaces.ts";
import { ChatViewer } from "./ChatViewer.tsx";
import { SpaceList } from "./SpaceList.tsx";
import { TableDialog } from "./TableDialog.tsx";
import { TableList } from "./TableList.tsx";
import { TableWorkspace } from "./TableWorkspace.tsx";

interface MemoryWorkspaceProps {
  readonly spaces: readonly MemorySpace[];
  readonly selectedSpaceId?: string;
  readonly loadingSpaces: boolean;
  readonly pageError?: string;
  readonly onDeleteSpace: (space: MemorySpace) => void;
  readonly onRefreshSpaces: () => void;
  readonly onRenameSpace: (space: MemorySpace) => void;
  readonly onSelectSpace: (id: string) => void;
}

export function MemoryWorkspace(props: MemoryWorkspaceProps) {
  const [tables, setTables] = useState<MemoryTable[]>([]);
  const [selectedTableId, setSelectedTableId] = useState<string>();
  const [messages, setMessages] = useState<SourceMessage[]>([]);
  const [parseErrors, setParseErrors] = useState<SourceParseError[]>([]);
  const [loadingContent, setLoadingContent] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string>();
  const [updatingId, setUpdatingId] = useState<string>();
  const [dialog, setDialog] = useState<
    { mode: "create" } | { mode: "delete"; table: MemoryTable }
  >();

  useEffect(() => {
    let active = true;
    setTables([]);
    setSelectedTableId(undefined);
    setMessages([]);
    setParseErrors([]);
    setWorkspaceError(undefined);
    setLoadingContent(false);
    if (!props.selectedSpaceId) return;

    setLoadingContent(true);
    void Promise.all([
      loadSourceChat(props.selectedSpaceId),
      listMemoryTables(props.selectedSpaceId),
    ])
      .then(([chat, loadedTables]) => {
        if (!active) return;
        setWorkspaceError(undefined);
        setMessages(chat.messages);
        setParseErrors(chat.errors);
        setTables(loadedTables);
        setSelectedTableId(loadedTables[0]?.id);
      })
      .catch((cause: unknown) => {
        if (active) {
          setWorkspaceError(cause instanceof Error ? cause.message : "无法读取空间内容");
        }
      })
      .finally(() => {
        if (active) setLoadingContent(false);
      });
    return () => {
      active = false;
    };
  }, [props.selectedSpaceId]);

  const selectedTable = tables.find((table) => table.id === selectedTableId);

  async function create(input: MemoryTableInput) {
    if (!props.selectedSpaceId) throw new Error("请先选择记忆空间");
    const created = await createMemoryTable(props.selectedSpaceId, input);
    setTables((current) => [...current, created]);
    setSelectedTableId(created.id);
  }

  async function update(table: MemoryTable, patch: MemoryTablePatch) {
    if (!props.selectedSpaceId) throw new Error("请先选择记忆空间");
    const updated = await updateMemoryTable(props.selectedSpaceId, table.id, patch);
    setTables((current) => current.map((item) => (item.id === updated.id ? updated : item)));
  }

  function replaceTable(table: MemoryTable) {
    setTables((current) => current.map((item) => (item.id === table.id ? table : item)));
  }

  async function toggle(table: MemoryTable, enabled: boolean) {
    setUpdatingId(table.id);
    setWorkspaceError(undefined);
    try {
      await update(table, { enabled });
    } catch (cause) {
      setWorkspaceError(cause instanceof Error ? cause.message : "无法修改启用状态");
    } finally {
      setUpdatingId(undefined);
    }
  }

  async function remove(table: MemoryTable) {
    if (!props.selectedSpaceId) throw new Error("请先选择记忆空间");
    await deleteMemoryTable(props.selectedSpaceId, table.id);
    setTables((current) => {
      const remaining = current.filter((item) => item.id !== table.id);
      setSelectedTableId((selected) => (selected === table.id ? remaining[0]?.id : selected));
      return remaining;
    });
  }

  return (
    <main className="workspace">
      <aside className="sidebar">
        <section className="space-navigation">
          <div className="sidebar-heading">
            <div>
              <h2>记忆空间</h2>
              <span>{props.spaces.length} 个会话</span>
            </div>
            <button
              className="icon-button"
              type="button"
              title="刷新列表"
              aria-label="刷新列表"
              disabled={props.loadingSpaces}
              onClick={props.onRefreshSpaces}
            >
              <RefreshCw size={16} className={props.loadingSpaces ? "spinning" : ""} />
            </button>
          </div>
          {props.pageError ? (
            <div className="page-error">API 连接失败：{props.pageError}</div>
          ) : null}
          {props.loadingSpaces && props.spaces.length === 0 ? (
            <div className="empty-list">正在读取...</div>
          ) : (
            <SpaceList
              spaces={props.spaces}
              selectedId={props.selectedSpaceId}
              onSelect={props.onSelectSpace}
              onRename={props.onRenameSpace}
              onDelete={props.onDeleteSpace}
            />
          )}
        </section>
        {workspaceError ? <div className="page-error">{workspaceError}</div> : null}
        <TableList
          tables={tables}
          selectedId={selectedTableId}
          loading={loadingContent && tables.length === 0}
          updatingId={updatingId}
          disabled={!props.selectedSpaceId}
          onCreate={() => setDialog({ mode: "create" })}
          onSelect={setSelectedTableId}
          onToggle={(table, enabled) => void toggle(table, enabled)}
        />
        <footer className="storage-note">
          <Database size={14} /> 原始消息保存在本机 Source Store
        </footer>
      </aside>
      <TableWorkspace
        table={selectedTable}
        tables={tables}
        memorySpaceId={props.selectedSpaceId}
        onSave={update}
        onTableUpdated={replaceTable}
        onDelete={(table) => setDialog({ mode: "delete", table })}
      />
      <aside className="chat-inspector">
        <ChatViewer messages={messages} errors={parseErrors} loading={loadingContent} />
      </aside>
      {dialog?.mode === "create" ? (
        <TableDialog mode="create" onClose={() => setDialog(undefined)} onCreate={create} />
      ) : null}
      {dialog?.mode === "delete" ? (
        <TableDialog
          mode="delete"
          table={dialog.table}
          onClose={() => setDialog(undefined)}
          onDelete={() => remove(dialog.table)}
        />
      ) : null}
    </main>
  );
}
