/**
 * FU9/review: syntax-aware extraction of module specifiers for the outbound
 * network policy audit. The previous regex extractor missed `export * from
 * "node:https"` and flagged commented-out imports. This scanner walks the
 * real AST (TypeScript's own parser — already a runtime dependency), so
 * comments, prose, and string CONTENT can never produce false positives, and
 * every supported import form is covered:
 * - static imports (named, default, namespace, bare side-effect)
 * - re-exports (`export ... from "mod"`, `export * from "mod"`)
 * - CommonJS `require("mod")` calls
 * - `import eq = require("mod")` and `import eq = "mod"`
 * - dynamic `import("mod")` with a string-literal argument
 * Specifiers are returned raw (`node:`, subpaths, scoped packages included).
 */
import * as ts from "typescript";

export function importedSpecifiersSyntax(source: string, fileName = "audit.ts"): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      out.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      out.push(node.arguments[0]!.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      out.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      out.push(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}
