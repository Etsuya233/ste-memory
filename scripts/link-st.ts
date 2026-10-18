import { existsSync } from "node:fs";
import path from "node:path";
import { PACKAGE_ROOT } from "./build-lib.ts";
import { createExtensionLink, removeExtensionLink } from "./extension-link.ts";
import { resolveExtensionTarget } from "./extension-target.ts";

/**
 * `pnpm st:link` / `pnpm st:unlink`：把 ST 扩展目录做成指向 dist/ 的目录链接
 * （Windows Junction 免管理员；POSIX symlink），开发时 ST 直接读取构建产物，
 * `pnpm watch` 不再拷贝。目标位置从仓库根 .env 读取，二选一（见 .env.example）：
 * STE_ST_EXTENSION_DIR（直接目标目录）或 STE_ST_INSTALL（ST 安装根目录）。
 */

// 读取 .env（与 sync.ts 同约定）
const envPath = path.join(PACKAGE_ROOT, ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const distDir = path.join(PACKAGE_ROOT, "dist");
const targetDir = resolveExtensionTarget(process.env);
const shouldRemove = process.argv.includes("--remove");

if (!shouldRemove && !existsSync(distDir)) {
  console.error("[STE Memory] dist 目录不存在，请先运行 build");
  process.exit(1);
}

if (shouldRemove) {
  const { status } = removeExtensionLink(targetDir);
  console.log(
    status === "removed"
      ? `[STE Memory] 已移除链接：${targetDir}`
      : `[STE Memory] 无链接可移除：${targetDir}`,
  );
} else {
  const { status } = createExtensionLink(distDir, targetDir);
  console.log(
    status === "created"
      ? `[STE Memory] 已建立链接：${targetDir}\n  → ${distDir}\n  之后 pnpm watch / pnpm build 的产物 ST 直接可见，刷新 ST 页面即可`
      : `[STE Memory] 链接已存在：${targetDir}\n  → ${distDir}`,
  );
}
