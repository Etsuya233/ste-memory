import type { AutoFillService } from "../../../features/fill-tasks/auto-fill-service.ts";
import type { AutoFillSettings } from "../../../features/fill-tasks/auto-fill-settings.ts";
import type { RecordsContext } from "../records-workspace.ts";

export interface AutoFillServices extends Pick<
  AutoFillService,
  "read" | "settings" | "saveOverrides"
> {
  assertContext: (context: RecordsContext) => void;
}
const keys = [
  "mode",
  "interval",
  "includeCurrent",
  "blockSize",
  "retries",
  "retryDelaySeconds",
] as const;
export function overridesDirty(saved: Partial<AutoFillSettings>, draft: Partial<AutoFillSettings>) {
  return keys.some((key) => !Object.is(saved[key], draft[key]));
}

/** Apply only edited fields to the live metadata; blank fields remove overrides. */
export function saveAutoFillOverrides(
  services: AutoFillServices,
  context: RecordsContext,
  saved: Partial<AutoFillSettings>,
  draft: Partial<AutoFillSettings>,
) {
  services.assertContext(context);
  const next = { ...services.read().overrides };
  for (const key of keys) {
    if (Object.is(saved[key], draft[key])) continue;
    if (draft[key] === undefined) delete next[key];
    else Object.assign(next, { [key]: draft[key] });
  }
  services.saveOverrides(next);
  return services.read().overrides;
}
