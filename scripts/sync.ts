import { existsSync } from "node:fs";
import path from "node:path";
import { copyStaticAssets, PACKAGE_ROOT } from "./build-lib.ts";
import { copyDistToTarget, resolveExtensionTarget } from "./extension-target.ts";

// 读取 .env
const envPath = path.join(PACKAGE_ROOT, ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const targetDir = resolveExtensionTarget(process.env);
const distDir = path.join(PACKAGE_ROOT, "dist");

// 检查 dist 是否存在
if (!existsSync(distDir)) {
  console.error("[STE Memory] dist 目录不存在，请先运行 build");
  process.exit(1);
}

// 复制静态资产到 dist（确保 manifest.json 和 style.css 是最新的）
copyStaticAssets(distDir);

// 复制 dist 到目标目录
const { copied } = copyDistToTarget(distDir, targetDir);

console.log(`[STE Memory] 已同步 ${copied.length} 个文件 → ${targetDir}`);
console.log(`  文件: ${copied.map((f) => path.basename(f)).join(", ")}`);
