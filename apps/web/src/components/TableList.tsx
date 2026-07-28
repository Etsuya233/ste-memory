import { Plus, Table2 } from "lucide-react";
import type { MemoryTable } from "../api/memory-tables.ts";

interface TableListProps {
  readonly tables: readonly MemoryTable[];
  readonly selectedId?: string;
  readonly loading: boolean;
  readonly updatingId?: string;
  readonly disabled?: boolean;
  readonly onCreate: () => void;
  readonly onSelect: (id: string) => void;
  readonly onToggle: (table: MemoryTable, enabled: boolean) => void;
}

export function TableList(props: TableListProps) {
  return (
    <section className="table-navigation">
      <header className="table-navigation-heading">
        <div>
          <h2>记忆表格</h2>
          <span>{props.tables.length} 张表</span>
        </div>
        <button
          className="icon-button"
          type="button"
          title="创建自定义表"
          aria-label="创建自定义表"
          disabled={props.disabled}
          onClick={props.onCreate}
        >
          <Plus size={16} />
        </button>
      </header>
      {props.loading ? <div className="table-list-state">正在读取表格...</div> : null}
      {!props.loading && props.tables.length === 0 ? (
        <div className="table-list-state">
          <Table2 size={22} />
          <p>尚未创建记忆表格</p>
        </div>
      ) : null}
      <div className="table-list">
        {props.tables.map((table) => (
          <article
            className={`table-list-item ${table.id === props.selectedId ? "selected" : ""}`}
            key={table.id}
          >
            <button className="table-select" type="button" onClick={() => props.onSelect(table.id)}>
              <Table2 size={15} />
              <span>
                <strong>{table.name}</strong>
                <small>{table.enabled ? "已启用" : "已停用"}</small>
              </span>
            </button>
            <label className="table-toggle" title={table.enabled ? "停用表格" : "启用表格"}>
              <input
                type="checkbox"
                checked={table.enabled}
                disabled={props.updatingId === table.id}
                aria-label={`${table.enabled ? "停用" : "启用"} ${table.name}`}
                onChange={(event) => props.onToggle(table, event.target.checked)}
              />
              <span />
            </label>
          </article>
        ))}
      </div>
    </section>
  );
}
