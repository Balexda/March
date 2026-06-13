import fs from "node:fs";
import path from "node:path";

export const QUARANTINE_DIR = "tests/quarantine";
export const QUARANTINE_ORIGINS_FILE = `${QUARANTINE_DIR}/.origins.json`;

export class QuarantineError extends Error {}

export interface ParkQuarantineResult {
  readonly originPath: string;
  readonly quarantinedPath: string;
}

type OriginManifest = Record<string, string>;

function toRepoRelativePath(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new QuarantineError("Provide a repo-relative *.test.ts path to park.");
  }
  if (path.isAbsolute(trimmed)) {
    throw new QuarantineError("Provide a repo-relative path, not an absolute path.");
  }

  const normalized = path.normalize(trimmed).replaceAll(path.sep, "/");
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new QuarantineError("Path must stay inside the repository.");
  }
  return normalized;
}

function manifestPath(repoRoot: string): string {
  return path.join(repoRoot, QUARANTINE_ORIGINS_FILE);
}

function readManifest(repoRoot: string): OriginManifest {
  const file = manifestPath(repoRoot);
  if (!fs.existsSync(file)) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    throw new QuarantineError(
      `Could not read ${QUARANTINE_ORIGINS_FILE}: ${(err as Error).message}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new QuarantineError(`${QUARANTINE_ORIGINS_FILE} must contain a JSON object.`);
  }

  const manifest: OriginManifest = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new QuarantineError(`${QUARANTINE_ORIGINS_FILE} has a non-string origin.`);
    }
    manifest[key] = value;
  }
  return manifest;
}

function writeManifest(repoRoot: string, manifest: OriginManifest): void {
  fs.mkdirSync(path.join(repoRoot, QUARANTINE_DIR), { recursive: true });
  fs.writeFileSync(
    manifestPath(repoRoot),
    JSON.stringify(
      Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b))),
      null,
      2,
    ) + "\n",
  );
}

export function parkQuarantinedTest(inputPath: string, options?: {
  readonly repoRoot?: string;
}): ParkQuarantineResult {
  const repoRoot = options?.repoRoot ?? process.cwd();
  const originPath = toRepoRelativePath(inputPath);

  if (!originPath.endsWith(".test.ts")) {
    throw new QuarantineError("Only *.test.ts files can be parked in quarantine.");
  }
  if (originPath === QUARANTINE_DIR || originPath.startsWith(`${QUARANTINE_DIR}/`)) {
    throw new QuarantineError(`${originPath} is already under ${QUARANTINE_DIR}.`);
  }

  const sourcePath = path.join(repoRoot, originPath);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new QuarantineError(`${originPath} does not exist or is not a file.`);
  }

  const quarantinedPath = `${QUARANTINE_DIR}/${originPath}`;
  const targetPath = path.join(repoRoot, quarantinedPath);
  if (fs.existsSync(targetPath)) {
    throw new QuarantineError(`${quarantinedPath} already exists.`);
  }

  const manifest = readManifest(repoRoot);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.renameSync(sourcePath, targetPath);

  manifest[quarantinedPath] = originPath;
  try {
    writeManifest(repoRoot, manifest);
  } catch (err) {
    // Roll back the move so a manifest-write failure does not leave the repo
    // in a partially-parked state (file relocated, origin unrecorded).
    try {
      fs.renameSync(targetPath, sourcePath);
    } catch {
      // best-effort rollback
    }
    throw new QuarantineError(
      `Could not record the parked origin in ${QUARANTINE_ORIGINS_FILE}: ${(err as Error).message}`,
    );
  }

  return { originPath, quarantinedPath };
}
