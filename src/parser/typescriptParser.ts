import * as ts from "typescript";

import type { SymbolDef, ImportDecl, ExportDecl, CallSite, SymbolKind } from "../domain/model";
import { symbolId } from "../shared/ids";
import type { HeritageInfo, SourceParser } from "./parser";
import { extName } from "../shared/ids";

/**
 * TypeScript/JavaScript parser built on the TypeScript Compiler API.
 *
 * Rationale (ADR-1): the TS compiler gives exact import/export/symbol
 * extraction for `.ts` and `.js` with zero native dependencies, at a fraction
 * of the maintenance cost of a second parser stack (Tree-sitter). Malformed
 * input still parses (error-tolerant); parse errors are recorded on the
 * result rather than thrown.
 */
export class TypeScriptParser implements SourceParser {
  readonly language = "typescript" as const;

  supports(path: string): boolean {
    const ext = extName(path);
    return [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(ext);
  }

  parse(path: string, content: string): ParsedResult {
    const kind = scriptKind(path);
    const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, kind);
    const parseDiagnostics = (
      sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }
    ).parseDiagnostics;
    const parseError =
      parseDiagnostics && parseDiagnostics.length > 0
        ? summarizeDiagnostics(parseDiagnostics, sourceFile)
        : undefined;

    const symbols: SymbolDef[] = [];
    const imports: ImportDecl[] = [];
    const exports: ExportDecl[] = [];
    const calls: CallSite[] = [];
    const heritages: HeritageInfo[] = [];

    const fileDoc = leadingDocComment(sourceFile, content);

