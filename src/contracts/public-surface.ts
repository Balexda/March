import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export type PublicExportKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "const"
  | "enum"
  | "re-export"
  | "namespace"
  | "default";

export interface PublicExportSummary {
  readonly sourcePath: string;
  readonly kind: PublicExportKind;
  readonly name: string;
  readonly signature: string;
  readonly typeOnly: boolean;
}

export type AutogenDiagnosticCategory = "parse" | "extraction" | "config";
export type AutogenDiagnosticSeverity = "error" | "warning";

export interface AutogenDiagnostic {
  readonly category: AutogenDiagnosticCategory;
  readonly severity: AutogenDiagnosticSeverity;
  readonly sourcePath?: string;
  readonly message: string;
}

export interface ExtractPublicSurfaceInput {
  readonly repoRoot: string;
  readonly sourcePaths: readonly string[];
}

export interface ExtractPublicSurfaceResult {
  readonly summaries: readonly PublicExportSummary[];
  readonly diagnostics: readonly AutogenDiagnostic[];
}

const MAX_DIAGNOSTICS_PER_FILE = 5;
const MAX_MESSAGE_LENGTH = 300;

const printer = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
  removeComments: true,
});

export function extractPublicTypeScriptSurface(
  input: ExtractPublicSurfaceInput,
): ExtractPublicSurfaceResult {
  const repoRoot = path.resolve(input.repoRoot);
  const diagnostics: AutogenDiagnostic[] = [];
  const summaries: PublicExportSummary[] = [];

  for (const sourcePath of [...input.sourcePaths].sort(compareStrings)) {
    const resolved = resolveRepoPath(repoRoot, sourcePath);
    if (!resolved) {
      diagnostics.push({
        category: "config",
        severity: "error",
        sourcePath,
        message: "Source path must be repo-relative and stay inside the repository.",
      });
      continue;
    }

    let sourceText: string;
    try {
      sourceText = fs.readFileSync(resolved, "utf8");
    } catch (error) {
      diagnostics.push({
        category: "config",
        severity: "error",
        sourcePath,
        message: boundedMessage(error),
      });
      continue;
    }

    const sourceFile = ts.createSourceFile(
      sourcePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const parseDiagnostics = parseDiagnosticsFor(sourceFile).slice(0, MAX_DIAGNOSTICS_PER_FILE);
    if (parseDiagnostics.length > 0) {
      for (const diagnostic of parseDiagnostics) {
        diagnostics.push({
          category: "parse",
          severity: "error",
          sourcePath,
          message: formatTsDiagnostic(diagnostic, sourceFile),
        });
      }
      continue;
    }

    summaries.push(...extractSourceFileSummaries(sourceFile, sourcePath, diagnostics));
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { summaries: [], diagnostics };
  }

  return {
    summaries: [...summaries].sort(compareSummaries),
    diagnostics,
  };
}

function extractSourceFileSummaries(
  sourceFile: ts.SourceFile,
  sourcePath: string,
  diagnostics: AutogenDiagnostic[],
): PublicExportSummary[] {
  const summaries: PublicExportSummary[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      summaries.push(...summariesForExportDeclaration(statement, sourceFile, sourcePath));
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      if (statement.isExportEquals) {
        diagnostics.push({
          category: "extraction",
          severity: "error",
          sourcePath,
          message: "Unsupported export syntax: export assignment with equals.",
        });
        continue;
      }
      summaries.push({
        sourcePath,
        kind: "default",
        name: "default",
        signature: normalizeSignature(`export default ${expressionShape(statement.expression)};`),
        typeOnly: false,
      });
      continue;
    }

    if (!hasExportModifier(statement)) continue;

    if (ts.isFunctionDeclaration(statement)) {
      summaries.push({
        sourcePath,
        kind: hasDefaultModifier(statement) ? "default" : "function",
        name: hasDefaultModifier(statement) ? "default" : declarationName(statement.name),
        signature: printNode(stripFunctionBody(statement), sourceFile),
        typeOnly: false,
      });
      continue;
    }

    if (ts.isClassDeclaration(statement)) {
      summaries.push({
        sourcePath,
        kind: hasDefaultModifier(statement) ? "default" : "class",
        name: hasDefaultModifier(statement) ? "default" : declarationName(statement.name),
        signature: printNode(stripClassBody(statement), sourceFile),
        typeOnly: false,
      });
      continue;
    }

    if (ts.isInterfaceDeclaration(statement)) {
      summaries.push({
        sourcePath,
        kind: "interface",
        name: statement.name.text,
        signature: printNode(statement, sourceFile),
        typeOnly: true,
      });
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      summaries.push({
        sourcePath,
        kind: "type",
        name: statement.name.text,
        signature: printNode(statement, sourceFile),
        typeOnly: true,
      });
      continue;
    }

    if (ts.isEnumDeclaration(statement)) {
      summaries.push({
        sourcePath,
        kind: "enum",
        name: statement.name.text,
        signature: printNode(statement, sourceFile),
        typeOnly: false,
      });
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      summaries.push(...summariesForVariableStatement(statement, sourceFile, sourcePath, diagnostics));
      continue;
    }

    diagnostics.push({
      category: "extraction",
      severity: "error",
      sourcePath,
      message: `Unsupported exported declaration syntax: ${ts.SyntaxKind[statement.kind]}.`,
    });
  }

  return summaries;
}

