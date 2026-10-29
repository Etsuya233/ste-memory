import { ArrowDown, ArrowUp } from "lucide-react";
import type { MemoryField, MemoryRecordListOrder } from "../../features/memory/index.ts";
import { recordSortOptions } from "../models/memory/record-sort-model.ts";
import { Button } from "../../ui/primitives/button.tsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "../../ui/primitives/dropdown-menu.tsx";

export function RecordSortMenu({
  fields,
  order,
  disabled,
  onSelect,
}: {
  fields: readonly MemoryField[];
  order: MemoryRecordListOrder;
  disabled: boolean;
  onSelect: (fieldId: MemoryRecordListOrder["fieldId"]) => void;
}) {
  const options = recordSortOptions(fields);
  const selected = options.find((option) => option.fieldId === order.fieldId)!;
  const direction = order.direction === "asc" ? "升序" : "降序";
  const Icon = order.direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={<Button variant="outline" className="ste:max-w-40" />}
        aria-label={`排序：${selected.label}，${direction}`}
        data-action="record-sort"
      >
        <Icon data-icon="inline-start" />
        <span className="ste:truncate">{selected.label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="ste:w-64 ste:max-w-[calc(100vw-2rem)]">
        <DropdownMenuGroup>
          <DropdownMenuLabel>再次选择当前字段可切换升降序</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={order.fieldId}>
            {options.map((option) => (
              <DropdownMenuRadioItem
                key={option.fieldId}
                value={option.fieldId}
                closeOnClick
                onClick={() => onSelect(option.fieldId)}
                className="ste:whitespace-normal ste:break-words"
                data-sort-field={option.fieldId}
              >
                {option.fieldId.startsWith("$") ? option.label : `字段：${option.label}`}
                {option.fieldId === order.fieldId ? (
                  <span className="ste:text-xs ste:text-muted-foreground">{direction}</span>
                ) : null}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
