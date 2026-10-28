import { bootstrap } from "./bootstrap.ts";
import { mountPanel } from "./ui/shell/st-panel-host.tsx";

// 构建时由 esbuild define 注入（见 scripts/build-lib.ts），与 manifest/package.json 版本同源
declare const __STE_MEMORY_VERSION__: string;

bootstrap({ version: __STE_MEMORY_VERSION__, mount: mountPanel });