    const visit = (node: ts.Node, parentSymbolId: string | undefined): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push({
          sourceText: node.moduleSpecifier.text,
          importedNames: extractImportedNames(node.importClause),
          startLine: lineOf(node, sourceFile),
          isExternal: !node.moduleSpecifier.text.startsWith("."),
        });
        return; // imports have no nested symbols we care about
      }

      // `export ... from "mod"` is both a re-export and an import edge.
      if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        imports.push({
          sourceText: node.moduleSpecifier.text,
          importedNames: extractExportClauseNames(node.exportClause),
          startLine: lineOf(node, sourceFile),
          isExternal: !node.moduleSpecifier.text.startsWith("."),
        });
        exports.push({ name: "*", startLine: lineOf(node, sourceFile) });
        return;
      }

      if (ts.isExportAssignment(node)) {
        exports.push({ name: "default", startLine: lineOf(node, sourceFile) });
      }

      // Dynamic `import("...")`: exact only when the specifier is a literal.
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          imports.push({
            sourceText: arg.text,
            importedNames: ["*"],
            startLine: lineOf(node, sourceFile),
            isExternal: !arg.text.startsWith("."),
          });
        } else {
          imports.push({
            sourceText: "<dynamic>",
            importedNames: ["*"],
            startLine: lineOf(node, sourceFile),
            isExternal: true,
          });
        }
      }

      // CommonJS `require("...")`
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const arg = node.arguments[0] as ts.StringLiteral;
        imports.push({
          sourceText: arg.text,
          importedNames: ["*"],
          startLine: lineOf(node, sourceFile),
          isExternal: !arg.text.startsWith("."),
        });
      }

      // Call sites (incl. `new X()` constructors).
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const calleeName = calleeNameOf(node);
        if (calleeName) {
          calls.push({
            callerId: parentSymbolId ?? `file:${path}`,
            calleeName,
            startLine: lineOf(node, sourceFile),
          });
        }
      }

      if (ts.isClassDeclaration(node) && node.name) {
        const name = node.name.text;
        const start = lineOf(node, sourceFile);
        const id = symbolId(path, name, "class", start);
        symbols.push({
          id,
          name,
          kind: "class",
          filePath: path,
          startLine: start,
          endLine: endLineOf(node, sourceFile),
          signature: classSignature(node, sourceFile),
          docComment: docCommentOf(node, sourceFile, content),
          exportKind: exportKindOf(node),
        });
        const extendsClause = node.heritageClauses?.find(
          (h) => h.token === ts.SyntaxKind.ExtendsKeyword,
        );
        const implementsClause = node.heritageClauses?.find(
          (h) => h.token === ts.SyntaxKind.ImplementsKeyword,
        );
        if (extendsClause) {
          heritages.push({
            symbolName: name,
            kind: "extends",
            parents: heritageNames(extendsClause),
            startLine: start,
          });
        }
        if (implementsClause) {
          heritages.push({
            symbolName: name,
            kind: "implements",
            parents: heritageNames(implementsClause),
            startLine: start,
          });
        }
        for (const member of node.members) {
          visitMember(member, path, id, sourceFile, symbols, calls, name);
        }
        return;
      }

      if (ts.isInterfaceDeclaration(node) && node.name) {
        const name = node.name.text;
        const start = lineOf(node, sourceFile);
        const id = symbolId(path, name, "interface", start);
        symbols.push({
          id,
          name,
          kind: "interface",
          filePath: path,
          startLine: start,
          endLine: endLineOf(node, sourceFile),
          signature: `interface ${name}${extendsSuffix(node)}`,
          docComment: docCommentOf(node, sourceFile, content),
          exportKind: exportKindOf(node),
        });
        const extendsClause = node.heritageClauses?.find(
          (h) => h.token === ts.SyntaxKind.ExtendsKeyword,
        );
        if (extendsClause) {
          heritages.push({
            symbolName: name,
            kind: "extends",
            parents: heritageNames(extendsClause),
            startLine: start,
          });
        }
        for (const member of node.members) {
          visitMember(member, path, id, sourceFile, symbols, calls, name);
        }
        return;
      }

      if (ts.isTypeAliasDeclaration(node) && node.name) {
        const start = lineOf(node, sourceFile);
        symbols.push({
          id: symbolId(path, node.name.text, "type", start),
          name: node.name.text,
          kind: "type",
          filePath: path,
          startLine: start,
          endLine: endLineOf(node, sourceFile),
          signature: `type ${node.name.text}${typeParams(node.typeParameters)} = ${firstLine(node, sourceFile, content, "type")}`,
          docComment: docCommentOf(node, sourceFile, content),
          exportKind: exportKindOf(node),
        });
        return;
      }

      if (ts.isEnumDeclaration(node) && node.name) {
        const start = lineOf(node, sourceFile);
        symbols.push({
          id: symbolId(path, node.name.text, "enum", start),
          name: node.name.text,
          kind: "enum",
          filePath: path,
          startLine: start,
          endLine: endLineOf(node, sourceFile),
          signature: `enum ${node.name.text}`,
          docComment: docCommentOf(node, sourceFile, content),
          exportKind: exportKindOf(node),
        });
        return;
      }

      if (ts.isModuleDeclaration(node)) {
        const nameNode = node.name;
        if (ts.isIdentifier(nameNode) && node.body) {
          const start = lineOf(node, sourceFile);
          const id = symbolId(path, nameNode.text, "namespace", start);
          symbols.push({
            id,
            name: nameNode.text,
            kind: "namespace",
            filePath: path,
            startLine: start,
            endLine: endLineOf(node, sourceFile),
            signature: `namespace ${nameNode.text}`,
            docComment: docCommentOf(node, sourceFile, content),
            exportKind: exportKindOf(node),
          });
          ts.forEachChild(node.body, (child) => visit(child, id));
          return;
        }
      }

      if (ts.isFunctionDeclaration(node) && node.name) {
        const start = lineOf(node, sourceFile);
        const id = symbolId(path, node.name.text, "function", start);
        symbols.push({
          id,
          name: node.name.text,
          kind: "function",
          filePath: path,
          startLine: start,
          endLine: endLineOf(node, sourceFile),
          signature: functionSignature(node, sourceFile, node.name.text),
          docComment: docCommentOf(node, sourceFile, content),
          exportKind: exportKindOf(node),
        });
        ts.forEachChild(node.body && ts.isBlock(node.body) ? node.body : node, (child) =>
          visit(child, id),
        );
        return;
      }

      if (ts.isVariableStatement(node)) {
        const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        for (const decl of node.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          const start = lineOf(decl, sourceFile);
          const isFn =
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));
          const kind: SymbolKind = isFn ? "function" : "variable";
          const id = symbolId(path, decl.name.text, kind, start);
          symbols.push({
            id,
            name: decl.name.text,
            kind,
            filePath: path,
            startLine: start,
            endLine: endLineOf(node, sourceFile),
            signature: `${isExported ? "export " : ""}${isFn ? "function" : node.declarationList.flags & ts.NodeFlags.Const ? "const" : "let"} ${decl.name.text}${typeParams(isFn && decl.initializer ? (decl.initializer as ts.ArrowFunction).typeParameters : undefined)}${isFn ? fnParams((decl.initializer as ts.ArrowFunction).parameters, sourceFile) : ""}`,
            docComment: docCommentOf(node, sourceFile, content),
            exportKind: isExported ? "named" : undefined,
          });
          if (decl.initializer) {
            // Walk the whole initializer (arrow bodies, IIFEs, blocks) so call
            // sites inside const arrows are captured.
            visit(decl.initializer, id);
          }
        }
        return;
      }

      ts.forEachChild(node, (child) => visit(child, parentSymbolId));
    };

    ts.forEachChild(sourceFile, (node) => visit(node, undefined));

    // Exported names from `export { a, b }` / `export const x` / `export function f`.
    collectExportNames(sourceFile, exports);

    // Determine exported status per symbol from collected exports.
    const exportedNames = new Set(exports.map((e) => e.name));
    for (const sym of symbols) {
      if (sym.exportKind === undefined && exportedNames.has(sym.name)) {
        sym.exportKind = "named";
      }
    }

    return {
      path,
      language: path.endsWith(".d.ts")
        ? "typescript"
        : /\.m?jsx?$/.test(path)
          ? "javascript"
          : "typescript",
      symbols,
      imports,
      exports,
      calls,
      heritages,
      fileSummary: fileDoc ?? undefined,
      identifiers: extractIdentifiers(content),
      parseError,
    };
  }
}

