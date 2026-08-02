import fs from "node:fs";
import path from "node:path";
import {
  renderGeneratedContractBlock,
  replaceContractAutogenRegions,
  validateAutogenMarkerRegion,
  type GeneratedContractBlock,
} from "./contract-region.js";
import {
  DEFAULT_EXTRACTION_OWNERSHIP_CONFIG_PATH,
  loadExtractionOwnershipConfig,
  resolveExtractionSourceSurfaces,
  type ExtractionOwner,
  type SourceSurface,
} from "./extraction-ownership.js";
import {
  extractPublicTypeScriptSurface,
  type AutogenDiagnostic,
} from "./public-surface.js";

export type AutogenCommandMode = "check" | "write";
export type AutogenCommandStatus = "pass" | "fail";

export interface RunAutogenCommandInput {
  readonly repoRoot?: string;
  readonly mode: AutogenCommandMode;
  readonly configPath?: string;
}

export interface AutogenCommandResult {
  readonly mode: AutogenCommandMode;
  readonly status: AutogenCommandStatus;
  readonly checkedContracts: number;
  readonly extractedExports: number;
  readonly staleContracts: readonly string[];
  readonly updatedContracts: readonly string[];
  readonly diagnostics: readonly AutogenDiagnostic[];
}

interface PreparedContract {
  readonly owner: ExtractionOwner;
  readonly surface: SourceSurface;
  readonly block: GeneratedContractBlock;
  readonly currentContent: string;
  readonly stale: boolean;
}

interface ParsedArgs {
  readonly mode?: AutogenCommandMode;
  readonly repoRoot: string;
  readonly configPath?: string;
  readonly diagnostics: readonly AutogenDiagnostic[];
}

const MAX_MESSAGE_LENGTH = 300;
const MAX_FORMATTED_DIAGNOSTICS = 50;

