import { API_URL, responseJson } from "./http.ts";

export interface MemoryTable {
  readonly id: string;
  readonly memorySpaceId: string;
  readonly key: string;
  readonly kind: "custom" | "system";
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly displayStrategy:
    | { readonly type: "field"; readonly fieldId: string }
    | { readonly type: "template"; readonly template: string }
    | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoryTableInput {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
}

export interface MemoryTablePatch {
  readonly key?: string;
  readonly name?: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly enabled?: boolean;
}

export async function listMemoryTables(memorySpaceId: string): Promise<MemoryTable[]> {
  return responseJson(await fetch(`${API_URL}/memory-spaces/${memorySpaceId}/tables`));
}

export async function createMemoryTable(
  memorySpaceId: string,
  input: MemoryTableInput,
): Promise<MemoryTable> {
  return responseJson(
    await fetch(`${API_URL}/memory-spaces/${memorySpaceId}/tables`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function updateMemoryTable(
  memorySpaceId: string,
  tableId: string,
  patch: MemoryTablePatch,
): Promise<MemoryTable> {
  return responseJson(
    await fetch(`${API_URL}/memory-spaces/${memorySpaceId}/tables/${tableId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
}

export async function deleteMemoryTable(memorySpaceId: string, tableId: string): Promise<void> {
  const response = await fetch(`${API_URL}/memory-spaces/${memorySpaceId}/tables/${tableId}`, {
    method: "DELETE",
  });
  if (!response.ok) await responseJson(response);
}
