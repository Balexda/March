import fs from "node:fs";
import path from "node:path";
import { readSpawnContainerLogs } from "../../spawn/container-launch.js";
import { broodArchiveDir } from "./store.js";
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

function archivedContainerLogPath(record: SessionRecord, homeDir?: string): string {
  return path.join(broodArchiveDir(record.id, homeDir), "container.log");
}

function readArchiveIfAvailable(
  record: SessionRecord,
  deps: ResolvedLogReaderDeps,
): SessionLogResult | undefined {
  const archivePath = archivedContainerLogPath(record, deps.homeDir);
  if (!deps.archiveExists(archivePath)) return undefined;
  try {
    return {
      source: { kind: "archive", archivePath, available: true },
      content: deps.readArchive(archivePath),
    };
  } catch (err) {
    throw new BroodLogUnavailableError(
      `Archived logs for session "${record.id}" are unreadable: ${errorMessage(err)}`,
      "archive-read-failed",
    );
  }
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
  if (archive) return archive;

  if (liveFailure) {
    throw new BroodLogUnavailableError(
      `Live container logs for session "${record.id}" are unavailable and no archived log exists: ${liveFailure}`,
      "live-source-failed",
    );
  }

  throw new BroodLogUnavailableError(
    `Logs for session "${record.id}" are unavailable: no live container logs or archived log exists.`,
    "no-source",
  );
}