export function runAutogenCommand(input: RunAutogenCommandInput): AutogenCommandResult {
  const repoRoot = path.resolve(input.repoRoot ?? process.cwd());
  const diagnostics: AutogenDiagnostic[] = [];

  const ownership = loadExtractionOwnershipConfig({
    repoRoot,
    configPath: input.configPath ?? DEFAULT_EXTRACTION_OWNERSHIP_CONFIG_PATH,
  });
  diagnostics.push(...ownership.diagnostics);
  if (!ownership.config) {
    return commandResult(input.mode, 0, 0, [], [], diagnostics);
  }

  const surfaces = resolveExtractionSourceSurfaces({
    repoRoot,
    config: ownership.config,
  });
  diagnostics.push(...surfaces.diagnostics);
  if (surfaces.diagnostics.some(isErrorDiagnostic)) {
    return commandResult(input.mode, ownership.config.owners.length, 0, [], [], diagnostics);
  }

  const ownersByName = new Map(
    ownership.config.owners.map((owner) => [owner.name, owner]),
  );
  const prepared: PreparedContract[] = [];
  let extractedExports = 0;

  for (const surface of surfaces.surfaces) {
    const owner = ownersByName.get(surface.ownerName);
    if (!owner) {
      diagnostics.push({
        category: "ownership",
        severity: "error",
        ownerName: surface.ownerName,
        contractPath: surface.contractPath,
        message: bounded("resolved source surface has no matching extraction owner."),
      });
      continue;
    }

    const extraction = extractPublicTypeScriptSurface({
      repoRoot,
      sourcePaths: surface.sourcePaths,
    });
    diagnostics.push(
      ...extraction.diagnostics.map((diagnostic) =>
        withOwnerFields(diagnostic, owner.name, owner.contractPath),
      ),
    );
    if (extraction.diagnostics.some(isErrorDiagnostic)) continue;
    extractedExports += extraction.summaries.length;

    const currentContent = readContract(repoRoot, owner, diagnostics);
    if (currentContent === undefined) continue;

    const block = renderGeneratedContractBlock({
      ownerName: owner.name,
      contractPath: owner.contractPath,
      exports: extraction.summaries,
      allowEmptySurface: owner.allowEmptySurface,
    });

    const markerValidation = validateAutogenMarkerRegion({
      contractPath: owner.contractPath,
      content: currentContent,
    });
    diagnostics.push(
      ...markerValidation.diagnostics.map((diagnostic) =>
        withOwnerFields(diagnostic, owner.name, owner.contractPath),
      ),
    );
    if (!markerValidation.region) continue;

    const existingGenerated = contentBetweenMarkerLines(
      currentContent,
      markerValidation.region.beginMarkerLine,
      markerValidation.region.endMarkerLine,
    );
    const stale = existingGenerated !== normalizeGeneratedContent(block.content);
    if (input.mode === "check" && stale) {
      diagnostics.push({
        category: "stale-output",
        severity: "error",
        ownerName: owner.name,
        contractPath: owner.contractPath,
        message: bounded("contract AUTOGEN region is stale; run write mode to refresh it."),
      });
    }

    prepared.push({
      owner,
      surface,
      block,
      currentContent,
      stale,
    });
  }

  const staleContracts = prepared
    .filter((contract) => contract.stale)
    .map((contract) => contract.owner.contractPath)
    .sort(compareStrings);

  if (diagnostics.some(isErrorDiagnostic)) {
    return commandResult(
      input.mode,
      surfaces.surfaces.length,
      extractedExports,
      staleContracts,
      [],
      diagnostics,
    );
  }

  if (input.mode === "check") {
    return commandResult(
      input.mode,
      surfaces.surfaces.length,
      extractedExports,
      staleContracts,
      [],
      diagnostics,
    );
  }

  const replacement = replaceContractAutogenRegions({
    contracts: prepared.map((contract) => ({
      contractPath: contract.owner.contractPath,
      content: contract.currentContent,
      generatedContent: contract.block.content,
    })),
  });
  diagnostics.push(
    ...replacement.diagnostics.map((diagnostic) => {
      const owner = prepared.find(
        (contract) => contract.owner.contractPath === diagnostic.contractPath,
      )?.owner;
      return owner ? withOwnerFields(diagnostic, owner.name, owner.contractPath) : diagnostic;
    }),
  );
  if (replacement.diagnostics.some(isErrorDiagnostic)) {
    return commandResult(
      input.mode,
      surfaces.surfaces.length,
      extractedExports,
      staleContracts,
      [],
      diagnostics,
    );
  }

  const writes: Array<{
    readonly contractPath: string;
    readonly absolutePath: string;
    readonly content: string;
  }> = [];
  for (const replacementResult of replacement.replacements.filter(
    (candidate) => !candidate.unchanged,
  )) {
    const absolutePath = resolveRepoPath(repoRoot, replacementResult.contractPath);
    if (!absolutePath) {
      diagnostics.push({
        category: "write-safety",
        severity: "error",
        contractPath: replacementResult.contractPath,
        message: bounded("contract path must be repo-relative and stay inside the repository."),
      });
      continue;
    }
    writes.push({
      contractPath: replacementResult.contractPath,
      absolutePath,
      content: replacementResult.content,
    });
  }

  if (diagnostics.some(isErrorDiagnostic)) {
    return commandResult(
      input.mode,
      surfaces.surfaces.length,
      extractedExports,
      staleContracts,
      [],
      diagnostics,
    );
  }

  const updatedContracts: string[] = [];
  for (const write of writes) {
    fs.writeFileSync(write.absolutePath, write.content);
    updatedContracts.push(write.contractPath);
  }

  return commandResult(
    input.mode,
    surfaces.surfaces.length,
    extractedExports,
    staleContracts,
    updatedContracts.sort(compareStrings),
    diagnostics,
  );
}

