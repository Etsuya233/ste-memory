import {
  CornerDownLeft,
  MessageSquareText,
  Search,
  Table2,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { MemorySpace } from "../api/memory-spaces.ts";
import type { MemoryTable } from "../api/memory-tables.ts";

interface QuickJumpProps {
  readonly spaces: readonly MemorySpace[];
  /** 当前选中空间的表格（跨空间跳转时由外层先切换空间再应用）。 */
  readonly tables: readonly MemoryTable[];
  readonly selectedSpaceId?: string;
  readonly disabled?: boolean;
  readonly onSelectSpace: (id: string) => void;
  readonly onSelectTable: (spaceId: string, tableId: string) => void;
}

interface JumpItem {
  readonly kind: "space" | "table";
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly spaceId: string;
  readonly tableId?: string;
}

/** 顶栏全局搜索：跨空间/表格快速跳转（Ctrl/Cmd+K 聚焦，↑↓ 选择，Enter 跳转）。 */
export function QuickJump({
  spaces,
  tables,
  selectedSpaceId,
  disabled = false,
  onSelectSpace,
  onSelectTable,
}: QuickJumpProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Ctrl/Cmd+K 聚焦
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const items = useMemo<readonly JumpItem[]>(() => {
    const q = query.trim().toLowerCase();
    const match = (text: string) => (q.length === 0 ? true : text.toLowerCase().includes(q));
    const spaceItems: JumpItem[] = spaces
      .filter((space) => match(space.name))
      .map((space) => ({
        kind: "space",
        id: space.id,
        label: space.name,
        detail: `${space.messageCount} 条消息`,
        spaceId: space.id,
      }));
    const tableItems: JumpItem[] = tables
      .filter((table) => match(table.name) || match(table.key))
      .map((table) => ({
        kind: "table",
        id: table.id,
        label: table.name,
        detail: table.enabled ? "已启用" : "已停用",
        spaceId: table.memorySpaceId,
        tableId: table.id,
      }));
    // 表格排在所属空间之后，其余空间表格排末尾
    const selectedTables = tableItems.filter((item) => item.spaceId === selectedSpaceId);
    const otherTables = tableItems.filter((item) => item.spaceId !== selectedSpaceId);
    return [...spaceItems, ...selectedTables, ...otherTables];
  }, [spaces, tables, query, selectedSpaceId]);

  function jump(item: JumpItem) {
    if (item.kind === "space") onSelectSpace(item.spaceId);
    else onSelectTable(item.spaceId, item.tableId!);
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((current) => Math.min(current + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter" && items[highlight]) {
      event.preventDefault();
      jump(items[highlight]);
    }
  }

  const spacesCount = items.filter((item) => item.kind === "space").length;
  const tableCount = items.length - spacesCount;

  return (
    <div className="topbar-search" ref={rootRef}>
      <div
        className="topbar-search-box"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => inputRef.current?.focus()}
      >
        <Search size={15} />
        <input
          ref={inputRef}
          value={query}
          disabled={disabled}
          placeholder="快速跳转：空间 / 表格…"
          aria-label="快速跳转"
          onFocus={() => {
            setOpen(true);
            setHighlight(0);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlight(0);
          }}
          onKeyDown={onInputKeyDown}
        />
        <span className="search-kbd">Ctrl K</span>
      </div>
      {open && !disabled ? (
        <div className="search-popover" role="listbox">
          {items.length === 0 ? (
            <div className="search-empty">没有匹配的空间或表格</div>
          ) : (
            <>
              {spacesCount > 0 ? (
                <div className="search-group">
                  <div className="search-group-title">
                    <MessageSquareText size={12} /> 记忆空间
                  </div>
                  {items
                    .filter((item) => item.kind === "space")
                    .map((item) => (
                      <SearchItem
                        key={item.id}
                        item={item}
                        icon={<MessageSquareText size={14} />}
                        highlighted={items.indexOf(item) === highlight}
                        onMouseEnter={() => setHighlight(items.indexOf(item))}
                        onClick={() => jump(item)}
                      />
                    ))}
                </div>
              ) : null}
              {tableCount > 0 ? (
                <div className="search-group">
                  <div className="search-group-title">
                    <Table2 size={12} /> 表格
                  </div>
                  {items
                    .filter((item) => item.kind === "table")
                    .map((item) => (
                      <SearchItem
                        key={item.id}
                        item={item}
                        icon={<Table2 size={14} />}
                        highlighted={items.indexOf(item) === highlight}
                        onMouseEnter={() => setHighlight(items.indexOf(item))}
                        onClick={() => jump(item)}
                      />
                    ))}
                </div>
              ) : null}
            </>
          )}
          <div className="search-footer">
            <span>
              <kbd>↑↓</kbd> 选择
            </span>
            <span>
              <kbd>Enter</kbd> 跳转
            </span>
            <span>
              <kbd>Esc</kbd> 关闭
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SearchItem({
  item,
  icon,
  highlighted,
  onMouseEnter,
  onClick,
}: {
  readonly item: JumpItem;
  readonly icon: React.ReactNode;
  readonly highlighted: boolean;
  readonly onMouseEnter: () => void;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`search-item ${highlighted ? "highlighted" : ""}`}
      role="option"
      aria-selected={highlighted}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
    >
      {icon}
      <span className="search-item-label">{item.label}</span>
      <span className="search-item-detail">
        {item.detail}
        <CornerDownLeft size={11} style={{ marginLeft: 8, opacity: highlighted ? 1 : 0 }} />
      </span>
    </button>
  );
}
