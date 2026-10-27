import type { MemoryField, QueryRecordsCondition } from "./index.ts";

/** Same parameterized predicates for record queries and generation macro expressions. */
export function compileMemoryQueryConditions(
  conditions: readonly QueryRecordsCondition[] | undefined,
  fieldsById: ReadonlyMap<string, MemoryField>,
  column: (fieldId: string) => string,
  param: (value: unknown) => string,
): string[] {
  const predicates = (conditions ?? []).map((condition) => {
    const actual = column(condition.fieldId),
      field = fieldsById.get(condition.fieldId);
    switch (condition.operator) {
      case "equals":
        return `${actual} IS ${param(condition.value)}`;
      case "not_equals":
        return `${actual} IS NOT ${param(condition.value)}`;
      case "in":
      case "not_in": {
        const alternatives = (condition.value as readonly unknown[])
          .map((value) => `${actual} IS ${param(value)}`)
          .join(" OR ");
        return `${condition.operator === "not_in" ? "NOT " : ""}(${alternatives})`;
      }
      case "contains":
      case "not_contains": {
        const list =
          field && ["short_text_list", "multi_select", "multi_reference"].includes(field.type);
        if (!list)
          return `COALESCE(instr(ste_lower(${actual}),ste_lower(${param(condition.value)}))>0,0)`;
        const exists = `EXISTS(SELECT 1 FROM json_each(${actual}) member WHERE member.value IS ${param(condition.value)})`;
        return condition.operator === "not_contains"
          ? `(${actual} IS NOT NULL AND NOT ${exists})`
          : exists;
      }
      default: {
        const operators = {
          greater_than: ">",
          greater_than_or_equal: ">=",
          less_than: "<",
          less_than_or_equal: "<=",
        };
        return `${actual} ${operators[condition.operator]} ${param(condition.value)}`;
      }
    }
  });
  return predicates;
}
