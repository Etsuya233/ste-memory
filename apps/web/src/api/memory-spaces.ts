const API_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:3000";

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

async function responseJson<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  const body = (await response.json()) as { message?: string };
  throw new Error(body.message ?? `HTTP ${response.status}`);
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
