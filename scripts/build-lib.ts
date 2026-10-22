import { build, type BuildOptions } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = path.join(PACKAGE_ROOT, "dist");
const ENTRY = path.join(PACKAGE_ROOT, "src", "index.ts");

/** 静态资产：manifest 直接拷贝；样式按固定顺序聚合为单文件 style.css */
const STATIC_ASSETS: ReadonlyArray<{ from: string; to: string }> = [
  { from: path.join(PACKAGE_ROOT, "manifest.json"), to: "manifest.json" },
];

/**
 * 样式源文件（按加载顺序）：拆分为按界面职责的多个文件，构建时聚合为
 * dist/style.css 供 manifest.css 引用。
 */
export const STYLE_SOURCES: readonly string[] = [
  "tokens.css",
  "panel-shell.css",
  "memory-tables.css",
  "records.css",
  "tasks.css",
  "vector-index.css",
  "agent-presets.css",
  "logs.css",
  "query-chat.css",
  "agent-connections.css",
  "table-presets.css",
  "preview.css",
].map((name) => path.join(PACKAGE_ROOT, "src", "ui", "styles", name));

/** 聚合样式源（保持源文件顺序；文件缺失时构建直接失败，不静默产出半份样式）。 */
export function aggregateStyles(): string {
  return STYLE_SOURCES.map((file) => readFileSync(file, "utf8").trimEnd()).join("\n\n") + "\n";
}

/** 把静态资产（manifest/聚合样式）写进产物目录，返回落盘路径 */
export function copyStaticAssets(outdir: string): string[] {
  mkdirSync(outdir, { recursive: true });
  const outputs: string[] = [];
  for (const asset of STATIC_ASSETS) {
    const dest = path.join(outdir, asset.to);
    copyFileSync(asset.from, dest);
    outputs.push(dest);
  }
  const styleDest = path.join(outdir, "style.css");
  writeFileSync(styleDest, aggregateStyles());
  outputs.push(styleDest);
  return outputs;
}

export function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

export interface BuildExtensionOptions {
  /** dev：不压缩 + sourcemap；prod：压缩 */
  dev?: boolean;
  /** 产物输出目录（默认 dist/），测试可注入临时目录 */
  outdir?: string;
}

/** esbuild 配置（dev 与 prod 的唯一定义处，watch.ts 与 build.ts 共用） */
export function createEsbuildOptions(outdir: string, dev: boolean): BuildOptions {
  return {
    entryPoints: [ENTRY],
    outfile: path.join(outdir, "index.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    minify: !dev,
    sourcemap: dev,
    logLevel: "info",
    // React 自动 JSX runtime（react/jsx-runtime 随包打进 bundle，ADR 0005）
    jsx: "automatic",
    // 版本号在构建时注入：manifest / package.json / 运行时日志同源
    define: {
      __STE_MEMORY_VERSION__: JSON.stringify(readPackageVersion()),
      // React 生产/开发构建分支（react-dom 内部读 NODE_ENV）
      "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production"),
    },
  };
}

/**
 * 构建插件产物：esbuild 打包单文件 js + 拷贝 manifest 与 css。
 * @returns 所有产物的绝对路径
 */
export async function buildExtension(options: BuildExtensionOptions = {}): Promise<string[]> {
  const { dev = false } = options;
  const outdir = options.outdir ?? DIST_DIR;
  mkdirSync(outdir, { recursive: true });

  await build(createEsbuildOptions(outdir, dev));

  const outputs = [path.join(outdir, "index.js")];
  if (dev) {
    outputs.push(path.join(outdir, "index.js.map"));
  } else {
    // 清理 dev 残留的 sourcemap，避免拷贝进 ST 扩展目录
    rmSync(path.join(outdir, "index.js.map"), { force: true });
  }
  outputs.push(...copyStaticAssets(outdir));
  return outputs;
}
