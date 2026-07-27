import type { DatabaseStatus } from "../models/system-health.ts";

export interface DatabaseHealthCheck {
  check(): DatabaseStatus;
}
