import { Plus, Table2 } from "lucide-react";
import type { MemoryTable } from "../api/memory-tables.ts";
import { Switch } from "../ui.tsx";

interface TableListProps {
  readonly tables: readonly MemoryTable[];
  readonly selectedId?: string;
  readonly loading: boolean;
  readonly updatingId?: string;
  readonly onCreate: () => void;
  readonly onSelect: (id: string) => void;
  readonly onToggle: (table: MemoryTable, enabled: boolean) => void;
}

export function TableList(props: TableListProps) {
  if (props.loading) {
    return (
      <div className="empty-state">
        <Table2 size={26} />
        <p>正在读取表格...</p>
      </div>
    );
  }
  if (props.tables.length === 0) {
    return (
      <div className="empty-state">
        <Table2 size={26} />
        <strong>尚未创建记忆表格</strong>
        <p>系统表由填表任务自动生成；也可以手动创建自定义表。</p>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={props.onCreate}
          style={{ marginTop: 4 }}
        >
          <Plus size={13} /> 创建表格
        </button>
      </div>
    );
  }

  return (
    <div className="side-list">
      {props.tables.map((table) => (
        <article
          className={`side-list-item ${table.id === props.selectedId ? "selected" : ""}`}
          key={table.id}
        >
          <button className="side-list-main" type="button" onClick={() => props.onSelect(table.id)}>
            <span className="side-list-icon">
              <Table2 size={14} />
            </span>
            <span className="side-list-copy">
              <strong>{table.name}</strong>
              <small>
                {table.kind === "system" ? "系统表" : "自定义"} · {table.enabled ? "已启用" : "已停用"}
              </small>
            </span>
          </button>
          <Switch
            checked={table.enabled}
            disabled={props.updatingId === table.id}
            title={table.enabled ? "停用表格" : "启用表格"}
            aria-label={`${table.enabled ? "停用" : "启用"} ${table.name}`}
            onChange={(enabled) => props.onToggle(table, enabled)}
          />
        </article>
      ))}
    </div>
  );
}
