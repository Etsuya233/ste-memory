import { Columns3, Database, Save, Settings2, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { MemoryTable, MemoryTablePatch } from "../api/memory-tables.ts";
import { FieldEditor } from "./FieldEditor.tsx";
import { RecordTable, type RecordSelection } from "./RecordTable.tsx";

interface TableWorkspaceProps {
  readonly table?: MemoryTable;
  readonly tables: readonly MemoryTable[];
  readonly memorySpaceId?: string;
  readonly onDelete: (table: MemoryTable) => void;
  readonly onSave: (table: MemoryTable, patch: MemoryTablePatch) => Promise<void>;
  readonly onTableUpdated: (table: MemoryTable) => void;
  readonly onSelectRecord: (selection: RecordSelection | undefined) => void;
  readonly recordRefreshVersion: number;
}

export function TableWorkspace({
  table,
  tables,
  memorySpaceId,
  onDelete,
  onSave,
  onTableUpdated,
  onSelectRecord,
  recordRefreshVersion,
}: TableWorkspaceProps) {
  const [tab, setTab] = useState<"data" | "fields">("data");
  const [tableKey, setTableKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setTableKey(table?.key ?? "");
    setName(table?.name ?? "");
    setDescription(table?.description ?? "");
    setPrompt(table?.prompt ?? "");
    setEnabled(table?.enabled ?? true);
    setError(undefined);
  }, [table]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!table) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSave(table, { key: tableKey, name, description, prompt, enabled });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法保存表格配置");
    } finally {
      setBusy(false);
    }
  }

  if (!table) {
    return (
      <section className="table-workspace empty-workspace">
        <Columns3 size={30} />
        <h2>选择一张记忆表格</h2>
        <p>表格的数据和字段配置会显示在这里。</p>
      </section>
    );
  }

  return (
    <section className="table-workspace">
      <header className="table-workspace-header">
        <div>
          <span className={`status-label ${table.enabled ? "enabled" : "disabled"}`}>
            {table.enabled ? "已启用" : "已停用"}
          </span>
          <h2>{table.name}</h2>
          <p>{table.description || "暂无描述"}</p>
        </div>
        <button
          className="icon-button danger"
          type="button"
          title="删除表格"
          aria-label={`删除 ${table.name}`}
          onClick={() => onDelete(table)}
        >
          <Trash2 size={16} />
        </button>
      </header>
      <nav className="table-tabs" aria-label="表格视图">
        <button
          className={tab === "data" ? "active" : ""}
          type="button"
          onClick={() => setTab("data")}
        >
          <Database size={15} /> 数据查看
        </button>
        <button
          className={tab === "fields" ? "active" : ""}
          type="button"
          onClick={() => setTab("fields")}
        >
          <Settings2 size={15} /> 字段配置
        </button>
      </nav>
      {tab === "data" ? (
        memorySpaceId ? (
          <RecordTable
            key={table.id}
            memorySpaceId={memorySpaceId}
            table={table}
            onSelect={onSelectRecord}
            refreshVersion={recordRefreshVersion}
          />
        ) : null
      ) : (
        <div className="table-definition-workspace">
          <form className="table-config-form" onSubmit={(event) => void save(event)}>
            <div className="config-heading">
              <div>
                <h3>表格配置</h3>
                <p>这些设置只影响当前记忆空间。</p>
              </div>
              <button className="primary-button" type="submit" disabled={busy}>
                <Save size={15} /> {busy ? "保存中..." : "保存"}
              </button>
            </div>
            <label>
              <span>表格 Key</span>
              <input
                required
                maxLength={120}
                value={tableKey}
                onChange={(event) => setTableKey(event.target.value)}
              />
            </label>
            <label>
              <span>表格名称</span>
              <input
                required
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              <span>描述</span>
              <textarea
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <label>
              <span>表级 Prompt</span>
              <textarea
                rows={8}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
            <label className="config-checkbox">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              <span>参与 Agent 自动填写</span>
            </label>
            {error ? <p className="form-error">{error}</p> : null}
          </form>
          {memorySpaceId ? (
            <FieldEditor
              key={table.id}
              memorySpaceId={memorySpaceId}
              table={table}
              tables={tables}
              onTableUpdated={onTableUpdated}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}
