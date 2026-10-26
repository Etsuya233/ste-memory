import { compileMemoryQueryConditions } from "../../features/memory/index.ts";
import type {
  MemoryRecord,
  QueryRecordsInput,
  QueryRecordsPage,
} from "../../features/memory/index.ts";
import type { SqliteBind, SqliteMemoryClient, SqliteView } from "./types.ts";

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Receives the existing Memory query contract after domain validation. All filtering and paging execute in SQLite. */
export async function querySqliteRecords(
  client: SqliteMemoryClient,
  spaceId: string,
  input: QueryRecordsInput,
  view: SqliteView = "committed",
  freshDisplay?: readonly { id: string; displayText: string }[],
): Promise<QueryRecordsPage> {
  const table = (await client.getEntity(spaceId, "table", input.tableId, view))!;
  const fields = (await client.listEntities(spaceId, "field", view)).filter(
    (field) => field.tableId === input.tableId,
  );
  const fieldById = new Map(fields.map((field) => [field.id as string, field]));
  const bind: SqliteBind[] = [];
  const param = (value: unknown): string => {
    bind.push(typeof value === "boolean" ? Number(value) : (value as SqliteBind));
    return "?";
  };
  const displayCte =
    freshDisplay === undefined
      ? ""
      : `WITH fresh AS (SELECT json_extract(value,'$.id') id,json_extract(value,'$.displayText') text FROM json_each(${param(JSON.stringify(freshDisplay))})) `;
  const column = (fieldId: string): string =>
    fieldId === "$display_text" && freshDisplay !== undefined
      ? `(SELECT text FROM fresh WHERE fresh.id=t.${quote("$record_id")})`
      : `t.${quote(fieldId.startsWith("$") ? fieldId : fieldById.get(fieldId)!.key)}`;
  const predicates = compileMemoryQueryConditions(input.conditions, fieldById, column, param);
  const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
  const from = `FROM ${quote(table.key)} t JOIN __entities entity ON entity.kind='record' AND entity.id=t.${quote("$record_id")}`;
  const count = await client.exec({
    spaceId,
    view,
    sql: `${displayCte}SELECT count(*) total ${from}${where}`,
    bind,
  });
  const total = Number(count[0]!.total),
    order = input.order ?? { fieldId: "$created_at", direction: "asc" };
  const rows = await client.exec({
    spaceId,
    view,
    sql: `${displayCte}SELECT entity.data ${from}${where} ORDER BY ${column(order.fieldId)} COLLATE STE_UTF16 ${order.direction.toUpperCase()},t.${quote("$record_id")} COLLATE STE_LOCALE ASC LIMIT ? OFFSET ?`,
    bind: [...bind, input.paging.pageSize, (input.paging.page - 1) * input.paging.pageSize],
  });
  const displayById = new Map(freshDisplay?.map((row) => [row.id, row.displayText]));
  const records = rows.map((row) => {
    const record = JSON.parse(row.data as string) as MemoryRecord;
    return {
      ...record,
      displayText: displayById.get(record.id) ?? record.displayText,
      payload:
        input.fieldIds === undefined
          ? record.payload
          : Object.fromEntries(
              input.fieldIds.flatMap((id) =>
                record.payload[id] === undefined ? [] : [[id, record.payload[id]]],
              ),
            ),
    };
  });
  return {
    records,
    total,
    page: input.paging.page,
    pageSize: input.paging.pageSize,
    totalPages: Math.ceil(total / input.paging.pageSize),
  };
}
