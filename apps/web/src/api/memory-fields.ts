import { API_URL, responseJson } from "./http.ts";

export type MemoryFieldType =
  | "short_text"
  | "long_text"
  | "short_text_list"
  | "integer"
  | "decimal"
  | "boolean"
  | "date"
  | "datetime"
  | "single_select"
  | "multi_select"
  | "single_reference"
  | "multi_reference";

export interface MemoryField {
  readonly id: string;
  readonly memorySpaceId: string;
  readonly tableId: string;
  readonly key: string;
  readonly name: string;
  readonly type: MemoryFieldType;
  readonly required: boolean;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly position: number;
  readonly options: readonly string[];
  readonly referenceTableId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoryFieldInput {
  readonly key: string;
  readonly name: string;
  readonly type: MemoryFieldType;
  readonly required: boolean;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly position: number;
  readonly options?: readonly string[];
  readonly referenceTableId?: string | null;
}

export interface MemoryFieldPatch {
  readonly key?: string;
  readonly name?: string;
  readonly required?: boolean;
  readonly prompt?: string;
  readonly enabled?: boolean;
  readonly position?: number;
  readonly options?: readonly string[];
  readonly referenceTableId?: string | null;
}

export interface MemoryFieldUpdateResult {
  readonly field: MemoryField;
  readonly warnings: readonly string[];
}

export async function listMemoryFields(
  memorySpaceId: string,
  tableId: string,
): Promise<MemoryField[]> {
  return responseJson(
    await fetch(`${API_URL}/memory-spaces/${memorySpaceId}/tables/${tableId}/fields`),
  );
}

export async function createMemoryField(
  memorySpaceId: string,
  tableId: string,
  input: MemoryFieldInput,
): Promise<MemoryField> {
  return responseJson(
    await fetch(`${API_URL}/memory-spaces/${memorySpaceId}/tables/${tableId}/fields`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function updateMemoryField(
  memorySpaceId: string,
  tableId: string,
  fieldId: string,
  patch: MemoryFieldPatch,
): Promise<MemoryFieldUpdateResult> {
  return responseJson(
    await fetch(`${API_URL}/memory-spaces/${memorySpaceId}/tables/${tableId}/fields/${fieldId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
}

export async function deleteMemoryField(
  memorySpaceId: string,
  tableId: string,
  fieldId: string,
): Promise<void> {
  const response = await fetch(
    `${API_URL}/memory-spaces/${memorySpaceId}/tables/${tableId}/fields/${fieldId}`,
    { method: "DELETE" },
  );
  if (!response.ok) await responseJson(response);
}

export async function updateDisplayStrategy(
  memorySpaceId: string,
  tableId: string,
  strategy:
    | { readonly type: "field"; readonly fieldId: string }
    | {
        readonly type: "template";
        readonly template: string;
      },
) {
  return responseJson(
    await fetch(`${API_URL}/memory-spaces/${memorySpaceId}/tables/${tableId}/display-strategy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(strategy),
    }),
  );
}
