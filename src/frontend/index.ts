import { bootstrap } from "../bootstrap.ts";
import { mountRecordsFrontend } from "./host/st-host.tsx";

declare const __STE_MEMORY_VERSION__: string;
bootstrap({ version: __STE_MEMORY_VERSION__, mount: mountRecordsFrontend });
