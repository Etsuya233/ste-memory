import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createExtensionLink,
  isLinkToDist,
  planExtensionLink,
  removeExtensionLink,
} from "./extension-link.ts";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 造一个 dist 目录（含一个文件），返回 [dist, 其中文件路径] */
function makeDist(): string {
  const dist = tempDir("ste-memory-dist-");
  writeFileSync(path.join(dist, "index.js"), "bundle");
  return dist;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("st:link 链接建立/移除", () => {
  it("目标不存在：建立指向 dist 的链接，ST 侧透读 dist 内容且幂等", () => {
    const dist = makeDist();
    const target = path.join(tempDir("ste-memory-st-"), "ste-memory");

    expect(planExtensionLink(dist, target)).toEqual({ kind: "create" });
    expect(createExtensionLink(dist, target)).toEqual({ status: "created" });
    expect(isLinkToDist(dist, target)).toBe(true);
    // 透过链接读到的就是 dist 的内容（ST 的 Node 服务器同路径语义）
    expect(readFileSync(path.join(target, "index.js"), "utf8")).toBe("bundle");
    // 再次建立：幂等，不抛错
    expect(createExtensionLink(dist, target)).toEqual({ status: "already-linked" });
  });

  it("目标已是真实目录：拒绝建立（不动用户数据），删除时也拒绝", () => {
    const dist = makeDist();
    const target = path.join(tempDir("ste-memory-st-"), "ste-memory");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "index.js"), "手动拷贝版");

    expect(planExtensionLink(dist, target)).toEqual({
      kind: "blocked",
      reason: expect.stringContaining("真实目录"),
    });
    expect(() => createExtensionLink(dist, target)).toThrow(/真实目录/);
    expect(() => removeExtensionLink(target)).toThrow(/不是链接/);
    // 用户数据原样保留
    expect(readFileSync(path.join(target, "index.js"), "utf8")).toBe("手动拷贝版");
  });

  it("目标已是指向别处的链接：拒绝建立并提示先解除", () => {
    const dist = makeDist();
    const otherDist = makeDist();
    const target = path.join(tempDir("ste-memory-st-"), "ste-memory");
    createExtensionLink(otherDist, target);

    expect(planExtensionLink(dist, target)).toEqual({
      kind: "blocked",
      reason: expect.stringContaining("其他位置"),
    });
    expect(() => createExtensionLink(dist, target)).toThrow(/其他位置/);
  });

  it("移除链接：只删链接本身，dist 内容保留；目标不存在时幂等返回 absent", () => {
    const dist = makeDist();
    const target = path.join(tempDir("ste-memory-st-"), "ste-memory");
    createExtensionLink(dist, target);

    expect(removeExtensionLink(target)).toEqual({ status: "removed" });
    expect(planExtensionLink(dist, target)).toEqual({ kind: "create" });
    expect(readFileSync(path.join(dist, "index.js"), "utf8")).toBe("bundle");
    expect(removeExtensionLink(target)).toEqual({ status: "absent" });
  });
});
