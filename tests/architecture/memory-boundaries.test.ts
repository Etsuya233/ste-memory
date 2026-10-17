import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 结构约束测试（与 ESLint 的 no-restricted-imports 互为兜底）：
 * - Memory 只能通过 `features/memory/index.ts` 使用；
 * - Domain 无外层依赖；
 * - 功能层不依赖具体基础设施与 UI；
 * - Memory 不反向依赖其他功能。
 *
 * 项目不使用动态导入；`from "..."` 覆盖 import 与重导出。
 */

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(child);
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [child] : [];
  });
}

function isTestFile(file: string): boolean {
  return file.endsWith(".test.ts") || file.endsWith(".test.tsx");
}

function importsOf(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(/from\s+["']([^"']+)["']/g)].map(
    (match) => match[1]!,
  );
}

function relativeToSrc(file: string): string {
  return relative(SRC, file).split(sep).join("/");
}

/** 相对导入解析为 src 下 POSIX 路径；包名导入原样返回。 */
function resolveImport(file: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  return relative(SRC, normalize(join(dirname(file), specifier)))
    .split(sep)
    .join("/");
}

describe("architecture", () => {
  it("Memory Domain 只依赖自身（无外层依赖）", () => {
    const domainDir = join(SRC, "features", "memory", "domain");
    const invalid = sourceFiles(domainDir).flatMap((file) =>
      importsOf(file)
        .filter((specifier) => specifier.startsWith("."))
        .map((specifier) => ({ specifier, resolved: resolveImport(file, specifier) }))
        .filter(({ resolved }) => !resolved.startsWith("features/memory/domain/"))
        .map(({ specifier, resolved }) => `${relativeToSrc(file)}: ${specifier} -> ${resolved}`),
    );
    expect(invalid).toEqual([]);
  });

  it("Memory 只能通过 features/memory/index.ts 使用（其他功能、UI、基础设施与测试一致）", () => {
    const invalid = sourceFiles(SRC)
      .filter((file) => !relativeToSrc(file).startsWith("features/memory/"))
      .flatMap((file) =>
        importsOf(file)
          .filter((specifier) => specifier.startsWith("."))
          .map((specifier) => resolveImport(file, specifier))
          .filter((resolved) => resolved.startsWith("features/memory/"))
          .filter((resolved) => resolved !== "features/memory/index.ts")
          .map((resolved) => `${relativeToSrc(file)}: ${resolved}`),
      );
    expect(invalid).toEqual([]);
  });

  it("功能层不依赖具体基础设施与 UI（测试除外）", () => {
    const invalid = sourceFiles(join(SRC, "features"))
      .filter((file) => !isTestFile(file))
      .flatMap((file) =>
        importsOf(file)
          .map((specifier) => resolveImport(file, specifier))
          .filter(
            (resolved) => resolved.startsWith("infrastructure/") || resolved.startsWith("ui/"),
          )
          .map((resolved) => `${relativeToSrc(file)}: ${resolved}`),
      );
    expect(invalid).toEqual([]);
  });

  it("Memory 不反向依赖其他功能（保持共享模型唯一来源）", () => {
    const invalid = sourceFiles(join(SRC, "features", "memory")).flatMap((file) =>
      importsOf(file)
        .map((specifier) => resolveImport(file, specifier))
        .filter(
          (resolved) =>
            resolved.startsWith("features/") && !resolved.startsWith("features/memory/"),
        )
        .map((resolved) => `${relativeToSrc(file)}: ${resolved}`),
    );
    expect(invalid).toEqual([]);
  });
});
