import { relative, sep } from "node:path";
import ts from "typescript";

/** 使用编译器的路径解析，让别名、相对路径和重导出遵守同一条边界。 */
export function dependencyViolations(
  source: string,
  file: string,
  sourceRoot: string,
  compilerOptions: ts.CompilerOptions,
): string[] {
  const sourcePath = relative(sourceRoot, file).split(sep).join("/");
  const inMemory = sourcePath.startsWith("features/memory/");
  const inDomain = sourcePath.startsWith("features/memory/domain/");
  const isTest = /\.test\.tsx?$/.test(file);
  const violations: string[] = [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);

  function inspect(specifier: string): void {
    const module = ts.resolveModuleName(specifier, file, compilerOptions, ts.sys).resolvedModule;
    const targetPath = module && relative(sourceRoot, module.resolvedFileName).split(sep).join("/");
    const targetInMemory = targetPath?.startsWith("features/memory/");
    let reason: string | undefined;
    if (inDomain && !isTest && !targetPath?.startsWith("features/memory/domain/")) {
      reason = "Domain 只依赖自身";
    } else if (!inMemory && targetInMemory && targetPath !== "features/memory/index.ts") {
      reason = "Memory 必须通过公开入口访问";
    } else if (
      sourcePath.startsWith("features/") &&
      !isTest &&
      (targetPath?.startsWith("infrastructure/") || targetPath?.startsWith("ui/"))
    ) {
      reason = "功能层不依赖基础设施或 UI";
    } else if (inMemory && targetPath?.startsWith("features/") && !targetInMemory) {
      reason = "Memory 不反向依赖其他功能";
    }
    if (reason) violations.push(`${sourcePath}: ${specifier} (${reason})`);
  }

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      inspect(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      inspect(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) inspect(argument.text);
      else violations.push(`${sourcePath}: 动态导入必须使用可检查的字面量路径`);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      inspect(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(tree);
  return violations;
}
