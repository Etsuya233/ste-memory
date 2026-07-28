import { ChevronLeft, ChevronRight, Plus, Search } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { listMemoryFields, type MemoryField } from "../api/memory-fields.ts";
import {
  listMemoryRecords,
  type MemoryRecord,
  type MemoryRecordPage,
} from "../api/memory-records.ts";
import type { MemoryTable } from "../api/memory-tables.ts";
import { RecordDialog } from "./RecordDialog.tsx";
import { formatMemoryFieldValue } from "./memory-record-value.ts";

export interface RecordSelection {
  readonly record: MemoryRecord;
  readonly fields: readonly MemoryField[];
}

interface RecordTableProps {
  readonly memorySpaceId: string;
  readonly table: MemoryTable;
  readonly onSelect: (selection: RecordSelection | undefined) => void;
  readonly refreshVersion: number;
}

export function RecordTable({ memorySpaceId, table, onSelect, refreshVersion }: RecordTableProps) {
  const [fields, setFields] = useState<MemoryField[]>([]);
  const [result, setResult] = useState<MemoryRecordPage>();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);

  function load(nextPage: number, nextSearch: string) {
    setLoading(true);
    setError(undefined);
    void Promise.all([
      listMemoryFields(memorySpaceId, table.id),
      listMemoryRecords(memorySpaceId, table.id, {
        page: nextPage,
        pageSize: 20,
        search: nextSearch,
      }),
    ])
      .then(([nextFields, nextResult]) => {
        setFields(nextFields);
        setResult(nextResult);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "无法读取记录"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    onSelect(undefined);
    load(page, search);
  }, [memorySpaceId, table.id, page, search, refreshVersion]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setSearch(searchInput);
  }

  const displayFieldIds = new Set(
    table.displayStrategy?.type === "field"
      ? [table.displayStrategy.fieldId]
      : [...(table.displayStrategy?.template.matchAll(/\{([^{}]+)\}/g) ?? [])].map(
          (match) => match[1],
        ),
  );
  const keyFields = fields
    .filter((field) => field.enabled && !displayFieldIds.has(field.id))
    .slice(0, 3);

  return (
    <div className="record-table-workspace">
      <div className="record-toolbar">
        <form className="record-search" onSubmit={submitSearch}>
          <Search size={16} />
          <input
            aria-label="搜索当前表格"
            placeholder="搜索显示文本、字段值或记录 ID"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </form>
        <button
          className="primary-button"
          type="button"
          disabled={!table.displayStrategy}
          onClick={() => setCreating(true)}
        >
          <Plus size={16} /> 创建记录
        </button>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
      {loading && !result ? (
        <div className="table-empty-state">
          <p>正在读取记录...</p>
        </div>
      ) : null}
      {!loading && result?.total === 0 ? (
        <div className="table-empty-state">
          <h3>{search ? "没有匹配记录" : "表中暂无记录"}</h3>
          <p>{search ? "调整搜索关键词后重试。" : "创建第一条当前记忆记录。"}</p>
        </div>
      ) : null}
      {result && result.total > 0 ? (
        <>
          <div className="record-table-scroll">
            <table className="record-table">
              <thead>
                <tr>
                  <th>显示文本</th>
                  {keyFields.map((field) => (
                    <th key={field.id}>{field.name}</th>
                  ))}
                  <th>记录 ID</th>
                  <th>来源</th>
                </tr>
              </thead>
              <tbody>
                {result.records.map((record) => (
                  <tr
                    key={record.id}
                    tabIndex={0}
                    onClick={() => onSelect({ record, fields })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") onSelect({ record, fields });
                    }}
                  >
                    <td>
                      <strong>{record.displayText || "未命名记录"}</strong>
                    </td>
                    {keyFields.map((field) => (
                      <td key={field.id}>
                        {formatMemoryFieldValue(record.payload[field.id], "—")}
                      </td>
                    ))}
                    <td>
                      <code>{record.id}</code>
                    </td>
                    <td>
                      {record.source.type === "manual"
                        ? "手动"
                        : record.source.sourceLocation || "有来源"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <footer className="record-pagination">
            <span>
              共 {result.total} 条 · 第 {result.page}/{result.totalPages} 页
            </span>
            <div>
              <button
                className="icon-button"
                type="button"
                aria-label="上一页"
                disabled={page <= 1}
                onClick={() => setPage((value) => value - 1)}
              >
                <ChevronLeft size={16} />
              </button>
              <button
                className="icon-button"
                type="button"
                aria-label="下一页"
                disabled={page >= result.totalPages}
                onClick={() => setPage((value) => value + 1)}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </footer>
        </>
      ) : null}
      {creating ? (
        <RecordDialog
          memorySpaceId={memorySpaceId}
          tableId={table.id}
          fields={fields}
          onClose={() => setCreating(false)}
          onSaved={(record) => {
            setCreating(false);
            load(page, search);
            onSelect({ record, fields });
          }}
        />
      ) : null}
    </div>
  );
}
