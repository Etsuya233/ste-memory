import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "../primitives/button.tsx";
import { Input } from "../primitives/input.tsx";
import { NativeSelect } from "../primitives/native-select.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../primitives/popover.tsx";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "../primitives/pagination.tsx";

/** Shared paging footer: previous/next, page-size choice and direct page jump. */
export function PagePagination({
  page,
  totalPages,
  total,
  pageSize,
  pageSizeOptions = [10, 20, 50, 100],
  disabled = false,
  label = "分页",
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  pageSizeOptions?: readonly number[];
  disabled?: boolean;
  label?: string;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pageInput, setPageInput] = useState(String(page));
  useEffect(() => {
    if (!open) setPageInput(String(page));
  }, [page, open]);
  return (
    <Pagination aria-label={label} className="ste:mx-0 ste:w-full">
      <PaginationContent className="ste:w-full ste:flex-nowrap ste:justify-between">
        <PaginationItem>
          <PaginationPrevious
            text=""
            size="icon"
            aria-label="上一页"
            disabled={disabled || page <= 1}
            onClick={() => onPageChange(page - 1)}
          />
        </PaginationItem>
        <PaginationItem>
          <Popover
            open={open}
            onOpenChange={(next) => {
              setOpen(next);
              if (next) setPageInput(String(page));
            }}
          >
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="ste:bg-muted/50 ste:px-2.5 ste:text-xs ste:font-normal ste:hover:bg-muted"
                />
              }
              aria-label={`分页设置，第 ${page}/${totalPages} 页，共 ${total} 条`}
            >
              <span className="ste:whitespace-nowrap">
                {page}/{totalPages} · {total} 条
              </span>
              <ChevronDown className="ste:size-3 ste:opacity-70" aria-hidden />
            </PopoverTrigger>
            <PopoverContent aria-label="分页设置" side="top" className="ste:w-64">
              <div className="ste:flex ste:flex-col ste:gap-2">
                <span className="ste:text-xs ste:font-medium ste:text-muted-foreground">
                  每页条数
                </span>
                <NativeSelect
                  size="sm"
                  aria-label="每页条数"
                  className="ste:w-full"
                  value={String(pageSize)}
                  disabled={disabled}
                  onChange={(event) => {
                    onPageSizeChange(Number(event.target.value));
                  }}
                >
                  {pageSizeOptions.map((size) => (
                    <option key={size} value={size}>
                      {size} 条/页
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <form
                className="ste:flex ste:flex-col ste:gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const requested = Number.parseInt(pageInput, 10);
                  const target = Number.isInteger(requested)
                    ? Math.min(Math.max(requested, 1), totalPages)
                    : page;
                  setOpen(false);
                  if (target !== page) onPageChange(target);
                  else setPageInput(String(page));
                }}
              >
                <span className="ste:text-xs ste:font-medium ste:text-muted-foreground">
                  跳转页码
                </span>
                <div className="ste:flex ste:items-center ste:gap-2">
                  <Input
                    aria-label="跳转页码"
                    className="ste:h-8 ste:min-w-0 ste:flex-1 ste:text-center"
                    inputMode="numeric"
                    placeholder={`1–${totalPages}`}
                    value={pageInput}
                    disabled={disabled || totalPages <= 1}
                    onChange={(event) => setPageInput(event.target.value.replace(/\D/g, ""))}
                    onBlur={() => {
                      if (pageInput === "") setPageInput(String(page));
                    }}
                  />
                  <Button type="submit" size="sm" disabled={disabled || totalPages <= 1}>
                    跳转
                  </Button>
                </div>
              </form>
            </PopoverContent>
          </Popover>
        </PaginationItem>
        <PaginationItem>
          <PaginationNext
            text=""
            size="icon"
            aria-label="下一页"
            disabled={disabled || page >= totalPages}
            onClick={() => onPageChange(page + 1)}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
