import fs from "node:fs";
import path from "node:path";
import type { AutogenDiagnostic } from "./public-surface.js";

export const DEFAULT_EXTRACTION_OWNERSHIP_CONFIG_PATH =
  "docs/subsystems/contract-freshness.config.json";

export const REQUIRED_M2_EXTRACTION_OWNER_NAMES = [
  "hatchery",
  "brood",
  "herald",
  "castra",
  "spawn",
  "legate",
  "steward",
] as const;

export interface ExtractionOwner {
  readonly name: string;
  readonly contractPath: string;
  readonly publicSourcePaths: readonly string[];
  readonly notes?: string;
  readonly allowEmptySurface: boolean;
}

export interface ExtractionConfigView {
  readonly version: 1;
  readonly source: string;
  readonly owners: readonly ExtractionOwner[];
}

export interface SourceSurface {
  readonly ownerName: string;
  readonly contractPath: string;
  readonly sourcePaths: readonly string[];
  readonly empty: boolean;
}

export interface LoadExtractionOwnershipConfigInput {
  readonly repoRoot: string;
  readonly configPath?: string;
  readonly requiredOwnerNames?: readonly string[];
}

export interface LoadExtractionOwnershipConfigResult {
  readonly config?: ExtractionConfigView;
  readonly diagnostics: readonly AutogenDiagnostic[];
}

export interface ResolveSourceSurfacesInput {
  readonly repoRoot: string;
  readonly config: ExtractionConfigView;
}

export interface ResolveSourceSurfacesResult {
  readonly surfaces: readonly SourceSurface[];
  readonly diagnostics: readonly AutogenDiagnostic[];
}

const MAX_MESSAGE_LENGTH = 300;
const GENERATED_OR_DEPENDENCY_SEGMENTS = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);
const STEWARD_ROLE_CONSUMER_PREFIXES = ["src/castra/", "src/hatchery/"];

export function loadExtractionOwnershipConfig(
  input: LoadExtractionOwnershipConfigInput,
): LoadExtractionOwnershipConfigResult {
  const repoRoot = path.resolve(input.repoRoot);
  const configPath =
    input.configPath ?? DEFAULT_EXTRACTION_OWNERSHIP_CONFIG_PATH;
  const requiredOwnerNames =
    input.requiredOwnerNames ?? REQUIRED_M2_EXTRACTION_OWNER_NAMES;
  const diagnostics: AutogenDiagnostic[] = [];

  const resolvedConfigPath = resolveRepoPath(repoRoot, configPath);
  if (!resolvedConfigPath) {
    return {
      diagnostics: [
        configDiagnostic(
          configPath,
          "ownership config path must be repo-relative and stay inside the repository.",
        ),
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedConfigPath, "utf8"));
  } catch (error) {
    return {
      diagnostics: [
        configDiagnostic(
          configPath,
          `ownership config cannot be read as JSON: ${boundedMessage(error)}`,
        ),
      ],
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      diagnostics: [
        configDiagnostic(configPath, "ownership config must be a JSON object."),
      ],
    };
  }

  const rawConfig = parsed as Record<string, unknown>;
  if (rawConfig.version !== 1) {
    diagnostics.push(
      configDiagnostic(configPath, "ownership config version must be 1."),
    );
  }

  if (!Array.isArray(rawConfig.contracts)) {
    diagnostics.push(
      configDiagnostic(configPath, "ownership config contracts must be an array."),
    );
    return { diagnostics };
  }

  const requiredNames = new Set(requiredOwnerNames);
  const owners: ExtractionOwner[] = [];
  const entriesByName = new Map<string, number>();
  const entriesByContractPath = new Map<string, string[]>();
  const ownedSelectors: OwnedSelector[] = [];

  for (const [index, entry] of rawConfig.contracts.entries()) {
    const owner = normalizeOwnerEntry(entry, index, configPath, diagnostics);
    if (!owner) continue;
    if (!requiredNames.has(owner.name)) continue;

    entriesByName.set(owner.name, (entriesByName.get(owner.name) ?? 0) + 1);
    owners.push(owner);

    const contractPathOwners = entriesByContractPath.get(owner.contractPath) ?? [];
    contractPathOwners.push(owner.name);
    entriesByContractPath.set(owner.contractPath, contractPathOwners);

    for (const selector of owner.publicSourcePaths) {
      ownedSelectors.push({
        ownerName: owner.name,
        contractPath: owner.contractPath,
        selector,
        ...selectorOwnershipBase(selector),
      });
    }
  }

  for (const ownerName of requiredOwnerNames) {
    const count = entriesByName.get(ownerName) ?? 0;
    if (count === 0) {
      diagnostics.push(
        configDiagnostic(
          configPath,
          `required extraction owner is missing: ${ownerName}.`,
          { ownerName },
        ),
      );
    } else if (count > 1) {
      diagnostics.push(
        configDiagnostic(
          configPath,
          `required extraction owner is duplicated: ${ownerName}.`,
          { ownerName },
        ),
      );
    }
  }

  for (const [contractPath, ownerNames] of entriesByContractPath.entries()) {
    const uniqueOwnerNames = [...new Set(ownerNames)].sort(compareStrings);
    // Same-owner duplication is already reported as a duplicated-owner
    // diagnostic; only flag a shared contractPath across *distinct* owners.
    if (uniqueOwnerNames.length > 1) {
      diagnostics.push({
        category: "ownership",
        severity: "error",
        contractPath,
        ownerName: uniqueOwnerNames.join(","),
        message: bounded(
          `duplicate extraction contractPath owned by ${uniqueOwnerNames.join(",")}.`,
        ),
      });
    }
  }

  diagnostics.push(...selectorOverlapDiagnostics(ownedSelectors));

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { diagnostics };
  }

  return {
    config: {
      version: 1,
      source: normalizeRepoPath(configPath),
      owners: owners.sort(compareOwners),
    },
    diagnostics,
  };
}

