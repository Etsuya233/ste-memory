import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: URL): string[] {
  const path = fileURLToPath(directory);
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    return entry.isDirectory()
      ? sourceFiles(child)
      : entry.name.endsWith(".ts")
        ? [fileURLToPath(child)]
        : [];
  });
}

function importsOf(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(/from\s+["']([^"']+)["']/g)].map(
    (match) => match[1]!,
  );
}

describe("architecture", () => {
  it("keeps Memory Domain independent from outer layers", () => {
    const files = sourceFiles(new URL("../src/memory/domain/", import.meta.url));
    const invalidImports = files.flatMap((file) =>
      importsOf(file)
        .filter((value) => value.includes("/application/") || value.includes("/adapters/"))
        .map((value) => `${file}: ${value}`),
    );

    expect(invalidImports).toEqual([]);
  });

  it("keeps API host Application independent from technology Adapters", () => {
    const files = sourceFiles(new URL("../../apps/api/src/application/", import.meta.url));
    const invalidImports = files.flatMap((file) =>
      importsOf(file)
        .filter((value) => value.includes("/adapters/") || value.includes("\\adapters\\"))
        .map((value) => `${file}: ${value}`),
    );

    expect(invalidImports).toEqual([]);
  });

  it("keeps HTTP inbound Adapters independent from SQLite implementations", () => {
    const files = sourceFiles(
      new URL("../../apps/api/src/adapters/inbound/http/", import.meta.url),
    );
    const invalidImports = files.flatMap((file) =>
      importsOf(file)
        .filter(
          (value) =>
            value.includes("/adapters/outbound/") || value.includes("\\adapters\\outbound\\"),
        )
        .map((value) => `${file}: ${value}`),
    );

    expect(invalidImports).toEqual([]);
  });

  it("keeps the Agent engine dependencies confined to the memory agent sublayer", () => {
    const files = sourceFiles(new URL("../src/memory/", import.meta.url));
    const agentDir = fileURLToPath(new URL("../src/memory/application/agent/", import.meta.url));
    const invalidImports = files.flatMap((file) =>
      importsOf(file)
        .filter(
          (value) =>
            (value.includes("@earendil-works/pi-") || value.includes("typebox")) &&
            !file.startsWith(agentDir),
        )
        .map((value) => `${file}: ${value}`),
    );

    expect(invalidImports).toEqual([]);
  });

  it("keeps the agent sublayer imported only from within itself", () => {
    const files = sourceFiles(new URL("../src/", import.meta.url));
    const agentDir = fileURLToPath(new URL("../src/memory/application/agent/", import.meta.url));
    const invalidImports = files.flatMap((file) =>
      importsOf(file)
        .filter((value) => value.startsWith("./") || value.startsWith("../"))
        .map((value) => ({ file, resolved: normalize(join(dirname(file), value)) }))
        .filter(({ file, resolved }) => resolved.startsWith(agentDir) && !file.startsWith(agentDir))
        .map(({ file, resolved }) => `${file}: ${resolved}`),
    );

    expect(invalidImports).toEqual([]);
  });
});
