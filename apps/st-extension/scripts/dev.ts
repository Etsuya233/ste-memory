import { context, type Plugin } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { copyStaticAssets, createEsbuildOptions, PACKAGE_ROOT } from "./build-lib.ts";
import { copyDistToTarget, resolveExtensionTarget } from "./extension-target.ts";

// .env 可选：STE_ST_EXTENSION_DIR（直接目标目录）或 STE_ST_INSTALL（ST 安装根目录）
const envPath = path.join(PACKAGE_ROOT, ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const targetDir = resolveExtensionTarget(process.env);
const distDir = path.join(PACKAGE_ROOT, "dist");
const staticFiles = [
  path.join(PACKAGE_ROOT, "manifest.json"),
  path.join(PACKAGE_ROOT, "src", "style.css"),
];

/** 构建完成后同步进 ST 扩展目录：先刷新 dist 静态资产，再整体拷贝 */
function syncDist(): void {
  if (!existsSync(distDir)) {
    return;
  }
  copyStaticAssets(distDir);
  const { copied } = copyDistToTarget(distDir, targetDir);
  console.log(`[STE Memory] 已同步 ${copied.length} 个文件 → ${targetDir}`);
}

/** 静态资产（manifest/css）变化时单独拷贝，无需重建 bundle */
function syncStaticFile(file: string): void {
  const dest = path.join(targetDir, path.basename(file));
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(file, dest);
  console.log(`[STE Memory] 已同步 ${path.basename(file)} → ${dest}`);
}

// 在 esbuild 构建完成后同步 dist（含初次构建）
const syncOnEnd: Plugin = {
  name: "ste-memory-sync",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) {
        syncDist();
      }
    });
  },
};

const ctx = await context({
  ...createEsbuildOptions(distDir, true),
  plugins: [syncOnEnd],
});

await ctx.watch();

// 静态资产单独 watch（esbuild 只跟踪 bundle 依赖图）
const watchers: FSWatcher[] = [];
const pending = new Map<string, NodeJS.Timeout>();
for (const file of staticFiles) {
  watchers.push(
    watch(file, () => {
      clearTimeout(pending.get(file));
      pending.set(
        file,
        setTimeout(() => syncStaticFile(file), 50),
      );
    }),
  );
}

console.log(`[STE Memory] dev watch 已启动`);
console.log(`  产物: ${distDir}`);
console.log(`  目标: ${targetDir}`);
console.log(`  提示: 扩展以 module script 加载，改动后需刷新 ST 页面；Ctrl+C 退出`);

function shutdown(): void {
  for (const watcher of watchers) {
    watcher.close();
  }
  void ctx.dispose().then(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