function summariesForVariableStatement(
  statement: ts.VariableStatement,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  diagnostics: AutogenDiagnostic[],
): PublicExportSummary[] {
  const summaries: PublicExportSummary[] = [];

  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name)) {
      diagnostics.push({
        category: "extraction",
        severity: "error",
        sourcePath,
        message: "Unsupported exported variable declaration: binding patterns are not deterministic public names.",
      });
      continue;
    }

    summaries.push({
      sourcePath,
      kind: "const",
      name: declaration.name.text,
      signature: signatureForVariable(statement, declaration, sourceFile),
      typeOnly: false,
    });
  }

  return summaries;
}

function summariesForExportDeclaration(
  statement: ts.ExportDeclaration,
  sourceFile: ts.SourceFile,
  sourcePath: string,
): PublicExportSummary[] {
  const moduleText = statement.moduleSpecifier ? statement.moduleSpecifier.getText(sourceFile) : undefined;
  const typeOnly = Boolean(statement.isTypeOnly);

  if (!statement.exportClause) {
    return [
      {
        sourcePath,
        kind: "namespace",
        name: "*",
        signature: normalizeSignature(`export *${moduleText ? ` from ${moduleText}` : ""};`),
        typeOnly,
      },
    ];
  }

  if (ts.isNamespaceExport(statement.exportClause)) {
    const name = statement.exportClause.name.text;
    return [
      {
        sourcePath,
        kind: "namespace",
        name,
        signature: normalizeSignature(`export * as ${name}${moduleText ? ` from ${moduleText}` : ""};`),
        typeOnly,
      },
    ];
  }

  return statement.exportClause.elements.map((specifier) => {
    const exportedName = specifier.name.text;
    const importedName = specifier.propertyName?.text;
    const isDefault = exportedName === "default";
    const specifierText =
      importedName && importedName !== exportedName
        ? `${importedName} as ${exportedName}`
        : exportedName;

    return {
      sourcePath,
      kind: isDefault ? "default" : "re-export",
      name: exportedName,
      signature: normalizeSignature(
        `export ${typeOnly || specifier.isTypeOnly ? "type " : ""}{ ${specifierText} }${moduleText ? ` from ${moduleText}` : ""};`,
      ),
      typeOnly: typeOnly || specifier.isTypeOnly,
    };
  });
}

function signatureForVariable(
  statement: ts.VariableStatement,
  declaration: ts.VariableDeclaration,
  sourceFile: ts.SourceFile,
): string {
  const keyword = declarationListKeyword(statement.declarationList);
  const modifiers = modifiersText(statement);
  const typeText = declaration.type ? `: ${declaration.type.getText(sourceFile)}` : "";
  const initializerText = declaration.type || !declaration.initializer
    ? ""
    : ` = ${expressionShape(declaration.initializer)}`;
  return normalizeSignature(`${modifiers}${keyword} ${declaration.name.getText(sourceFile)}${typeText}${initializerText};`);
}

function stripFunctionBody(node: ts.FunctionDeclaration): ts.FunctionDeclaration {
  return ts.factory.updateFunctionDeclaration(
    node,
    node.modifiers,
    node.asteriskToken,
    node.name,
    node.typeParameters,
    node.parameters,
    node.type,
    undefined,
  );
}

