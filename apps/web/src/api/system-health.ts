import { API_URL, responseJson } from "./http.ts";

export interface DatabaseStatus {
  readonly connected: boolean;
  readonly error?: string;
}

export interface SystemHealth {
  readonly api: "ok";
  readonly database: DatabaseStatus;
}

export async function fetchSystemHealth(): Promise<SystemHealth> {
  return responseJson(await fetch(`${API_URL}/health`));
}
