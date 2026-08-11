import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildExtension, readPackageVersion } from "./build-lib.ts";

function tempOutdir(): string {
  return mkdtempSync(path.join(tmpdir(), "ste-memory-build-"));
}

describe("esbuild 构建链", () => {
  // 构建耗时随 bundle 体积与机器负载波动（全仓并行跑时曾多次超默认 5s）；
  // 构建测试关注产物契约而非速度，超时放宽到 30s。
  const BUILD_TIMEOUT_MS = 30_000;

  it("产物 = 单文件 js + manifest + css", async () => {
    const outdir = tempOutdir();
    try {
      const files = await buildExtension({ outdir });

      expect(files.map((f) => path.basename(f)).sort()).toEqual([
        "index.js",
        "manifest.json",
        "style.css",
      ]);

      const manifest = JSON.parse(readFileSync(path.join(outdir, "manifest.json"), "utf8")) as {
        js: string;
        css: string;
      };
      expect(existsSync(path.join(outdir, manifest.js))).toBe(true);
      expect(existsSync(path.join(outdir, manifest.css))).toBe(true);
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  }, BUILD_TIMEOUT_MS);

  it("bundle 无裸 node_modules import（无 import 语句、无 node_modules 路径）", async () => {
    const outdir = tempOutdir();
    try {
      await buildExtension({ outdir });
      const bundle = readFileSync(path.join(outdir, "index.js"), "utf8");

      expect(bundle).not.toMatch(/from\s+["']/);
      expect(bundle).not.toMatch(/import\s*\(/);
      expect(bundle).not.toContain("node_modules");
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  }, BUILD_TIMEOUT_MS);

  it("dev 构建产出 sourcemap，prod 构建清理残留 map", async () => {
    const outdir = tempOutdir();
    try {
      const devFiles = await buildExtension({ dev: true, outdir });
      expect(devFiles.map((f) => path.basename(f))).toContain("index.js.map");
      expect(existsSync(path.join(outdir, "index.js.map"))).toBe(true);

      await buildExtension({ outdir });
      expect(existsSync(path.join(outdir, "index.js.map"))).toBe(false);
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  }, BUILD_TIMEOUT_MS);

  it("manifest.version 与 package.json 一致，且版本号注入 bundle", async () => {
    const outdir = tempOutdir();
    try {
      await buildExtension({ outdir });

      const manifest = JSON.parse(readFileSync(path.join(outdir, "manifest.json"), "utf8")) as {
        version: string;
      };
      expect(manifest.version).toBe(readPackageVersion());

      const bundle = readFileSync(path.join(outdir, "index.js"), "utf8");
      // 版本号以字符串字面量注入（define），运行时拼进初始化日志
      expect(bundle).toContain(JSON.stringify(readPackageVersion()));
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  }, BUILD_TIMEOUT_MS);
});