export function resolveExtractionSourceSurfaces(
  input: ResolveSourceSurfacesInput,
): ResolveSourceSurfacesResult {
  const repoRoot = path.resolve(input.repoRoot);
  const diagnostics: AutogenDiagnostic[] = [];
  const surfaces: SourceSurface[] = [];

  for (const owner of [...input.config.owners].sort(compareOwners)) {
    const sourcePaths = new Set<string>();

    for (const selector of owner.publicSourcePaths) {
      const resolved = resolveSelector(repoRoot, selector);
      if (!resolved.valid) {
        diagnostics.push({
          category: "ownership",
          severity: "error",
          ownerName: owner.name,
          contractPath: owner.contractPath,
          sourcePath: selector,
          message: "source selector must stay inside the repository.",
        });
        continue;
      }

      for (const sourcePath of resolved.sourcePaths) {
        sourcePaths.add(sourcePath);
      }
    }

    if (sourcePaths.size === 0 && !owner.allowEmptySurface) {
      diagnostics.push({
        category: "ownership",
        severity: "error",
        ownerName: owner.name,
        contractPath: owner.contractPath,
        message: "extraction owner resolved no TypeScript source files.",
      });
      continue;
    }

    surfaces.push({
      ownerName: owner.name,
      contractPath: owner.contractPath,
      sourcePaths: [...sourcePaths].sort(compareStrings),
      empty: sourcePaths.size === 0,
    });
  }

  diagnostics.push(...resolvedSourceOverlapDiagnostics(surfaces));

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { surfaces: [], diagnostics };
  }

  return {
    surfaces: surfaces.sort(compareSurfaces),
    diagnostics,
  };
}

