import { createHash } from "node:crypto";
import type {
  AutogenDiagnostic,
  PublicExportSummary,
} from "./public-surface.js";

export const BEGIN_AUTOGEN_MARKER = "<!-- BEGIN AUTOGEN -->";
export const END_AUTOGEN_MARKER = "<!-- END AUTOGEN -->";

export interface RenderGeneratedContractBlockInput {
  readonly ownerName: string;
  readonly contractPath: string;
  readonly exports: readonly PublicExportSummary[];
  readonly allowEmptySurface?: boolean;
}

export interface GeneratedContractBlock {
  readonly ownerName: string;
  readonly contractPath: string;
  readonly content: string;
  readonly digest: string;
  readonly exportCount: number;
}

export interface MarkerRegion {
  readonly beginMarkerLine: number;
  readonly endMarkerLine: number;
}

export interface ValidateAutogenMarkerRegionInput {
  readonly content: string;
  readonly contractPath?: string;
}

export interface ValidateAutogenMarkerRegionResult {
  readonly region?: MarkerRegion;
  readonly diagnostics: readonly AutogenDiagnostic[];
}

export interface ContractReplacementInput {
  readonly contractPath: string;
  readonly content: string;
  readonly generatedContent: string;
}

export interface ContractReplacement {
  readonly contractPath: string;
  readonly content: string;
  readonly unchanged: boolean;
  readonly changedLines: number;
  readonly region: MarkerRegion;
}

export interface ReplaceContractAutogenRegionsInput {
  readonly contracts: readonly ContractReplacementInput[];
}

export interface ReplaceContractAutogenRegionsResult {
  readonly replacements: readonly ContractReplacement[];
  readonly diagnostics: readonly AutogenDiagnostic[];
}

interface LineRecord {
  readonly text: string;
  readonly eol: string;
  readonly start: number;
  readonly end: number;
  readonly lineNumber: number;
}

const MAX_MESSAGE_LENGTH = 300;

export function renderGeneratedContractBlock(
  input: RenderGeneratedContractBlockInput,
): GeneratedContractBlock {
  const summaries = [...input.exports].sort(compareSummaries);
  const lines = [
    "### Generated TypeScript Public Surface",
    "",
    `Owner: \`${input.ownerName}\``,
    `Contract: \`${input.contractPath}\``,
    `Exports: ${summaries.length}`,
    "",
  ];

  if (summaries.length === 0) {
    lines.push(
      input.allowEmptySurface === true
        ? "No public exports are currently declared for this allowed empty surface."
        : "No public exports were extracted for this owner.",
    );
  } else {
    lines.push("| Source | Kind | Name | Type only | Signature |");
    lines.push("|---|---|---|---|---|");
    for (const summary of summaries) {
      lines.push(
        `| ${markdownCell(summary.sourcePath)} | ${markdownCell(summary.kind)} | ${markdownCell(summary.name)} | ${summary.typeOnly ? "yes" : "no"} | ${markdownCell(summary.signature)} |`,
      );
    }
  }

  const content = `${lines.join("\n")}\n`;
  return {
    ownerName: input.ownerName,
    contractPath: input.contractPath,
    content,
    digest: createHash("sha256").update(content).digest("hex"),
    exportCount: summaries.length,
  };
}

export function validateAutogenMarkerRegion(
  input: ValidateAutogenMarkerRegionInput,
): ValidateAutogenMarkerRegionResult {
  const lines = splitLines(input.content);
  const publicInterface = publicInterfaceBounds(lines);
  if (!publicInterface) {
    return {
      diagnostics: [
        markerDiagnostic(input.contractPath, "contract is missing a ## Public Interface section."),
      ],
    };
  }

  const beginLines: number[] = [];
  const endLines: number[] = [];
  let inFence = false;

  for (const line of lines) {
    if (isFenceLine(line.text)) inFence = !inFence;
    if (inFence) continue;
    if (line.text.trim() === BEGIN_AUTOGEN_MARKER) beginLines.push(line.lineNumber);
    if (line.text.trim() === END_AUTOGEN_MARKER) endLines.push(line.lineNumber);
  }

  const allMarkerLines = [...beginLines, ...endLines].sort(compareNumbers);
  const outsideMarkerLines = allMarkerLines.filter(
    (lineNumber) =>
      lineNumber <= publicInterface.startLine ||
      lineNumber >= publicInterface.endLineExclusive,
  );
  if (outsideMarkerLines.length > 0) {
    return {
      diagnostics: [
        markerDiagnostic(
          input.contractPath,
          "AUTOGEN markers must be inside the ## Public Interface section.",
        ),
      ],
    };
  }

  if (beginLines.length === 0 && endLines.length === 0) {
    return {
      diagnostics: [
        markerDiagnostic(input.contractPath, "AUTOGEN marker pair is missing."),
      ],
    };
  }

  if (beginLines.length !== 1 || endLines.length !== 1) {
    return {
      diagnostics: [
        markerDiagnostic(input.contractPath, "contract must contain exactly one AUTOGEN marker pair."),
      ],
    };
  }

  const beginMarkerLine = beginLines[0];
  const endMarkerLine = endLines[0];
  if (beginMarkerLine > endMarkerLine) {
    return {
      diagnostics: [
        markerDiagnostic(input.contractPath, "AUTOGEN end marker appears before begin marker."),
      ],
    };
  }

  return {
    region: { beginMarkerLine, endMarkerLine },
    diagnostics: [],
  };
}

