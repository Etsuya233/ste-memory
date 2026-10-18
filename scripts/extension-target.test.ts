import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createExtensionLink } from "./extension-link.ts";
import {
  copyDistToTarget,
  resolveExtensionTarget,
  tryResolveExtensionTarget,
} from "./extension-target.ts";

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

describe("tryResolveExtensionTarget", () => {
  it("已配置：返回解析结果；未配置：返回 undefined（watch 的仅构建模式）", () => {
    expect(tryResolveExtensionTarget({ STE_ST_INSTALL: "/st" })).toBe(
      resolveExtensionTarget({ STE_ST_INSTALL: "/st" }),
    );
    expect(tryResolveExtensionTarget({})).toBeUndefined();
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

  it("目标是 dist 链接（st:link 模式）：跳过拷贝（linked=true，无文件落盘）", () => {
    const dist = mkdtempSync(path.join(tmpdir(), "ste-memory-dist-"));
    const stRoot = mkdtempSync(path.join(tmpdir(), "ste-memory-target-"));
    const target = path.join(stRoot, "ste-memory");
    try {
      writeFileSync(path.join(dist, "index.js"), "bundle");
      createExtensionLink(dist, target);

      const result = copyDistToTarget(dist, target);
      expect(result).toEqual({ copied: [], linked: true });
      // dist 内容不受影响（拷贝被跳过，而不是拷到自己身上）
      expect(readFileSync(path.join(dist, "index.js"), "utf8")).toBe("bundle");
    } finally {
      rmSync(dist, { recursive: true, force: true });
      rmSync(stRoot, { recursive: true, force: true });
    }
  });
});
