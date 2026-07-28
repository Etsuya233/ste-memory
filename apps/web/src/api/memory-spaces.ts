import { API_URL, responseJson } from "./http.ts";

export interface MemorySpace {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messageCount: number;
  readonly errorCount: number;
}

export interface SourceMessage {
  readonly source_type: "sillytavern_jsonl";
  readonly source_id: number;
  readonly content: string;
  readonly extraProps: Readonly<Record<string, unknown>>;
}

export interface SourceParseError {
  readonly lineNumber: number;
  readonly rawLine: string;
  readonly message: string;
}

export async function listMemorySpaces(): Promise<MemorySpace[]> {
  return responseJson(await fetch(`${API_URL}/memory-spaces`));
}

export async function createMemorySpace(name: string, file: File): Promise<MemorySpace> {
  const body = new FormData();
  body.append("name", name);
  body.append("file", file);
  return responseJson(await fetch(`${API_URL}/memory-spaces`, { method: "POST", body }));
}

export async function renameMemorySpace(id: string, name: string): Promise<MemorySpace> {
  return responseJson(
    await fetch(`${API_URL}/memory-spaces/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );
}

export async function deleteMemorySpace(id: string): Promise<void> {
  const response = await fetch(`${API_URL}/memory-spaces/${id}`, { method: "DELETE" });
  if (!response.ok) await responseJson(response);
}

export async function loadSourceChat(
  id: string,
): Promise<{ messages: SourceMessage[]; errors: SourceParseError[] }> {
  const [messages, errors] = await Promise.all([
    fetch(`${API_URL}/memory-spaces/${id}/messages`).then(responseJson<SourceMessage[]>),
    fetch(`${API_URL}/memory-spaces/${id}/parse-errors`).then(responseJson<SourceParseError[]>),
  ]);
  return { messages, errors };
}
