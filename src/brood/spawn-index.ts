import fs from "node:fs";
import path from "node:path";
import {
  spawnRecordDir,
  spawnRecordPath,
  type SpawnRecord,
} from "./spawn-record.js";

export interface SpawnIndexWarning {
  readonly filePath: string;
  readonly error: Error;
}

export interface ListSpawnRecordsOptions {
  readonly homeDir?: string;
  readonly warn?: (warning: SpawnIndexWarning) => void;
}

function defaultWarn(warning: SpawnIndexWarning): void {
  console.warn(
    `Skipping unreadable spawn record "${warning.filePath}": ${warning.error.message}`,
  );
}

function parseSpawnRecord(filePath: string): SpawnRecord {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as SpawnRecord;
}

function readForList(
  filePath: string,
  warn: (warning: SpawnIndexWarning) => void,
): SpawnRecord | undefined {
  try {
    return parseSpawnRecord(filePath);
  } catch {
    try {
      return parseSpawnRecord(filePath);
    } catch (err) {
      warn({ filePath, error: err as Error });
      return undefined;
    }
  }
}

export function listSpawnRecords(homeDir?: string): SpawnRecord[];
export function listSpawnRecords(options?: ListSpawnRecordsOptions): SpawnRecord[];
export function listSpawnRecords(
  input: string | ListSpawnRecordsOptions = {},
): SpawnRecord[] {
  const options = typeof input === "string" ? { homeDir: input } : input;
  const dir = spawnRecordDir(options.homeDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const warn = options.warn ?? defaultWarn;
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .flatMap((entry) => {
      const record = readForList(path.join(dir, entry), warn);
      return record ? [record] : [];
    });
}

export function loadSpawnRecord(
  id: string,
  homeDir?: string,
): SpawnRecord | undefined {
  try {
    return parseSpawnRecord(spawnRecordPath(id, homeDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}
