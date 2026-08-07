import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { copyDistToTarget, resolveExtensionTarget } from "./extension-target.ts";

describe("resolveExtensionTarget", () => {
  it("STE_ST_EXTENSION_DIR 直接作为目标目录（优先于 STE_ST_INSTALL）", () => {
    expect(
      resolveExtensionTarget({ STE_ST_EXTENSION_DIR: "/ext/dir", STE_ST_INSTALL: "/st" }),
    ).toBe(path.resolve("/ext/dir"));
  });

  it("STE_ST_INSTALL 推导出 public/scripts/extensions/third-party/ste-memory", () => {
    const expected = path.join(
      path.resolve("/st"),
      "public",
      "scripts",
      "extensions",
      "third-party",
      "ste-memory",
    );
    expect(resolveExtensionTarget({ STE_ST_INSTALL: "/st" })).toBe(expected);
  });

  it("两者都缺时抛出带配置指引的错误", () => {
    expect(() => resolveExtensionTarget({})).toThrow(/STE_ST_EXTENSION_DIR|STE_ST_INSTALL/);
  });
});

describe("copyDistToTarget", () => {
  it("递归创建目标目录并拷贝 dist 下所有文件", () => {
    const dist = mkdtempSync(path.join(tmpdir(), "ste-memory-dist-"));
    const target = mkdtempSync(path.join(tmpdir(), "ste-memory-target-"));
    try {
      writeFileSync(path.join(dist, "index.js"), "bundle");
      writeFileSync(path.join(dist, "style.css"), "css");
      const { copied } = copyDistToTarget(dist, path.join(target, "ste-memory"));

      expect(copied).toHaveLength(2);
      expect(readFileSync(path.join(target, "ste-memory", "index.js"), "utf8")).toBe("bundle");
      expect(readFileSync(path.join(target, "ste-memory", "style.css"), "utf8")).toBe("css");
    } finally {
      rmSync(dist, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});