export function replaceContractAutogenRegions(
  input: ReplaceContractAutogenRegionsInput,
): ReplaceContractAutogenRegionsResult {
  const pending: ContractReplacement[] = [];
  const diagnostics: AutogenDiagnostic[] = [];

  for (const contract of input.contracts) {
    const validation = validateAutogenMarkerRegion({
      content: contract.content,
      contractPath: contract.contractPath,
    });
    diagnostics.push(...validation.diagnostics);
    if (!validation.region) continue;

    const replacement = replaceOneContract(contract, validation.region);
    if ("diagnostic" in replacement) {
      diagnostics.push(replacement.diagnostic);
      continue;
    }
    pending.push(replacement);
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { replacements: [], diagnostics };
  }

  return { replacements: pending, diagnostics: [] };
}

function replaceOneContract(
  contract: ContractReplacementInput,
  region: MarkerRegion,
): ContractReplacement | { readonly diagnostic: AutogenDiagnostic } {
  const lines = splitLines(contract.content);
  const beginLine = lines[region.beginMarkerLine - 1];
  const endLine = lines[region.endMarkerLine - 1];
  if (!beginLine || !endLine) {
    return {
      diagnostic: writeSafetyDiagnostic(contract.contractPath, "validated AUTOGEN marker lines are out of range."),
    };
  }

  const prefixEnd = beginLine.end;
  const suffixStart = endLine.start;
  const normalizedGeneratedContent = normalizeGeneratedContent(contract.generatedContent);
  const updatedContent = `${contract.content.slice(0, prefixEnd)}${normalizedGeneratedContent}${contract.content.slice(suffixStart)}`;

  if (!updatedContent.startsWith(contract.content.slice(0, prefixEnd))) {
    return {
      diagnostic: writeSafetyDiagnostic(contract.contractPath, "replacement would change bytes before the AUTOGEN region."),
    };
  }
  if (!updatedContent.endsWith(contract.content.slice(suffixStart))) {
    return {
      diagnostic: writeSafetyDiagnostic(contract.contractPath, "replacement would change bytes after the AUTOGEN region."),
    };
  }

  return {
    contractPath: contract.contractPath,
    content: updatedContent,
    unchanged: updatedContent === contract.content,
    changedLines: changedLineCount(
      contract.content.slice(prefixEnd, suffixStart),
      normalizedGeneratedContent,
    ),
    region,
  };
}

function publicInterfaceBounds(
  lines: readonly LineRecord[],
): { readonly startLine: number; readonly endLineExclusive: number } | undefined {
  const start = lines.find((line) => line.text.trim() === "## Public Interface");
  if (!start) return undefined;

  const nextH2 = lines.find(
    (line) => line.lineNumber > start.lineNumber && /^##\s+\S/.test(line.text),
  );
  return {
    startLine: start.lineNumber,
    endLineExclusive: nextH2?.lineNumber ?? lines.length + 1,
  };
}

function splitLines(content: string): LineRecord[] {
  const lines: LineRecord[] = [];
  const pattern = /.*(?:\r\n|\n|\r|$)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const raw = match[0];
    if (raw === "") break;
    const eolMatch = raw.match(/(\r\n|\n|\r)$/);
    const eol = eolMatch?.[0] ?? "";
    lines.push({
      text: raw.slice(0, raw.length - eol.length),
      eol,
      start: match.index,
      end: match.index + raw.length,
      lineNumber: lines.length + 1,
    });
  }

  return lines;
}

function isFenceLine(line: string): boolean {
  return /^(```|~~~)/.test(line.trim());
}

function normalizeGeneratedContent(content: string): string {
  if (content === "") return "";
  return content.endsWith("\n") || content.endsWith("\r") ? content : `${content}\n`;
}

function changedLineCount(before: string, after: string): number {
  if (before === after) return 0;
  return Math.max(lineCount(before), lineCount(after));
}

function lineCount(content: string): number {
  if (content === "") return 0;
  return content.split(/\r\n|\n|\r/).filter((line, index, lines) => index < lines.length - 1 || line !== "").length;
}

function markdownCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function markerDiagnostic(contractPath: string | undefined, message: string): AutogenDiagnostic {
  return {
    category: "marker",
    severity: "error",
    ...(contractPath ? { contractPath } : {}),
    message: bounded(message),
  };
}

function writeSafetyDiagnostic(contractPath: string, message: string): AutogenDiagnostic {
  return {
    category: "write-safety",
    severity: "error",
    contractPath,
    message: bounded(message),
  };
}

function bounded(message: string): string {
  return message.length > MAX_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_MESSAGE_LENGTH - 3)}...`
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
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareNumbers(a: number, b: number): number {
  return a - b;
}
