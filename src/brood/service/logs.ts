import fs from "node:fs";
import path from "node:path";
import { readSpawnContainerLogs } from "../../spawn/container-launch.js";
import { broodDir } from "./store.js";
import type { SessionLogResult, SessionRecord } from "./types.js";

export type LogUnavailableReason =
  | "no-source"
  | "live-source-failed"
  | "archive-read-failed";

export class BroodLogUnavailableError extends Error {
  readonly reason: LogUnavailableReason;

  constructor(message: string, reason: LogUnavailableReason) {
    super(message);
    this.name = "BroodLogUnavailableError";
    this.reason = reason;
  }
}

export interface LogReaderDeps {
  readonly readContainerLogs?: (containerId: string) => string;
  readonly archiveExists?: (archivePath: string) => boolean;
  readonly readArchive?: (archivePath: string) => string;
  readonly homeDir?: string;
}

interface ResolvedLogReaderDeps {
  readonly readContainerLogs: (containerId: string) => string;
  readonly archiveExists: (archivePath: string) => boolean;
  readonly readArchive: (archivePath: string) => string;
  readonly homeDir?: string;
}

function resolveDeps(deps: LogReaderDeps): ResolvedLogReaderDeps {
  return {
    readContainerLogs: deps.readContainerLogs ?? readSpawnContainerLogs,
    archiveExists: deps.archiveExists ?? fs.existsSync,
    readArchive:
      deps.readArchive ??
      ((archivePath) => fs.readFileSync(archivePath, "utf-8")),
    homeDir: deps.homeDir,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve `<home>/.march/brood/archive/<id>/container.log`, or `undefined`
 * when `id` would escape the archive root. Registration only checks that an
 * id is non-empty, so an id carrying `..` (or an absolute path) would
 * otherwise turn this read-only endpoint into a probe for any readable
 * `container.log` on the host. The containment check keeps the traversal from
 * reaching the filesystem at all rather than trusting the id.
 */
function archivedContainerLogPath(
  id: string,
  homeDir?: string,
): string | undefined {
  const root = path.resolve(broodDir(homeDir), "archive");
  const candidate = path.resolve(root, id, "container.log");
  const rel = path.relative(root, candidate);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return candidate;
}

/**
 * Archive ids to try, in order. `teardownSession` archives a spawn<->steward
 * group under the *spawn* id (its `primary`), so a steward row's archived
 * `container.log` lives under `parentId`, not under the steward's own id.
 */
function archiveCandidateIds(record: SessionRecord): string[] {
  const ids = [record.id];
  if (record.parentId && record.parentId !== record.id) {
    ids.push(record.parentId);
  }
  return ids;
}

type ArchiveOutcome =
  | { readonly kind: "read"; readonly result: SessionLogResult }
  | { readonly kind: "failed"; readonly detail: string }
  | { readonly kind: "absent" };

function readArchiveIfAvailable(
  record: SessionRecord,
  deps: ResolvedLogReaderDeps,
): ArchiveOutcome {
  let failure: string | undefined;
  for (const id of archiveCandidateIds(record)) {
    const archivePath = archivedContainerLogPath(id, deps.homeDir);
    if (!archivePath) continue;
    if (!deps.archiveExists(archivePath)) continue;
    try {
      return {
        kind: "read",
        result: {
          source: { kind: "archive", archivePath, available: true },
          content: deps.readArchive(archivePath),
        },
      };
    } catch (err) {
      failure ??= `${archivePath}: ${errorMessage(err)}`;
    }
  }
  return failure ? { kind: "failed", detail: failure } : { kind: "absent" };
}

export function readSessionLogs(
  record: SessionRecord,
  deps: LogReaderDeps = {},
): SessionLogResult {
  const d = resolveDeps(deps);
  let liveFailure: string | undefined;

  if (record.kind !== "steward" && record.containerId) {
    try {
      return {
        source: {
          kind: "live-container",
          containerId: record.containerId,
          available: true,
        },
        content: d.readContainerLogs(record.containerId),
      };
    } catch (err) {
      liveFailure = errorMessage(err);
    }
  }

  const archive = readArchiveIfAvailable(record, d);
  if (archive.kind === "read") return archive.result;

  // A live read that already failed owns the outcome: an unreadable archive is
  // just another archive miss, so the upstream failure keeps both the
  // contracted 502 status and its diagnostic context.
  if (liveFailure) {
    const archiveDetail =
      archive.kind === "failed"
        ? ` (archived log unreadable: ${archive.detail})`
        : "";
    throw new BroodLogUnavailableError(
      `Live container logs for session "${record.id}" are unavailable and no archived log exists${archiveDetail}: ${liveFailure}`,
      "live-source-failed",
    );
  }

  if (archive.kind === "failed") {
    throw new BroodLogUnavailableError(
      `Archived logs for session "${record.id}" are unreadable: ${archive.detail}`,
      "archive-read-failed",
    );
  }

  throw new BroodLogUnavailableError(
    `Logs for session "${record.id}" are unavailable: no live container logs or archived log exists.`,
    "no-source",
  );
}