type ParsedResult = import("./parser").ParsedFile;

const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]{2,}/g;
const MAX_IDENTIFIERS = 400;

/** Deterministic, order-preserving unique identifier harvest (capped). */
export function extractIdentifiers(content: string): string[] {
  const seen = new Set<string>();
  const matches = content.match(IDENTIFIER_RE) ?? [];
  for (const m of matches) seen.add(m);
  return [...seen].slice(0, MAX_IDENTIFIERS);
}

interface tsDiagnosticLike {
  messageText: string | { messageText?: string };
  start?: number;
}

function summarizeDiagnostics(diags: readonly tsDiagnosticLike[], sf: ts.SourceFile): string {
  const first = diags[0];
  const line =
    first?.start !== undefined ? sf.getLineAndCharacterOfPosition(first.start).line + 1 : 0;
  const message =
    typeof first?.messageText === "string"
      ? first.messageText
      : (first?.messageText?.messageText ?? "parse error");
  return `syntax error at line ${line}: ${message}`;
}

function scriptKind(path: string): ts.ScriptKind {
  const ext = extName(path);
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function lineOf(node: ts.Node, sf: ts.SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function endLineOf(node: ts.Node, sf: ts.SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

function extractImportedNames(clause: ts.ImportClause | undefined): string[] {
  if (!clause) return ["*"];
  const names: string[] = [];
  if (clause.name) names.push("default");
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) names.push("*");
    else
      for (const el of clause.namedBindings.elements)
        names.push(el.propertyName?.text ?? el.name.text);
  }
  return names.length ? names : ["*"];
}

function extractExportClauseNames(clause: ts.ExportDeclaration["exportClause"]): string[] {
  if (!clause) return ["*"];
  if (ts.isNamespaceExport(clause)) return ["*"];
  return clause.elements.map((el) => el.propertyName?.text ?? el.name.text);
}

function collectExportNames(sf: ts.SourceFile, out: ExportDecl[]): void {
  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) {
        out.push({ name: el.propertyName?.text ?? el.name.text, startLine: lineOf(node, sf) });
      }
    }
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          out.push({ name: decl.name.text, startLine: lineOf(node, sf) });
        }
      }
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      out.push({ name: node.name.text, startLine: lineOf(node, sf) });
    }
    if (
      ts.isClassDeclaration(node) &&
      node.name &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      out.push({ name: node.name.text, startLine: lineOf(node, sf) });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
}

function visitMember(
  member: ts.ClassElement | ts.TypeElement,
  filePath: string,
  parentId: string,
  sf: ts.SourceFile,
  symbols: SymbolDef[],
  calls: CallSite[],
  ownerName: string,
): void {
  let name: string | undefined;
  let kind: SymbolKind | undefined;
  if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
    name = member.name && ts.isIdentifier(member.name) ? member.name.text : "<computed>";
    kind = "method";
  } else if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
    name = member.name && ts.isIdentifier(member.name) ? member.name.text : "<computed>";
    kind = "property";
  } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
    name = member.name && ts.isIdentifier(member.name) ? member.name.text : "<computed>";
    kind = "method";
  } else if (ts.isConstructorDeclaration(member)) {
    name = "constructor";
    kind = "method";
  }
  if (!name || !kind) return;
  const start = lineOf(member, sf);
  const id = symbolId(filePath, `${ownerName}.${name}`, kind, start);
  symbols.push({
    id,
    name: `${ownerName}.${name}`,
    kind,
    filePath,
    startLine: start,
    endLine: endLineOf(member, sf),
    signature: memberSignature(member, name, sf),
    docComment: docCommentOf(member, sf, sf.text),
    parentId,
  });
  const body =
    ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member) ? member.body : undefined;
  if (body) {
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = calleeNameOf(node);
        if (callee) {
          calls.push({ callerId: id, calleeName: callee, startLine: lineOf(node, sf) });
        }
      }
      ts.forEachChild(node, walk);
    };
    ts.forEachChild(body, walk);
  }
}