export function parseAutogenCommandArgs(argv: readonly string[]): ParsedArgs {
  let check = false;
  let write = false;
  let repoRoot = process.cwd();
  let configPath: string | undefined;
  const diagnostics: AutogenDiagnostic[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--write") {
      write = true;
      continue;
    }
    if (arg === "--repo-root") {
      const next = argv[index + 1];
      if (!next) {
        diagnostics.push(commandDiagnostic("--repo-root requires a path."));
      } else {
        repoRoot = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--config") {
      const next = argv[index + 1];
      if (!next) {
        diagnostics.push(commandDiagnostic("--config requires a repo-relative path."));
      } else {
        configPath = next;
        index += 1;
      }
      continue;
    }
    diagnostics.push(commandDiagnostic(`unsupported argument: ${arg}.`));
  }

  if (check === write) {
    diagnostics.push(
      commandDiagnostic("exactly one mode flag is required: --check or --write."),
    );
  }

  return {
    mode: check !== write ? (check ? "check" : "write") : undefined,
    repoRoot,
    configPath,
    diagnostics,
  };
}

export function formatAutogenCommandResult(result: AutogenCommandResult): string {
  const lines = [
    "Autogen Command Result",
    `mode=${result.mode} status=${result.status}`,
    [
      `checkedContracts=${result.checkedContracts}`,
      `extractedExports=${result.extractedExports}`,
      `staleContracts=${result.staleContracts.length}`,
      `updatedContracts=${result.updatedContracts.length}`,
      `diagnostics=${result.diagnostics.length}`,
    ].join(" "),
  ];

  lines.push(...formatPathList("staleContracts", result.staleContracts));
  lines.push(...formatPathList("updatedContracts", result.updatedContracts));
  lines.push(...formatDiagnostics(result.diagnostics));
  return `${lines.join("\n")}\n`;
}

export function formatArgumentDiagnostics(
  diagnostics: readonly AutogenDiagnostic[],
): string {
  return [
    "Autogen Command Result",
    "mode=unknown status=fail",
    `checkedContracts=0 extractedExports=0 staleContracts=0 updatedContracts=0 diagnostics=${diagnostics.length}`,
    ...formatPathList("staleContracts", []),
    ...formatPathList("updatedContracts", []),
    ...formatDiagnostics(diagnostics),
  ].join("\n") + "\n";
}

function commandResult(
  mode: AutogenCommandMode,
  checkedContracts: number,
  extractedExports: number,
  staleContracts: readonly string[],
  updatedContracts: readonly string[],
  diagnostics: readonly AutogenDiagnostic[],
): AutogenCommandResult {
  const sortedDiagnostics = [...diagnostics].sort(compareDiagnostics);
  return {
    mode,
    status: sortedDiagnostics.some(isErrorDiagnostic) ? "fail" : "pass",
    checkedContracts,
    extractedExports,
    staleContracts: [...new Set(staleContracts)].sort(compareStrings),
    updatedContracts: [...new Set(updatedContracts)].sort(compareStrings),
    diagnostics: sortedDiagnostics,
  };
}

function readContract(
  repoRoot: string,
  owner: ExtractionOwner,
  diagnostics: AutogenDiagnostic[],
): string | undefined {
  const absolutePath = resolveRepoPath(repoRoot, owner.contractPath);
  if (!absolutePath) {
    diagnostics.push({
      category: "config",
      severity: "error",
      ownerName: owner.name,
      contractPath: owner.contractPath,
      message: bounded("contract path must be repo-relative and stay inside the repository."),
    });
    return undefined;
  }

  try {
    return fs.readFileSync(absolutePath, "utf8");
  } catch (error) {
    diagnostics.push({
      category: "config",
      severity: "error",
      ownerName: owner.name,
      contractPath: owner.contractPath,
      message: bounded(readFailureMessage(error, "contract file cannot be read.")),
    });
    return undefined;
  }
}

function readFailureMessage(error: unknown, fallback: string): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return `${fallback} ${error.code}.`;
  }
  return fallback;
}

