import { API_URL, responseJson } from "./http.ts";

export type MemoryFieldValue = string | number | boolean | null | readonly string[];
export type MemoryRecordSource =
  | { readonly type: "manual" }
  | {
      readonly type: "source";
      readonly sourceTime: string | null;
      readonly sourceLocation: string | null;
    };

export interface MemoryRecord {
  readonly id: string;
  readonly memorySpaceId: string;
  readonly tableId: string;
  readonly payload: Readonly<Record<string, MemoryFieldValue>>;
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

export async function listMemoryRecords(
  memorySpaceId: string,
  tableId: string,
  input: { readonly page: number; readonly pageSize: number; readonly search: string },
): Promise<MemoryRecordPage> {
  const query = new URLSearchParams({ page: String(input.page), pageSize: String(input.pageSize) });
  if (input.search.trim()) query.set("search", input.search.trim());
  return responseJson(
    await fetch(`${API_URL}/memory-spaces/${memorySpaceId}/tables/${tableId}/records?${query}`),
  );
}

export async function createMemoryRecord(
  memorySpaceId: string,
  tableId: string,
  input: {
    readonly payload: Readonly<Record<string, MemoryFieldValue>>;
    readonly source?: MemoryRecordSource;
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
