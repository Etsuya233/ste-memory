export const API_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:3000";

export async function responseJson<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  const body = (await response.json()) as { message?: string };
  throw new Error(body.message ?? `HTTP ${response.status}`);
}