function contentBetweenMarkerLines(
  content: string,
  beginMarkerLine: number,
  endMarkerLine: number,
): string {
  const lines = splitLines(content);
  const begin = lines[beginMarkerLine - 1];
  const end = lines[endMarkerLine - 1];
  if (!begin || !end) return "";
  return content.slice(begin.end, end.start);
}

function splitLines(content: string): Array<{
  readonly start: number;
  readonly end: number;
}> {
  const lines: Array<{ readonly start: number; readonly end: number }> = [];
  const pattern = /.*(?:\r\n|\n|\r|$)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const raw = match[0];
    if (raw === "") break;
    lines.push({
      start: match.index,
      end: match.index + raw.length,
    });
  }

  return lines;
}

function normalizeGeneratedContent(content: string): string {
  if (content === "") return "";
  return content.endsWith("\n") || content.endsWith("\r") ? content : `${content}\n`;
}

function withOwnerFields(
  diagnostic: AutogenDiagnostic,
  ownerName: string,
  contractPath: string,
): AutogenDiagnostic {
  return {
    ...diagnostic,
    ownerName: diagnostic.ownerName ?? ownerName,
    contractPath: diagnostic.contractPath ?? contractPath,
    message: bounded(diagnostic.message),
  };
}

function commandDiagnostic(message: string): AutogenDiagnostic {
  return {
    category: "config",
    severity: "error",
    message: bounded(message),
  };
}

function resolveRepoPath(repoRoot: string, repoRelativePath: string): string | undefined {
  if (path.isAbsolute(repoRelativePath)) return undefined;
  const resolved = path.resolve(repoRoot, repoRelativePath);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return resolved;
}

function formatPathList(label: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return [`${label}: none`];
  return [`${label}:`, ...[...paths].sort(compareStrings).map((pathValue) => `- ${pathValue}`)];
}

function formatDiagnostics(diagnostics: readonly AutogenDiagnostic[]): string[] {
  if (diagnostics.length === 0) return ["diagnostics: none"];

  const lines = ["diagnostics:"];
  for (const diagnostic of [...diagnostics].sort(compareDiagnostics).slice(0, MAX_FORMATTED_DIAGNOSTICS)) {
    lines.push(`- ${formatDiagnostic(diagnostic)}`);
  }

  const omitted = diagnostics.length - MAX_FORMATTED_DIAGNOSTICS;
  if (omitted > 0) {
    lines.push(`- category=config severity=warning message=${omitted} additional diagnostics omitted`);
  }
  return lines;
}

function formatDiagnostic(diagnostic: AutogenDiagnostic): string {
  return [
    `category=${diagnostic.category}`,
    `severity=${diagnostic.severity}`,
    diagnostic.ownerName ? `ownerName=${diagnostic.ownerName}` : undefined,
    diagnostic.contractPath ? `contractPath=${diagnostic.contractPath}` : undefined,
    diagnostic.sourcePath ? `sourcePath=${diagnostic.sourcePath}` : undefined,
    `message=${bounded(diagnostic.message)}`,
  ].filter((part): part is string => part !== undefined).join(" ");
}

function isErrorDiagnostic(diagnostic: AutogenDiagnostic): boolean {
  return diagnostic.severity === "error";
}

function bounded(message: string): string {
  return message.length > MAX_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_MESSAGE_LENGTH - 3)}...`
    : message;
}

function compareDiagnostics(a: AutogenDiagnostic, b: AutogenDiagnostic): number {
  return (
    compareStrings(a.ownerName ?? "", b.ownerName ?? "") ||
    compareStrings(a.contractPath ?? "", b.contractPath ?? "") ||
    compareStrings(a.sourcePath ?? "", b.sourcePath ?? "") ||
    compareStrings(a.category, b.category) ||
    compareStrings(a.severity, b.severity) ||
    compareStrings(a.message, b.message)
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