function normalizeOwnerEntry(
  entry: unknown,
  index: number,
  configPath: string,
  diagnostics: AutogenDiagnostic[],
): ExtractionOwner | undefined {
  const fallbackOwnerName = `contracts[${index}]`;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    diagnostics.push(
      configDiagnostic(configPath, "ownership config entry must be an object.", {
        ownerName: fallbackOwnerName,
      }),
    );
    return undefined;
  }

  const rawEntry = entry as Record<string, unknown>;
  const ownerName =
    typeof rawEntry.name === "string" && rawEntry.name.trim() !== ""
      ? rawEntry.name.trim()
      : fallbackOwnerName;

  if (typeof rawEntry.name !== "string" || rawEntry.name.trim() === "") {
    diagnostics.push(
      configDiagnostic(configPath, "ownership config entry name must be a non-empty string.", {
        ownerName,
      }),
    );
  }

  if (
    typeof rawEntry.contractPath !== "string" ||
    rawEntry.contractPath.trim() === "" ||
    !isRepoRelativePath(rawEntry.contractPath.trim())
  ) {
    diagnostics.push(
      configDiagnostic(
        configPath,
        "ownership config contractPath must be a repo-relative string.",
        { ownerName },
      ),
    );
  }

  if (!Array.isArray(rawEntry.publicSourcePaths)) {
    diagnostics.push(
      configDiagnostic(
        configPath,
        "ownership config publicSourcePaths must be an array.",
        { ownerName, contractPath: stringValue(rawEntry.contractPath) ?? configPath },
      ),
    );
    return undefined;
  }

  const selectors: string[] = [];
  for (const selector of rawEntry.publicSourcePaths) {
    if (typeof selector !== "string") {
      diagnostics.push(
        configDiagnostic(configPath, "ownership config selector must be a string.", {
          ownerName,
          contractPath: stringValue(rawEntry.contractPath) ?? configPath,
        }),
      );
      continue;
    }

    const normalizedSelector = normalizeRepoPath(selector);
    if (!isRepoRelativePath(normalizedSelector)) {
      diagnostics.push(
        configDiagnostic(configPath, "ownership config selector must be repo-relative.", {
          ownerName,
          contractPath: stringValue(rawEntry.contractPath) ?? configPath,
          sourcePath: selector,
        }),
      );
      continue;
    }

    if (generatedOrDependencyPath(normalizedSelector)) {
      diagnostics.push(
        configDiagnostic(
          configPath,
          "ownership config selector cannot target generated or dependency directories.",
          {
            ownerName,
            contractPath: stringValue(rawEntry.contractPath) ?? configPath,
            sourcePath: normalizedSelector,
          },
        ),
      );
      continue;
    }

    if (
      ownerName === "steward" &&
      (normalizedSelector === "src/steward" ||
        normalizedSelector.startsWith("src/steward/") ||
        !STEWARD_ROLE_CONSUMER_PREFIXES.some((prefix) =>
          normalizedSelector.startsWith(prefix),
        ))
    ) {
      diagnostics.push(
        configDiagnostic(
          configPath,
          "steward extraction selectors must use Castra/Hatchery role-consumer surfaces.",
          {
            ownerName,
            contractPath: stringValue(rawEntry.contractPath) ?? configPath,
            sourcePath: normalizedSelector,
          },
        ),
      );
      continue;
    }

    selectors.push(normalizedSelector);
  }

  if (selectors.length === 0 && rawEntry.allowEmptySurface !== true) {
    diagnostics.push(
      configDiagnostic(
        configPath,
        "ownership config publicSourcePaths must include at least one valid selector unless allowEmptySurface is true.",
        {
          ownerName,
          contractPath: stringValue(rawEntry.contractPath) ?? configPath,
        },
      ),
    );
  }

  if (
    typeof rawEntry.contractPath !== "string" ||
    rawEntry.contractPath.trim() === "" ||
    !isRepoRelativePath(rawEntry.contractPath.trim())
  ) {
    return undefined;
  }

  if (rawEntry.allowEmptySurface !== undefined && typeof rawEntry.allowEmptySurface !== "boolean") {
    diagnostics.push(
      configDiagnostic(configPath, "ownership config allowEmptySurface must be a boolean.", {
        ownerName,
        contractPath: rawEntry.contractPath.trim(),
      }),
    );
  }

  return {
    name: ownerName,
    contractPath: normalizeRepoPath(rawEntry.contractPath),
    publicSourcePaths: selectors.sort(compareStrings),
    notes: stringValue(rawEntry.notes),
    allowEmptySurface: rawEntry.allowEmptySurface === true,
  };
}

interface OwnedSelector {
  readonly ownerName: string;
  readonly contractPath: string;
  readonly selector: string;
  readonly kind: "file" | "directory";
  readonly base: string;
  // For directory selectors: true when the selector matches the full subtree
  // (`/**` or trailing `/`), false for shallow direct-children selectors (`/*`).
  readonly recursive: boolean;
}

