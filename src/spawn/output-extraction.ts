import crypto from "node:crypto";
import path from "node:path";

const MAX_DIAGNOSTIC_LENGTH = 240;
const SUPPORTED_BACKENDS = new Set(["claude-code", "codex"]);

export type SpawnOutputBackend = "claude-code" | "codex";

export type SpawnOutputValidationFailureCategory =
  | "malformed-output"
  | "no-patch"
  | "ambiguous-patch"
  | "unsafe-patch-path"
  | "unsupported-patch-form"
  | "empty-patch";

export interface CandidatePatch {
  readonly patchText: string;
  readonly summary?: string;
}

export interface ValidatedSpawnPatch {
  readonly patchText: string;
  readonly touchedPaths: readonly string[];
  readonly sha256: string;
}

export interface SpawnOutputValidationFailure {
  readonly status: "failed";
  readonly category: SpawnOutputValidationFailureCategory;
  readonly diagnostic: string;
}

export interface SpawnOutputValidationSuccess {
  readonly status: "accepted";
  readonly patch: ValidatedSpawnPatch;
}

export type SpawnOutputValidationResult =
  | SpawnOutputValidationSuccess
  | SpawnOutputValidationFailure;

export interface ValidateSpawnOutputInput {
  readonly backend: string;
  readonly rawJson: string;
  readonly worktreePath: string;
}

export interface ValidateSpawnPatchInput {
  readonly patchText: string;
  readonly worktreePath: string;
}

export function validateSpawnOutput(
  input: ValidateSpawnOutputInput,
): SpawnOutputValidationResult {
  const candidate = parseBackendEnvelope(input.backend, input.rawJson);
  if (candidate.status === "failed") return candidate;

  return validateSpawnPatch({
    patchText: candidate.patchText,
    worktreePath: input.worktreePath,
  });
}

export function parseBackendEnvelope(
  backend: string,
  rawJson: string,
): (CandidatePatch & { readonly status: "candidate" }) | SpawnOutputValidationFailure {
  if (!SUPPORTED_BACKENDS.has(backend)) {
    return failure("malformed-output", `Unsupported backend "${backend}".`);
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(rawJson);
  } catch {
    return failure("malformed-output", `Backend ${backend} output was not valid JSON.`);
  }

  const candidates = collectPatchCandidates(envelope);
  if (candidates.length === 0) {
    return failure("no-patch", `Backend ${backend} output contained no git patch payload.`);
  }

  const unique = [...new Set(candidates)];
  if (unique.length > 1) {
    return failure(
      "ambiguous-patch",
      `Backend ${backend} output contained multiple candidate patch payloads.`,
    );
  }

  return { status: "candidate", patchText: unique[0], summary: collectSummary(envelope) };
}

export function validateSpawnPatch(
  input: ValidateSpawnPatchInput,
): SpawnOutputValidationResult {
  const patchText = normalizeTrailingNewline(input.patchText);
  if (patchText.trim().length === 0) {
    return failure("empty-patch", "Patch payload was empty.");
  }

  const fileSections = splitGitPatchSections(patchText);
  if (fileSections.length === 0) {
    return failure("empty-patch", "Patch payload contained no git file changes.");
  }

  const touchedPaths = new Set<string>();
  const worktreeRoot = path.resolve(input.worktreePath);

  for (const section of fileSections) {
    const parsed = parsePatchSection(section);
    if (parsed.status === "failed") return parsed;

    if (parsed.changedPathCount === 0) {
      return failure("empty-patch", "Patch payload contained a no-op file section.");
    }

    for (const targetPath of parsed.touchedPaths) {
      const normalized = normalizePatchPath(targetPath, worktreeRoot);
      if (normalized.status === "failed") return normalized;
      touchedPaths.add(normalized.path);
    }
  }

  if (touchedPaths.size === 0) {
    return failure("empty-patch", "Patch payload contained no touched paths.");
  }

  return {
    status: "accepted",
    patch: {
      patchText,
      touchedPaths: [...touchedPaths].sort(),
      sha256: crypto.createHash("sha256").update(patchText).digest("hex"),
    },
  };
}

