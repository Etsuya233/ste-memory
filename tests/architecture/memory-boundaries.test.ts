import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { dependencyViolations } from "./dependency-rules.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC = join(ROOT, "src");
const config = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile);
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT).options;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(child);
    return /\.tsx?$/.test(entry.name) ? [child] : [];
  });
}

describe("architecture", () => {
  it("源码遵守 Memory 入口、Domain 与外层依赖约束", () => {
    const invalid = sourceFiles(SRC).flatMap((file) =>
      dependencyViolations(readFileSync(file, "utf8"), file, SRC, options),
    );
    expect(invalid).toEqual([]);
  });

  const featureFile = join(SRC, "features/fill-tasks/probe.ts");
  const internalPath = "../memory/internal/proposal.ts";

  it.each([
    `import { memoryProposalBatch } from "${internalPath}";`,
    `export { memoryProposalBatch } from "${internalPath}";`,
    `import "${internalPath}";`,
    `const module = import("${internalPath}");`,
    `type Operation = import("${internalPath}").MemoryProposalOperation;`,
  ])("拦截各种形式的内部导入：%s", (source) => {
    expect(dependencyViolations(source, featureFile, SRC, options)).toHaveLength(1);
  });

  it("允许功能通过公开入口使用 Memory", () => {
    expect(
      dependencyViolations(
        'import { MemoryRecordService } from "../memory/index.ts";',
        featureFile,
        SRC,
        options,
      ),
    ).toEqual([]);
  });

  it("路径别名不能绕过入口限制", () => {
    const aliases = { ...options, paths: { "@memory/*": [join(SRC, "features/memory/*")] } };
    expect(
      dependencyViolations(
        'export { memoryProposalBatch } from "@memory/internal/proposal.ts";',
        featureFile,
        SRC,
        aliases,
      ),
    ).toHaveLength(1);
    expect(
      dependencyViolations(
        'export { MemoryRecordService } from "@memory/index.ts";',
        featureFile,
        SRC,
        aliases,
      ),
    ).toEqual([]);
  });

  it.each(["react", "dexie", "@earendil-works/pi-agent-core", "node:fs"])(
    "Domain 不能依赖技术包：%s",
    (specifier) => {
      expect(
        dependencyViolations(
          `import "${specifier}";`,
          join(SRC, "features/memory/domain/probe.ts"),
          SRC,
          options,
        ),
      ).toHaveLength(1);
    },
  );

  it("Memory 内部允许引用自身文件", () => {
    expect(
      dependencyViolations(
        'import { DomainError } from "./domain-error.ts";',
        join(SRC, "features/memory/domain/probe.ts"),
        SRC,
        options,
      ),
    ).toEqual([]);
  });

  it("功能不能依赖基础设施与 UI，Memory 不能反向依赖其他功能", () => {
    for (const path of [
      "../../infrastructure/indexeddb/database.ts",
      "../../ui/primitives/button.tsx",
      "../../frontend/models/memory/record-form-model.ts",
    ]) {
      expect(dependencyViolations(`import "${path}";`, featureFile, SRC, options)).toHaveLength(1);
    }
    expect(
      dependencyViolations(
        'import "../fill-tasks/fill-task-service.ts";',
        join(SRC, "features/memory/probe.ts"),
        SRC,
        options,
      ),
    ).toHaveLength(1);
  });

  it("ESLint 同时保留 Memory 与外层限制，并拒绝 Domain 技术包导入", async () => {
    const lint = new ESLint({ cwd: ROOT });
    const probes = [
      {
        filePath: featureFile,
        source:
          'export { recordFieldValueText } from "../../frontend/models/memory/record-form-model.ts";',
      },
      { filePath: featureFile, source: `export { memoryProposalBatch } from "${internalPath}";` },
      {
        filePath: featureFile,
        source: 'export { SteMemoryDatabase } from "../../infrastructure/indexeddb/database.ts";',
      },
      {
        filePath: join(SRC, "features/memory/domain/probe.ts"),
        source: 'export { useState } from "react";',
      },
    ];
    for (const { source, filePath } of probes) {
      const [result] = await lint.lintText(source, { filePath });
      expect(result!.messages.some((message) => message.ruleId === "no-restricted-imports")).toBe(
        true,
      );
    }
    const [valid] = await lint.lintText(
      'export { MemoryRecordService } from "../memory/index.ts";',
      { filePath: featureFile },
    );
    expect(valid!.messages).toEqual([]);
    const [uiImport] = await lint.lintText('export { Button } from "./button.tsx";', {
      filePath: join(SRC, "ui/primitives/probe.ts"),
    });
    expect(uiImport!.messages).toEqual([]);
  });
});
