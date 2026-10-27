import { context, type Plugin } from "esbuild";
import { existsSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import {
  copyStaticAssets,
  createEsbuildOptions,
  PACKAGE_ROOT,
  STYLE_SOURCES,
} from "./build-lib.ts";
import { copyDistToTarget, tryResolveExtensionTarget } from "./extension-target.ts";

/**
 * `pnpm watch`：开发 watch 循环——esbuild 增量重建 dist/，构建成功即刷新静态
 * 资产并同步进 ST 扩展目录。两种形态：
 * - 配了 .env（STE_ST_EXTENSION_DIR / STE_ST_INSTALL）：拷贝同步；
 * - 未配置：仅构建（配合 `pnpm st:link` 的 Junction，ST 直接读取 dist，无需拷贝）；
 *   st:link 目标会被 copyDistToTarget 识别为链接并自动跳过拷贝。
 * 不是 dev server：ST 以 module script 加载扩展，改动后刷新 ST 页面生效。
 */

// .env 可选（见上）：不存在时进入仅构建模式
const envPath = path.join(PACKAGE_ROOT, ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const targetDir = tryResolveExtensionTarget(process.env);
const distDir = path.join(PACKAGE_ROOT, "dist");
// manifest + 全部样式源：不在 esbuild 依赖图中，单独 watch（改动只需重聚合，无需重建 bundle）
const staticFiles = [
  path.join(PACKAGE_ROOT, "manifest.json"),
  ...STYLE_SOURCES,
  path.join(PACKAGE_ROOT, "src/ui/primitives/theme.css"),
];

/** 刷新 dist 静态资产；配了目标（且目标不是 dist 链接）时同步进 ST 扩展目录 */
function syncDist(): void {
  if (!existsSync(distDir)) {
    return;
  }
  copyStaticAssets(distDir);
  if (targetDir === undefined) {
    return;
  }
  const { copied, linked } = copyDistToTarget(distDir, targetDir);
  if (linked) {
    return; // Junction 直连：ST 读的就是 dist 本身
  }
  console.log(`[STE Memory] 已同步 ${copied.length} 个文件 → ${targetDir}`);
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

// 静态资产单独 watch（esbuild 只跟踪 bundle 依赖图），50ms 防抖合并连续写盘
const watchers: FSWatcher[] = [];
const pending = new Map<string, NodeJS.Timeout>();
for (const file of staticFiles) {
  watchers.push(
    watch(file, () => {
      clearTimeout(pending.get(file));
      pending.set(
        file,
        setTimeout(() => syncDist(), 50),
      );
    }),
  );
}

console.log(`[STE Memory] watch 已启动`);
console.log(`  产物: ${distDir}`);
console.log(
  targetDir === undefined
    ? "  目标: 未配置 .env——仅构建到 dist（用 pnpm st:link 的 Junction 时 ST 直接读取）"
    : `  目标: ${targetDir}`,
);
console.log(`  提示: 扩展以 module script 加载，改动后需刷新 ST 页面；Ctrl+C 退出`);

function shutdown(): void {
  for (const watcher of watchers) {
    watcher.close();
  }
  void ctx.dispose().then(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
