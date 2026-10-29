import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECORD_LIST_ORDER,
  type MemoryField,
  type MemoryFieldId,
} from "../../../features/memory/index.ts";
import {
  loadRecordSort,
  nextRecordSort,
  recordSortOptions,
  saveRecordSort,
} from "./record-sort-model.ts";

function field(type: MemoryField["type"]): MemoryField {
  return { id: type as MemoryFieldId, name: type, type } as MemoryField;
}

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("record sorting preferences", () => {
  it("offers system times and scalar fields, excluding lists and references", () => {
    expect(
      recordSortOptions([
        field("short_text"),
        field("integer"),
        field("datetime"),
        field("single_select"),
        field("short_text_list"),
        field("multi_select"),
        field("single_reference"),
        field("multi_reference"),
      ]).map((option) => option.fieldId),
    ).toEqual(["$created_at", "$updated_at", "short_text", "integer", "datetime", "single_select"]);
  });

  it("starts new selections ascending and toggles the selected direction", () => {
    expect(nextRecordSort(DEFAULT_RECORD_LIST_ORDER, "$created_at")).toEqual({
      fieldId: "$created_at",
      direction: "desc",
    });
    expect(nextRecordSort({ fieldId: "$created_at", direction: "desc" }, "$created_at")).toEqual(
      DEFAULT_RECORD_LIST_ORDER,
    );
    expect(nextRecordSort(DEFAULT_RECORD_LIST_ORDER, "$updated_at")).toEqual({
      fieldId: "$updated_at",
      direction: "asc",
    });
  });

  it("restores saved choices independently for each space and table", () => {
    const store = storage();
    const order = { fieldId: "integer" as MemoryFieldId, direction: "desc" as const };
    saveRecordSort("space-a", "table-a", order, store);
    expect(loadRecordSort("space-a", "table-a", [field("integer")], store)).toEqual(order);
    expect(loadRecordSort("space-b", "table-a", [field("integer")], store)).toEqual(
      DEFAULT_RECORD_LIST_ORDER,
    );
    expect(loadRecordSort("space-a", "table-b", [field("integer")], store)).toEqual(
      DEFAULT_RECORD_LIST_ORDER,
    );
  });

  it("removes the preference when a field is deleted or becomes unsortable", () => {
    const store = storage();
    const order = { fieldId: "integer" as MemoryFieldId, direction: "desc" as const };
    for (const fields of [[], [{ ...field("integer"), type: "multi_select" as const }]]) {
      saveRecordSort("s", "t", order, store);
      expect(loadRecordSort("s", "t", fields, store)).toEqual(DEFAULT_RECORD_LIST_ORDER);
      expect(loadRecordSort("s", "t", [field("integer")], store)).toEqual(
        DEFAULT_RECORD_LIST_ORDER,
      );
    }
  });
});
