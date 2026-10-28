import { useRef } from "react";
import type {
  MemoryTable,
  MemoryTableId,
  MemoryRecordListOrder,
} from "../../features/memory/index.ts";
import { Button } from "../primitives/button.tsx";
import { Input } from "../primitives/input.tsx";
import { Badge } from "../primitives/badge.tsx";
import { Tabs, TabsList, TabsTrigger } from "../primitives/tabs.tsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../primitives/dropdown-menu.tsx";

/** Record-specific composition only: selection and draft guards stay in RecordsTab. */
export function RecordToolbar(props: {
  readonly tables: readonly MemoryTable[];
  readonly selectedTableId: MemoryTableId | null;
  readonly onSelectTable: (id: MemoryTableId) => void;
  readonly total: number;
  readonly search: string;
  readonly searchInput: string;
  readonly searchOpen: boolean;
  readonly onSearchInput: (value: string) => void;
  readonly onSearchOpen: (open: boolean) => void;
  readonly sortOptions: readonly { fieldId: MemoryRecordListOrder["fieldId"]; label: string }[];
  readonly order: MemoryRecordListOrder;
  readonly sortLabel: string;
  readonly onSort: (fieldId: MemoryRecordListOrder["fieldId"]) => void;
  readonly loading: boolean;
  readonly viewMode: "list" | "grid";
  readonly onViewMode: (mode: "list" | "grid") => void;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly onDiscard: () => void;
  readonly onSave: () => void;
  readonly hidden: boolean;
}) {
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  return (
    <section className="stm-record-toolbar" aria-label="记录工具栏" hidden={props.hidden}>
      <Tabs
        value={props.selectedTableId ?? ""}
        onValueChange={(value) => props.onSelectTable(value as MemoryTableId)}
      >
        <TabsList
          className="stm-record-tables ste:max-w-full ste:overflow-x-auto ste:justify-start"
          aria-label="选择表格"
          variant="line"
        >
          {props.tables.map((table) => (
            <TabsTrigger
              key={table.id}
              value={table.id}
              className={`stm-record-chip${!table.enabled ? " stm-record-chip--disabled" : ""}`}
              data-action="select-table"
              data-table-id={table.id}
              title={!table.enabled ? `${table.name}（已停用）` : table.name}
            >
              {table.name}
              {!table.enabled ? <span className="ste:sr-only">（已停用）</span> : null}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="stm-record-selector-row">
        <div className="stm-record-table-meta" aria-live="polite">
          <Badge variant="secondary">{props.total} 条记录</Badge>
          {props.search ? <span>“{props.search}”</span> : null}
        </div>
        <div className="stm-record-toolbar-controls">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  data-action="record-sort-toggle"
                  aria-label={`排序：${props.sortLabel} · ${props.order.direction === "asc" ? "升序" : "降序"}`}
                />
              }
            >
              {props.sortLabel} {props.order.direction === "asc" ? "↑" : "↓"}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {props.sortOptions.map((option) => (
                <DropdownMenuItem
                  key={option.fieldId}
                  data-action="record-sort-option"
                  aria-label={
                    option.fieldId === props.order.fieldId
                      ? `${option.label} · ${props.order.direction === "asc" ? "升序" : "降序"}`
                      : option.label
                  }
                  disabled={props.loading || !props.selectedTableId}
                  onClick={() => props.onSort(option.fieldId)}
                >
                  {option.label}
                  {option.fieldId === props.order.fieldId ? (
                    <span aria-hidden="true">{props.order.direction === "asc" ? "↑" : "↓"}</span>
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="stm-record-view-switch" role="group" aria-label="记录显示方式">
            <Button
              variant={props.viewMode === "list" ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={props.viewMode === "list"}
              data-action="records-list-view"
              onClick={() => props.onViewMode("list")}
            >
              列表
            </Button>
            <Button
              variant={props.viewMode === "grid" ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={props.viewMode === "grid"}
              data-action="records-grid-view"
              onClick={() => props.onViewMode("grid")}
            >
              批量编辑
            </Button>
          </div>
          <Button
            variant="ghost"
            size="sm"
            data-action="record-search-toggle"
            ref={searchToggleRef}
            aria-expanded={props.searchOpen}
            onClick={() => props.onSearchOpen(!props.searchOpen)}
          >
            {props.searchOpen ? "关闭搜索" : "搜索"}
          </Button>
        </div>
      </div>
      {props.searchOpen ? (
        <Input
          type="search"
          className="stm-record-search"
          data-action="record-search"
          data-stm-field="record-search"
          aria-label="搜索记录"
          placeholder="搜索当前表的记录…"
          autoFocus
          value={props.searchInput}
          onChange={(event) => props.onSearchInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              props.onSearchOpen(false);
              searchToggleRef.current?.focus();
            }
          }}
        />
      ) : null}
      {props.viewMode === "grid" ? (
        <div className="stm-record-actions">
          <span className="stm-record-grid-hint">点击单元格编辑 · Esc 撤销当前行</span>
          {props.dirty ? (
            <Button
              variant="outline"
              size="sm"
              data-action="discard-grid"
              disabled={props.saving}
              onClick={props.onDiscard}
            >
              放弃修改
            </Button>
          ) : null}
          <Button
            size="sm"
            data-action="save-grid"
            disabled={props.saving || !props.dirty}
            onClick={props.onSave}
          >
            {props.saving ? "保存中…" : "保存修改"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