function collectPatchCandidates(value: unknown): string[] {
  const found: string[] = [];
  const visit = (current: unknown, key?: string): void => {
    if (typeof current === "string") {
      if (isPatchField(key) && current.includes("diff --git ")) {
        found.push(current);
      }
      return;
    }

    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }

    if (current && typeof current === "object") {
      for (const [childKey, childValue] of Object.entries(current)) {
        visit(childValue, childKey);
      }
    }
  };

  visit(value);
  return found;
}

function isPatchField(key: string | undefined): boolean {
  if (!key) return false;
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return ["patch", "patchtext", "gitpatch", "diff", "gitdiff", "unifieddiff"].includes(
    normalized,
  );
}

function collectSummary(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const summary = (value as Record<string, unknown>).summary;
  return typeof summary === "string" ? boundDiagnostic(summary) : undefined;
}

function splitGitPatchSections(patchText: string): string[] {
  const lines = patchText.split("\n");
  const sections: string[] = [];
  let current: string[] | undefined;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) sections.push(current.join("\n"));
      current = [line];
      continue;
    }

    if (current) current.push(line);
  }

  if (current) sections.push(current.join("\n"));
  return sections;
}

interface ParsedPatchSection {
  readonly touchedPaths: readonly string[];
  readonly changedPathCount: number;
}

function parsePatchSection(
  section: string,
): (ParsedPatchSection & { readonly status: "parsed" }) | SpawnOutputValidationFailure {
  const lines = section.split("\n");
  const header = lines[0];
  const headerMatch = header.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (!headerMatch) {
    return failure("unsupported-patch-form", "Patch section used an unsupported diff header.");
  }

  if (section.includes("\nGIT binary patch") || section.includes("\nBinary files ")) {
    return failure("unsupported-patch-form", "Binary patch payloads are not supported.");
  }

  const oldPath = headerMatch[1];
  const newPath = headerMatch[2];
  const touchedPaths = new Set([oldPath, newPath]);
  let changedPathCount = 0;

  for (const line of lines) {
    if (line.startsWith("rename from ")) {
      touchedPaths.add(line.slice("rename from ".length));
      changedPathCount++;
    } else if (line.startsWith("rename to ")) {
      touchedPaths.add(line.slice("rename to ".length));
      changedPathCount++;
    } else if (line.startsWith("copy from ") || line.startsWith("copy to ")) {
      return failure("unsupported-patch-form", "Copy patch payloads are not supported.");
    } else if (
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ") ||
      line.startsWith("old mode ") ||
      line.startsWith("new mode ") ||
      line.startsWith("@@ ")
    ) {
      changedPathCount++;
    }
  }

  return { status: "parsed", touchedPaths: [...touchedPaths], changedPathCount };
}

function normalizePatchPath(
  patchPath: string,
  worktreeRoot: string,
): { readonly status: "path"; readonly path: string } | SpawnOutputValidationFailure {
  if (patchPath.length === 0 || patchPath === "/dev/null") {
    return failure("unsupported-patch-form", "Patch target path was not a repository path.");
  }

  if (path.isAbsolute(patchPath)) {
    return failure("unsafe-patch-path", `Patch target "${patchPath}" was absolute.`);
  }

  const segments = patchPath.split("/");
  if (segments.includes("..")) {
    return failure("unsafe-patch-path", `Patch target "${patchPath}" contained traversal.`);
  }

  const resolved = path.resolve(worktreeRoot, patchPath);
  const relative = path.relative(worktreeRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return failure("unsafe-patch-path", `Patch target "${patchPath}" escaped the worktree.`);
  }

  return { status: "path", path: relative.split(path.sep).join("/") };
}

function failure(
  category: SpawnOutputValidationFailureCategory,
  diagnostic: string,
): SpawnOutputValidationFailure {
  return { status: "failed", category, diagnostic: boundDiagnostic(diagnostic) };
}

function boundDiagnostic(diagnostic: string): string {
  if (diagnostic.length <= MAX_DIAGNOSTIC_LENGTH) return diagnostic;
  return `${diagnostic.slice(0, MAX_DIAGNOSTIC_LENGTH - 3)}...`;
}

function normalizeTrailingNewline(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x0a) end--;
  return text.slice(0, end) + "\n";
}
