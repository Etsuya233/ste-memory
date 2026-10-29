import type { MemoryField, MemoryRecord, MemoryRecordId } from "../../features/memory/index.ts";
import { recordFieldValueText } from "../models/memory/record-form-model.ts";
import { Badge } from "../../ui/primitives/badge.tsx";
import { Button } from "../../ui/primitives/button.tsx";
import { Pencil } from "lucide-react";

/**
 * Read-only projection of the current records page; editing uses the shared record editor.
 * A definite cell height lets 100%-height buttons fill the row even when another field is taller.
 */
export function RecordsTable({
  fields,
  records,
  labels,
  offset,
  onEdit,
}: {
  fields: readonly MemoryField[];
  records: readonly MemoryRecord[];
  labels: ReadonlyMap<string, string>;
  offset: number;
  onEdit: (id: MemoryRecordId, fieldId: string) => void;
}) {
  const widths = fields.map((field) => (field.type === "long_text" ? 320 : 200));
  return (
    <table
      aria-label="记录表格"
      data-slot="records-table"
      className="ste:table-fixed ste:border-separate ste:border-spacing-0 ste:text-left ste:text-sm"
      style={{ width: 56 + widths.reduce((sum, width) => sum + width, 0) + 48 }}
    >
      <colgroup>
        <col style={{ width: 56 }} />
        {fields.map((field, index) => (
          <col key={field.id} style={{ width: widths[index] }} />
        ))}
        <col style={{ width: 48 }} />
      </colgroup>
      <thead>
        <tr>
          <th
            scope="col"
            className="ste:sticky ste:top-0 ste:left-0 ste:z-30 ste:border-r ste:border-b ste:border-border ste:bg-muted ste:p-3 ste:text-center ste:font-medium"
          >
            #
          </th>
          {fields.map((field) => (
            <th
              key={field.id}
              scope="col"
              className="ste:sticky ste:top-0 ste:z-20 ste:border-r ste:border-b ste:border-border ste:bg-muted ste:p-3 ste:align-top ste:font-medium"
            >
              <span className="ste:wrap-anywhere">{field.name}</span>
              {!field.enabled ? (
                <Badge variant="secondary" className="ste:ml-2">
                  已停用
                </Badge>
              ) : null}
            </th>
          ))}
          <th
            scope="col"
            className="ste:sticky ste:top-0 ste:right-0 ste:z-30 ste:border-b ste:border-l ste:border-border ste:bg-muted ste:p-3 ste:text-center ste:font-medium"
          >
            <span className="ste:sr-only">操作</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {records.map((record, index) => (
          <tr key={record.id}>
            <th
              scope="row"
              className="ste:sticky ste:left-0 ste:z-10 ste:h-px ste:border-r ste:border-b ste:border-border ste:bg-background ste:p-0 ste:align-top ste:font-normal"
            >
              <Button
                variant="ghost"
                className="ste:h-full ste:min-h-12 ste:w-full ste:items-start ste:rounded-none ste:bg-clip-border ste:px-2 ste:py-3 ste:focus-visible:ring-inset"
                aria-label={`编辑记录 ${offset + index + 1}：${record.displayText}`}
                data-record-id={record.id}
                data-record-field="#"
                onClick={() => onEdit(record.id, "#")}
              >
                {offset + index + 1}
              </Button>
            </th>
            {fields.map((field) => (
              <td
                key={field.id}
                className="ste:h-px ste:border-r ste:border-b ste:border-border ste:p-0 ste:align-top"
              >
                <Button
                  variant="ghost"
                  className="ste:flex ste:h-full ste:min-h-12 ste:w-full ste:items-start ste:justify-start ste:rounded-none ste:bg-clip-border ste:px-3 ste:py-3 ste:text-left ste:font-normal ste:whitespace-normal ste:focus-visible:ring-inset"
                  aria-label={`编辑${record.displayText}：${field.name}`}
                  data-record-id={record.id}
                  data-record-field={field.id}
                  onClick={() => onEdit(record.id, field.id)}
                >
                  <span className="ste:line-clamp-3 ste:wrap-anywhere ste:whitespace-pre-wrap ste:leading-5">
                    {recordFieldValueText(field, record.payload[field.id], labels)}
                  </span>
                </Button>
              </td>
            ))}
            <td className="ste:sticky ste:right-0 ste:z-10 ste:h-px ste:border-b ste:border-l ste:border-border ste:bg-background ste:p-0 ste:align-top">
              <Button
                variant="ghost"
                size="icon"
                className="ste:h-full ste:min-h-12 ste:w-full ste:items-start ste:rounded-none ste:bg-clip-border ste:py-3 ste:focus-visible:ring-inset"
                aria-label={`编辑${record.displayText}`}
                data-record-id={record.id}
                data-record-field="edit"
                onClick={() => onEdit(record.id, "edit")}
              >
                <Pencil />
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