function selectorOverlapDiagnostics(
  ownedSelectors: readonly OwnedSelector[],
): AutogenDiagnostic[] {
  const diagnostics: AutogenDiagnostic[] = [];

  for (let leftIndex = 0; leftIndex < ownedSelectors.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < ownedSelectors.length;
      rightIndex += 1
    ) {
      const left = ownedSelectors[leftIndex];
      const right = ownedSelectors[rightIndex];
      if (left.ownerName === right.ownerName) continue;
      if (!selectorsOverlap(left, right)) continue;

      diagnostics.push({
        category: "ownership",
        severity: "error",
        ownerName: [left.ownerName, right.ownerName].sort(compareStrings).join(","),
        contractPath: [left.contractPath, right.contractPath].sort(compareStrings).join(","),
        sourcePath:
          left.selector === right.selector
            ? left.selector
            : [left.selector, right.selector].sort(compareStrings).join(" <-> "),
        message: bounded(
          `overlapping extraction selector owned by ${[left.ownerName, right.ownerName]
            .sort(compareStrings)
            .join(",")}.`,
        ),
      });
    }
  }

  return diagnostics;
}

function resolvedSourceOverlapDiagnostics(
  surfaces: readonly SourceSurface[],
): AutogenDiagnostic[] {
  const bySourcePath = new Map<string, SourceSurface[]>();
  for (const surface of surfaces) {
    for (const sourcePath of surface.sourcePaths) {
      const owners = bySourcePath.get(sourcePath) ?? [];
      owners.push(surface);
      bySourcePath.set(sourcePath, owners);
    }
  }

  const diagnostics: AutogenDiagnostic[] = [];
  for (const [sourcePath, owners] of bySourcePath.entries()) {
    const uniqueOwnerNames = [...new Set(owners.map((owner) => owner.ownerName))].sort(compareStrings);
    if (uniqueOwnerNames.length < 2) continue;
    diagnostics.push({
      category: "ownership",
      severity: "error",
      ownerName: uniqueOwnerNames.join(","),
      contractPath: owners
        .map((owner) => owner.contractPath)
        .sort(compareStrings)
        .join(","),
      sourcePath,
      message: bounded(
        `overlapping extraction source owned by ${uniqueOwnerNames.join(",")}.`,
      ),
    });
  }
  return diagnostics;
}

function resolveSelector(repoRoot: string, selector: string): {
  readonly valid: boolean;
  readonly sourcePaths: readonly string[];
} {
  const ownershipBase = selectorOwnershipBase(selector);
  const absoluteBase = path.resolve(repoRoot, ownershipBase.base);
  if (!isInsideRoot(repoRoot, absoluteBase)) return { valid: false, sourcePaths: [] };

  const stat = statIfExists(absoluteBase);
  if (!stat) return { valid: true, sourcePaths: [] };

  // Reject a selector root that resolves outside the repository (e.g. a
  // symlinked directory) before walking it, rather than walking an external
  // tree and filtering per-file afterwards.
  if (!realPathStaysInsideRoot(repoRoot, absoluteBase)) {
    return { valid: false, sourcePaths: [] };
  }

  const paths =
    ownershipBase.kind === "directory"
      ? collectFiles(absoluteBase, selector.endsWith("/*") ? "shallow" : "recursive")
      : stat.isFile()
        ? [absoluteBase]
        : [];

  const sourcePaths: string[] = [];
  for (const absolutePath of paths) {
    const repoRelativePath = normalizeRepoPath(path.relative(repoRoot, absolutePath));
    if (
      isRepoRelativePath(repoRelativePath) &&
      isTypeScriptSourcePath(repoRelativePath) &&
      !generatedOrDependencyPath(repoRelativePath) &&
      realPathStaysInsideRoot(repoRoot, absolutePath)
    ) {
      sourcePaths.push(repoRelativePath);
    }
  }

  return {
    valid: true,
    sourcePaths: [...new Set(sourcePaths)].sort(compareStrings),
  };
}

function collectFiles(directory: string, mode: "recursive" | "shallow"): string[] {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (GENERATED_OR_DEPENDENCY_SEGMENTS.has(entry.name)) continue;
      if (mode === "recursive") files.push(...collectFiles(absolutePath, mode));
      continue;
    }
    if (entry.isFile() || entry.isSymbolicLink()) files.push(absolutePath);
  }

  return files;
}

function selectorOwnershipBase(selector: string): {
  readonly kind: "file" | "directory";
  readonly base: string;
  readonly recursive: boolean;
} {
  if (selector.endsWith("/**")) {
    return { kind: "directory", base: selector.slice(0, -3), recursive: true };
  }

  if (selector.endsWith("/*")) {
    return { kind: "directory", base: selector.slice(0, -2), recursive: false };
  }

  if (selector.endsWith("/")) {
    return { kind: "directory", base: selector.slice(0, -1), recursive: true };
  }

  return { kind: "file", base: selector, recursive: false };
}