function stripClassBody(node: ts.ClassDeclaration): ts.ClassDeclaration {
  return ts.factory.updateClassDeclaration(
    node,
    node.modifiers,
    node.name,
    node.typeParameters,
    node.heritageClauses,
    node.members
      .filter(
        (member) =>
          !ts.isClassStaticBlockDeclaration(member) &&
          !hasPrivateModifier(member) &&
          (!member.name || !ts.isPrivateIdentifier(member.name)),
      )
      .map(stripClassMemberBody),
  );
}

function stripClassMemberBody(member: ts.ClassElement): ts.ClassElement {
  if (ts.isMethodDeclaration(member)) {
    return ts.factory.updateMethodDeclaration(
      member,
      member.modifiers,
      member.asteriskToken,
      member.name,
      member.questionToken,
      member.typeParameters,
      member.parameters,
      member.type,
      undefined,
    );
  }

  if (ts.isConstructorDeclaration(member)) {
    return ts.factory.updateConstructorDeclaration(
      member,
      member.modifiers,
      member.parameters,
      undefined,
    );
  }

  if (ts.isGetAccessorDeclaration(member)) {
    return ts.factory.updateGetAccessorDeclaration(
      member,
      member.modifiers,
      member.name,
      member.parameters,
      member.type,
      undefined,
    );
  }

  if (ts.isSetAccessorDeclaration(member)) {
    return ts.factory.updateSetAccessorDeclaration(
      member,
      member.modifiers,
      member.name,
      member.parameters,
      undefined,
    );
  }

  return member;
}

function hasExportModifier(node: ts.Node): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
}

function hasDefaultModifier(node: ts.Node): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword),
  );
}

function hasPrivateModifier(node: ts.Node): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword),
  );
}

function declarationName(name: ts.Identifier | undefined): string {
  return name?.text ?? "default";
}

function printNode(node: ts.Node, sourceFile: ts.SourceFile): string {
  return normalizeSignature(printer.printNode(ts.EmitHint.Unspecified, node, sourceFile));
}

function normalizeSignature(signature: string): string {
  return signature
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

function modifiersText(statement: ts.VariableStatement): string {
  const modifiers = ts.getModifiers(statement) ?? [];
  const text = modifiers.map((modifier) => modifier.getText()).join(" ");
  return text ? `${text} ` : "";
}

function declarationListKeyword(list: ts.VariableDeclarationList): "const" | "let" | "var" {
  if ((list.flags & ts.NodeFlags.Const) !== 0) return "const";
  if ((list.flags & ts.NodeFlags.Let) !== 0) return "let";
  return "var";
}

function expressionShape(expression: ts.Expression): string {
  if (
    ts.isStringLiteral(expression) ||
    ts.isNumericLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword
  ) {
    return normalizeSignature(expression.getText());
  }

  if (ts.isObjectLiteralExpression(expression)) return "{ ... }";
  if (ts.isArrayLiteralExpression(expression)) return "[ ... ]";
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return "function";
  if (ts.isClassExpression(expression)) return "class";
  if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
    return normalizeSignature(expression.getText());
  }

  return ts.SyntaxKind[expression.kind] ?? "expression";
}

function resolveRepoPath(repoRoot: string, repoRelativePath: string): string | undefined {
  if (path.isAbsolute(repoRelativePath)) return undefined;

  const resolved = path.resolve(repoRoot, repoRelativePath);
  const relative = path.relative(repoRoot, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }

  return resolved;
}

function formatTsDiagnostic(diagnostic: ts.Diagnostic, sourceFile: ts.SourceFile): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  if (diagnostic.start === undefined) return truncate(message);

  const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
  return truncate(`${position.line + 1}:${position.character + 1} ${message}`);
}

function parseDiagnosticsFor(sourceFile: ts.SourceFile): readonly ts.Diagnostic[] {
  return ((sourceFile as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics ?? []);
}

function boundedMessage(error: unknown): string {
  return truncate(error instanceof Error ? error.message : String(error));
}

function truncate(message: string): string {
  return message.length > MAX_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}...`
    : message;
}

function compareSummaries(a: PublicExportSummary, b: PublicExportSummary): number {
  return (
    compareStrings(a.sourcePath, b.sourcePath) ||
    compareStrings(a.kind, b.kind) ||
    compareStrings(a.name, b.name) ||
    compareStrings(a.signature, b.signature)
  );
}

function compareStrings(a: string, b: string): number {
  return a.localeCompare(b, "en");
}
