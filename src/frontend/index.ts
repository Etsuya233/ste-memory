import { bootstrap } from "../bootstrap.ts";
import { mountRecordsFrontend } from "./host/st-host.tsx";
import { autoFillNotifications } from "./host/auto-fill-notifications.tsx";

declare const __STE_MEMORY_VERSION__: string;
bootstrap({ version: __STE_MEMORY_VERSION__, mount: mountRecordsFrontend, autoFillNotifications });