function selectorsOverlap(left: OwnedSelector, right: OwnedSelector): boolean {
  if (left.selector === right.selector) return true;

  if (left.kind === "file" && right.kind === "file") {
    return left.base === right.base;
  }

  if (left.kind === "file") return directoryCoversFile(right, left.base);
  if (right.kind === "file") return directoryCoversFile(left, right.base);

  return directoriesOverlap(left, right);
}

// Does a directory selector match the given repo-relative file path? Shallow
// (`/*`) selectors only match direct children; recursive (`/**`) selectors
// match the full subtree.
function directoryCoversFile(directory: OwnedSelector, filePath: string): boolean {
  const prefix = `${directory.base}/`;
  if (!filePath.startsWith(prefix)) return false;
  if (directory.recursive) return true;
  return !filePath.slice(prefix.length).includes("/");
}

function directoriesOverlap(a: OwnedSelector, b: OwnedSelector): boolean {
  if (a.base === b.base) return true;
  // When one directory is nested under the other, the ancestor only reaches
  // into the descendant's subtree if it is recursive; a shallow ancestor
  // covers only its own direct children.
  if (b.base.startsWith(`${a.base}/`)) return a.recursive;
  if (a.base.startsWith(`${b.base}/`)) return b.recursive;
  return false;
}

function isRepoRelativePath(repoRelativePath: string): boolean {
  if (repoRelativePath === "" || path.isAbsolute(repoRelativePath)) return false;
  if (repoRelativePath.includes("\\")) return false;
  const segments = repoRelativePath.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || segment === "")) {
    return false;
  }
  return true;
}

function generatedOrDependencyPath(repoRelativePath: string): boolean {
  return repoRelativePath
    .split("/")
    .some((segment) => GENERATED_OR_DEPENDENCY_SEGMENTS.has(segment));
}

function isTypeScriptSourcePath(repoRelativePath: string): boolean {
  return (
    (repoRelativePath.endsWith(".ts") ||
      repoRelativePath.endsWith(".mts") ||
      repoRelativePath.endsWith(".cts")) &&
    !repoRelativePath.endsWith(".d.ts") &&
    !repoRelativePath.endsWith(".d.mts") &&
    !repoRelativePath.endsWith(".d.cts")
  );
}

function resolveRepoPath(repoRoot: string, repoRelativePath: string): string | undefined {
  if (!isRepoRelativePath(repoRelativePath)) return undefined;
  const resolved = path.resolve(repoRoot, repoRelativePath);
  if (!isInsideRoot(repoRoot, resolved)) return undefined;
  return resolved;
}

function realPathStaysInsideRoot(repoRoot: string, absolutePath: string): boolean {
  try {
    return isInsideRoot(fs.realpathSync(repoRoot), fs.realpathSync(absolutePath));
  } catch {
    return false;
  }
}

function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !(relative.startsWith("..") || path.isAbsolute(relative));
}

function statIfExists(absolutePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(absolutePath);
  } catch {
    return undefined;
  }
}

function configDiagnostic(
  configPath: string,
  message: string,
  fields: {
    readonly ownerName?: string;
    readonly contractPath?: string;
    readonly sourcePath?: string;
  } = {},
): AutogenDiagnostic {
  return {
    category: "config",
    severity: "error",
    contractPath: fields.contractPath ?? configPath,
    ownerName: fields.ownerName,
    sourcePath: fields.sourcePath,
    message: bounded(message),
  };
}

function boundedMessage(error: unknown): string {
  return bounded(error instanceof Error ? error.message : String(error));
}

function bounded(message: string): string {
  return message.length > MAX_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_MESSAGE_LENGTH - 3)}...`
    : message;
}

function normalizeRepoPath(repoRelativePath: string): string {
  return repoRelativePath.trim().replaceAll(path.sep, "/");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function compareOwners(a: ExtractionOwner, b: ExtractionOwner): number {
  return compareStrings(a.name, b.name) || compareStrings(a.contractPath, b.contractPath);
}

function compareSurfaces(a: SourceSurface, b: SourceSurface): number {
  return compareStrings(a.ownerName, b.ownerName) || compareStrings(a.contractPath, b.contractPath);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
