import { buildExtension } from "./build-lib.ts";

const files = await buildExtension();
console.log(`[STE Memory] 构建完成：\n${files.map((f) => `  ${f}`).join("\n")}`);
