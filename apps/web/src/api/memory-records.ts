import { API_URL, responseJson } from "./http.ts";

export type MemoryFieldValue = string | number | boolean | null | readonly string[];
export type MemoryRecordSource =
  | { readonly type: "manual" }
  | {
      readonly type: "source";
      readonly sourceTime: string | null;
      readonly sourceLocation: string | null;
    };

export interface MemoryEvidence {
  readonly evidence_id: string;
  readonly source_type: string;
  readonly source_id: string | number;
  readonly storage_mode: "snapshot" | "reference";
  readonly content?: string;
  readonly extraProps: Readonly<Record<string, unknown>>;
}

export interface MemoryRecord {
  readonly id: string;
  readonly memorySpaceId: string;
  readonly tableId: string;
  readonly payload: Readonly<Record<string, MemoryFieldValue>>;
  readonly fieldEvidence: Readonly<Record<string, readonly MemoryEvidence[]>>;
  readonly displayText: string;
  readonly source: MemoryRecordSource;
  readonly revisionId: string;
  readonly revisionSource: "agent" | "user";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoryRecordPage {
  readonly records: readonly MemoryRecord[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export type MemoryRecordsByTable = Readonly<Record<string, readonly MemoryRecord[]>>;

export interface MemoryRecordHistory {
  readonly id: string;
  readonly recordId: string;
  readonly memorySpaceId: string;
  readonly tableId: string;
  readonly payload: Readonly<Record<string, MemoryFieldValue>>;
  readonly fieldEvidence: Readonly<Record<string, readonly MemoryEvidence[]>>;
  readonly displayText: string;
  readonly source: MemoryRecordSource;
  readonly previousRevisionId: string;
  readonly previousRevisionSource: "agent" | "user";
  readonly revisionId: string;
  readonly revisionSource: "agent" | "user";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string;
}

export async function listMemoryRecords(
  memorySpaceId: string,
  tableId: string,
  input: { readonly page: number; readonly pageSize: number; readonly search: string },
): Promise<MemoryRecordPage> {
  const search = input.search.trim();
  const conditions = search
    ? [{ fieldId: "$display_text", operator: "contains", value: search }]
    : [];
  return responseJson(
    await fetch(`${API_URL}/memory-spaces/${memorySpaceId}/query-records`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tableId,
        conditions,
        paging: { page: input.page, pageSize: input.pageSize },
        order: { fieldId: "$created_at", direction: "asc" },
      }),
    }),
  );
}

export async function listAllMemoryRecords(
  memorySpaceId: string,
  tableId: string,
): Promise<readonly MemoryRecord[]> {
  const firstPage = await listMemoryRecords(memorySpaceId, tableId, {
    page: 1,
    pageSize: 100,
    search: "",
  });
  if (firstPage.totalPages <= 1) return firstPage.records;
  const remainingPages = await Promise.all(
    Array.from({ length: firstPage.totalPages - 1 }, (_, index) =>
      listMemoryRecords(memorySpaceId, tableId, {
        page: index + 2,
        pageSize: 100,
        search: "",
      }),
    ),
  );
  return [firstPage, ...remainingPages].flatMap((page) => page.records);
}

export async function createMemoryRecord(
  memorySpaceId: string,
  tableId: string,
  input: {
    readonly payload: Readonly<Record<string, MemoryFieldValue>>;
    readonly source?: MemoryRecordSource;
    readonly fieldEvidence?: Readonly<
      Record<string, readonly Omit<MemoryEvidence, "evidence_id">[]>
    >;
  },
): Promise<MemoryRecord> {
  return responseJson(
    await fetch(`${API_URL}/memory-spaces/${memorySpaceId}/tables/${tableId}/records`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function updateMemoryRecord(
  memorySpaceId: string,
  tableId: string,
  recordId: string,
  input: {
    readonly expectedRevisionId: string;
    readonly patch: Readonly<Record<string, MemoryFieldValue>>;
    readonly fieldEvidence?: Readonly<
      Record<string, readonly Omit<MemoryEvidence, "evidence_id">[]>
    >;
  },
): Promise<MemoryRecord> {
  return responseJson(
    await fetch(`${API_URL}/memory-spaces/${memorySpaceId}/tables/${tableId}/records/${recordId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function deleteMemoryRecord(
  memorySpaceId: string,
  tableId: string,
  recordId: string,
  expectedRevisionId: string,
): Promise<void> {
  const response = await fetch(
    `${API_URL}/memory-spaces/${memorySpaceId}/tables/${tableId}/records/${recordId}`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevisionId }),
    },
  );
  if (!response.ok) await responseJson(response);
}

export async function listMemoryRecordHistory(
  memorySpaceId: string,
  query: {
    readonly tableId?: string;
    readonly recordId?: string;
    readonly revisionId?: string;
    readonly archivedFrom?: string;
    readonly archivedTo?: string;
  },
): Promise<readonly MemoryRecordHistory[]> {
  const parameters = new URLSearchParams(
    Object.entries(query).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
  );
  return responseJson(
    await fetch(`${API_URL}/memory-spaces/${memorySpaceId}/record-history?${parameters}`),
  );
}
