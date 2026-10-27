import type { MemoryField, MemoryRecord, MemoryRecordId } from "../../features/memory/index.ts";
import { recordFieldValueText } from "./record-form-model.ts";
import { ChevronRight, FileText } from "lucide-react";
import { Badge } from "../primitives/badge.tsx";
import {
  Item,
  ItemGroup,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "../primitives/item.tsx";

export function RecordSummaryList(props: {
  readonly records: readonly MemoryRecord[];
  readonly fields: readonly MemoryField[];
  readonly referenceLabels: ReadonlyMap<string, string>;
  readonly vectorSummaries: ReadonlyMap<MemoryRecordId, string>;
  readonly onOpenRecord: (recordId: MemoryRecordId) => void;
}) {
  return (
    <ItemGroup className="stm-record-summary-list ste:gap-2" aria-label="记录列表">
      {props.records.map((record) => {
        const previewFields = props.fields
          .filter((field) => field.enabled)
          .map((field) => ({
            field,
            text: recordFieldValueText(field, record.payload[field.id], props.referenceLabels),
          }))
          .filter(({ text }) => text !== "—" && text.trim() !== record.displayText.trim())
          .slice(0, 2);
        const vectorSummary = props.vectorSummaries.get(record.id);
        return (
          <div key={record.id} role="listitem">
            <Item
              render={<button type="button" />}
              variant="outline"
              className="stm-record-summary ste:text-left"
              data-action="open-record"
              data-record-id={record.id}
              onClick={() => props.onOpenRecord(record.id)}
            >
              <FileText className="stm-record-summary-icon" aria-hidden="true" />
              <ItemContent>
                <ItemTitle>{record.displayText || "未命名记录"}</ItemTitle>
                {previewFields.length > 0 ? (
                  <ItemDescription>
                    {previewFields.map(({ text }) => text).join(" · ")}
                  </ItemDescription>
                ) : null}
              </ItemContent>
              <ItemActions className="ste:max-[480px]:flex-col ste:max-[480px]:items-end">
                {vectorSummary ? (
                  <Badge
                    variant="secondary"
                    className="stm-record-summary-status ste:max-w-40 ste:whitespace-normal ste:text-left ste:max-[480px]:max-w-20 ste:max-[480px]:text-[0.625rem]"
                  >
                    {vectorSummary}
                  </Badge>
                ) : null}
                <ChevronRight aria-hidden="true" />
              </ItemActions>
            </Item>
          </div>
        );
      })}
    </ItemGroup>
  );
}
