export interface DatabaseStatus {
  readonly connected: boolean;
  readonly error?: string;
}

export interface SystemHealth {
  readonly api: "ok";
  readonly database: DatabaseStatus;
}