function calleeNameOf(node: ts.CallExpression | ts.NewExpression): string | undefined {
  const expr = node.expression;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isElementAccessExpression(expr) && expr.argumentExpression) {
    const arg = expr.argumentExpression;
    if (ts.isStringLiteral(arg)) return arg.text;
  }
  return undefined;
}

function docCommentOf(node: ts.Node, sf: ts.SourceFile, _content: string): string | undefined {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart());
  if (!ranges || ranges.length === 0) return undefined;
  const last = ranges[ranges.length - 1];
  const text = sf.text.slice(last.pos, last.end);
  if (!text.startsWith("/**")) return undefined;
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\/?\*+\s?/, "").trim())
    .filter((l) => l.length > 0 && l !== "/" && !l.startsWith("@"))
    .join(" ")
    .slice(0, 300);
}

function leadingDocComment(sf: ts.SourceFile, content: string): string | undefined {
  const ranges = ts.getLeadingCommentRanges(content, 0);
  if (!ranges || ranges.length === 0) return undefined;
  const text = content.slice(ranges[0].pos, ranges[0].end);
  if (!text.startsWith("/**")) return undefined;
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\/?\*+\s?/, "").trim())
    .filter((l) => l.length > 0)
    .join(" ")
    .slice(0, 300);
}

function exportKindOf(node: ts.Node): "named" | "default" | undefined {
  const mods = (node as ts.HasModifiers).modifiers;
  if (!mods) return undefined;
  if (mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return "default";
  if (mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return "named";
  return undefined;
}

function heritageNames(clause: ts.HeritageClause): string[] {
  return clause.types.map((t) => t.expression.getText().trim());
}

function extendsSuffix(node: ts.InterfaceDeclaration): string {
  const ext = node.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
  return ext ? ` extends ${heritageNames(ext).join(", ")}` : "";
}

function classSignature(node: ts.ClassDeclaration, sf: ts.SourceFile): string {
  const name = node.name?.text ?? "<anonymous>";
  const parts = [`class ${name}`];
  for (const clause of node.heritageClauses ?? []) {
    parts.push(
      `${clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements"} ${heritageNames(clause).join(", ")}`,
    );
  }
  const firstMemberStart = node.members[0]?.getStart(sf) ?? node.getEnd();
  const first = sf.text.slice(node.getStart(sf), firstMemberStart);
  const generics = first.match(/<[^>]*>/);
  if (generics) parts[0] += generics[0];
  return parts.join(" ").slice(0, 200);
}

function typeParams(params: readonly ts.TypeParameterDeclaration[] | undefined): string {
  if (!params || params.length === 0) return "";
  return `<${params.map((p) => p.name.text).join(", ")}>`;
}

function fnParams(params: readonly ts.ParameterDeclaration[], sf: ts.SourceFile): string {
  const rendered = params.map((p) => {
    const type = p.type ? `: ${p.type.getText(sf)}` : "";
    const opt = p.questionToken ? "?" : "";
    return `${ts.isIdentifier(p.name) ? p.name.text : "..."}${opt}${type}`;
  });
  return `(${rendered.join(", ")})`;
}

function functionSignature(
  node:
    | ts.FunctionDeclaration
    | ts.ArrowFunction
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration
    | ts.FunctionExpression,
  sf: ts.SourceFile,
  name: string,
): string {
  const params = fnParams(node.parameters, sf);
  const ret = "type" in node && node.type ? `: ${node.type.getText(sf)}` : "";
  const generics = "typeParameters" in node ? typeParams(node.typeParameters) : "";
  return `function ${name}${generics}${params}${ret}`.slice(0, 220);
}

function memberSignature(
  member: ts.ClassElement | ts.TypeElement,
  name: string,
  sf: ts.SourceFile,
): string {
  if (ts.isConstructorDeclaration(member)) {
    return `constructor${fnParams(member.parameters, sf)}`;
  }
  if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
    const mods = member.modifiers ?? [];
    const prefix = mods.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ? "static " : "";
    const ret = member.type ? `: ${member.type.getText(sf)}` : "";
    return `${prefix}${name}${typeParams("typeParameters" in member ? member.typeParameters : undefined)}${fnParams("parameters" in member ? member.parameters : [], sf)}${ret}`.slice(
      0,
      220,
    );
  }
  if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
    const type = member.type ? `: ${member.type.getText(sf)}` : "";
    return `${name}${type}`.slice(0, 220);
  }
  return name;
}

function firstLine(node: ts.Node, sf: ts.SourceFile, _content: string, _kind: string): string {
  const text = node.getText(sf).split(/\r?\n/)[0] ?? "";
  return text.slice(0, 200);
}
