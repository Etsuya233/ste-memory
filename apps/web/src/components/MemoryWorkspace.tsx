import {
  Database,
  MessageSquareText,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Table2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { SpaceList } from "./SpaceList.tsx";
import { TableDialog } from "./TableDialog.tsx";
import { TableList } from "./TableList.tsx";
import { TableWorkspace } from "./TableWorkspace.tsx";
import { RecordInspector } from "./RecordInspector.tsx";
import type { RecordSelection } from "./RecordTable.tsx";
import { CollapsibleSection, IconButton, usePersistedState } from "../ui.tsx";

interface MemoryWorkspaceProps {
  readonly spaces: readonly MemorySpace[];
  readonly selectedSpaceId?: string;
  readonly loadingSpaces: boolean;
  readonly pageError?: string;
  /** 顶栏快速跳转：跨空间跳到指定表格。 */
  readonly jumpToTable?: { readonly tableId: string; readonly nonce: number };
  /** 侧栏收起状态（顶栏按钮控制）。 */
  readonly sidebarCollapsed: boolean;
  readonly onToggleSidebar: () => void;
  readonly onDeleteSpace: (space: MemorySpace) => void;
  readonly onRefreshSpaces: () => void;
  readonly onRenameSpace: (space: MemorySpace) => void;
  readonly onSelectSpace: (id: string) => void;
  /** 表格列表上抛，供顶栏全局搜索使用。 */
  readonly onTablesChange?: (tables: readonly MemoryTable[]) => void;
}

export function MemoryWorkspace(props: MemoryWorkspaceProps) {
  const [tables, setTables] = useState<MemoryTable[]>([]);
  const [selectedTableId, setSelectedTableId] = useState<string>();
  const [messages, setMessages] = useState<SourceMessage[]>([]);
  const [parseErrors, setParseErrors] = useState<SourceParseError[]>([]);
  const [loadingContent, setLoadingContent] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string>();
  const [updatingId, setUpdatingId] = useState<string>();
  const [recordSelection, setRecordSelection] = useState<RecordSelection>();
  const [recordRefreshVersion, setRecordRefreshVersion] = useState(0);
  const [contentRefreshVersion, setContentRefreshVersion] = useState(0);
  const [highlightedSourceIds, setHighlightedSourceIds] = useState<readonly number[]>([]);
  const [missingSourceIds, setMissingSourceIds] = useState<readonly (string | number)[]>([]);
  const [dialog, setDialog] = useState<
    { mode: "create" } | { mode: "delete"; table: MemoryTable }
  >();

  const [inspectorCollapsed, setInspectorCollapsed] = usePersistedState(
    "sm.inspector.collapsed",
    false,
  );
  const sidebarCollapsed = props.sidebarCollapsed;

  // 侧栏收起状态：由顶栏按钮 + 窄条按钮共同控制（状态提升到 App）
  const toggleSidebar = () => props.onToggleSidebar();

  // 表格列表上抛给顶栏搜索
  useEffect(() => {
    props.onTablesChange?.(tables);
  }, [props.onTablesChange, tables]);

  // 快速跳转：记录目标表格 id，等待对应空间的表格加载完成后选中
  const pendingTableJumpRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (props.jumpToTable) pendingTableJumpRef.current = props.jumpToTable.tableId;
  }, [props.jumpToTable]);
  useEffect(() => {
    if (!props.jumpToTable) return;
    const target = props.jumpToTable.tableId;
    if (tables.some((table) => table.id === target)) {
      setSelectedTableId(target);
      pendingTableJumpRef.current = undefined;
    }
  }, [props.jumpToTable, tables]);

  useEffect(() => {
    let active = true;
    setTables([]);
    setSelectedTableId(undefined);
    setMessages([]);
    setParseErrors([]);
    setWorkspaceError(undefined);
    setLoadingContent(false);
    setRecordSelection(undefined);
    setHighlightedSourceIds([]);
    setMissingSourceIds([]);
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
        const jumpTarget = pendingTableJumpRef.current;
        setSelectedTableId(
          jumpTarget && loadedTables.some((table) => table.id === jumpTarget)
            ? jumpTarget
            : loadedTables[0]?.id,
        );
        pendingTableJumpRef.current = undefined;
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
  }, [props.selectedSpaceId, contentRefreshVersion]);

  const selectedSpace = props.spaces.find((space) => space.id === props.selectedSpaceId);
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

  const workspaceClasses = [
    "workspace",
    sidebarCollapsed ? "sidebar-collapsed" : "",
    inspectorCollapsed ? "inspector-collapsed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <main className={workspaceClasses}>
      {sidebarCollapsed ? (
        <aside className="sidebar-rail">
          <IconButton
            label="展开侧栏"
           
            onClick={toggleSidebar}
          >
            <PanelLeftOpen size={17} />
          </IconButton>
          <div className="rail-divider" />
          <button
            type="button"
            className="rail-btn"
            title="展开侧栏 · 记忆空间"
            aria-label="展开侧栏 · 记忆空间"
            onClick={toggleSidebar}
          >
            <MessageSquareText size={16} />
          </button>
          <button
            type="button"
            className="rail-btn"
            title="展开侧栏 · 表格"
            aria-label="展开侧栏 · 表格"
            onClick={toggleSidebar}
          >
            <Table2 size={16} />
          </button>
        </aside>
      ) : (
        <aside className="sidebar">
          <div className="sidebar-scroll">
            <CollapsibleSection
              title="记忆空间"
              icon={MessageSquareText}
              count={`${props.spaces.length} 个`}
              storageKey="sm.section.spaces"
              flexible
              actions={
                <IconButton
                  label="刷新列表"
                 
                  disabled={props.loadingSpaces}
                  onClick={props.onRefreshSpaces}
                >
                  <RefreshCw size={14} className={props.loadingSpaces ? "spinning" : ""} />
                </IconButton>
              }
            >
              {props.pageError ? <div className="page-error">{props.pageError}</div> : null}
              {props.loadingSpaces && props.spaces.length === 0 ? (
                <div className="empty-state">
                  <MessageSquareText size={26} />
                  <p>正在读取空间列表...</p>
                </div>
              ) : (
                <SpaceList
                  spaces={props.spaces}
                  selectedId={props.selectedSpaceId}
                  onSelect={props.onSelectSpace}
                  onRename={props.onRenameSpace}
                  onDelete={props.onDeleteSpace}
                />
              )}
            </CollapsibleSection>

            <CollapsibleSection
              title="表格"
              icon={Table2}
              count={`${tables.length} 张`}
              storageKey="sm.section.tables"
              flexible
              actions={
                <IconButton
                  label="创建表格"
                  disabled={!props.selectedSpaceId}
                  onClick={() => setDialog({ mode: "create" })}
                >
                  <Plus size={14} />
                </IconButton>
              }
            >
              {!props.selectedSpaceId ? (
                <div className="empty-state">
                  <Table2 size={26} />
                  <p>选择或创建一个记忆空间后，这里会列出它的记忆表格。</p>
                </div>
              ) : (
                <TableList
                  tables={tables}
                  selectedId={selectedTableId}
                  loading={loadingContent && tables.length === 0}
                  updatingId={updatingId}
                  onCreate={() => setDialog({ mode: "create" })}
                  onSelect={setSelectedTableId}
                  onToggle={(table, enabled) => void toggle(table, enabled)}
                />
              )}
            </CollapsibleSection>
          </div>
          {workspaceError ? <div className="page-error sidebar-error">{workspaceError}</div> : null}
          <footer className="sidebar-storage-note">
            <Database size={12} /> 原始消息保存在本机 Source Store
          </footer>
        </aside>
      )}

      <TableWorkspace
        table={selectedTable}
        tables={tables}
        space={selectedSpace}
        memorySpaceId={props.selectedSpaceId}
        onSave={update}
        onTableUpdated={replaceTable}
        onDelete={(table) => setDialog({ mode: "delete", table })}
        onSelectRecord={setRecordSelection}
        recordRefreshVersion={recordRefreshVersion}
        onCleaningSaved={() => setContentRefreshVersion((value) => value + 1)}
      />

      {inspectorCollapsed ? (
        <aside className="inspector-rail">
          <IconButton
            label="展开检查器"
           
            onClick={() => setInspectorCollapsed(false)}
          >
            <PanelRightOpen size={17} />
          </IconButton>
        </aside>
      ) : (
        <aside className="inspector">
          <header className="inspector-header">
            <h3>检查器</h3>
            <IconButton
              label="收起检查器"
             
              onClick={() => setInspectorCollapsed(true)}
            >
              <PanelRightClose size={15} />
            </IconButton>
          </header>
          <RecordInspector
            selection={recordSelection}
            messages={messages}
            errors={parseErrors}
            loading={loadingContent}
            memorySpaceId={props.selectedSpaceId}
            onRecordMutation={(record) => {
              setRecordSelection(
                record && recordSelection
                  ? {
                      record,
                      fields: recordSelection.fields,
                      referenceRecords: recordSelection.referenceRecords,
                    }
                  : undefined,
              );
              setRecordRefreshVersion((value) => value + 1);
            }}
            onEvidenceSelect={(sourceIds, missingIds) => {
              setHighlightedSourceIds(sourceIds);
              setMissingSourceIds(missingIds);
            }}
            highlightedSourceIds={highlightedSourceIds}
            missingSourceIds={missingSourceIds}
          />
        </aside>
      )}

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
