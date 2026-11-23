import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseExtractionResult } from "./extraction.js";
import type { SessionRecord, TeardownRequest, TeardownResult } from "./types.js";

interface AttemptStarted {
  attempt: number;
  event: "started";
  at: string;
  request: TeardownRequest;
}

interface AttemptFinished {
  attempt: number;
  event: "finished";
  at: string;
  status: TeardownResult["status"];
  steps: TeardownResult["steps"];
  warnings: string[];
  /** Stewards whose removal this attempt verified. */
  stewardIds?: string[];
  /** Primary resource identity this attempt reclaimed. */
  resources?: TeardownResources;
}

export interface TeardownResources {
  containerId: string | null;
  repoPath: string | null;
  worktreePath: string | null;
  branch: string | null;
}

export function teardownResources(record: SessionRecord): TeardownResources {
  return {
    containerId: record.containerId ?? null,
    repoPath: record.repoPath ?? null,
    worktreePath: record.worktreePath ?? null,
    branch: record.branch ?? null,
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function readOptional(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
    return "";
  }
}

// Publish complete files so failed writes leave the previous evidence intact.
function publish(file: string, content: string, once = false): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, content, { flag: "wx" });
    if (once) {
      try {
        fs.linkSync(temp, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } else {
      fs.renameSync(temp, file);
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export class TeardownArchive {
  private readonly journal: string;
  private history: string;
  private last?: AttemptStarted | AttemptFinished;

  constructor(private readonly dir: string) {
    this.journal = path.join(dir, "teardown.ndjson");
    this.history = readOptional(this.journal);
    for (const line of this.history.trimEnd().split("\n")) {
      if (line) this.last = JSON.parse(line) as AttemptStarted | AttemptFinished;
    }
  }

  get completion(): AttemptFinished | undefined {
    return this.last?.event === "finished" && this.last.status === "torndown"
      ? this.last
      : undefined;
  }

  start(snapshot: string, request: TeardownRequest, at: string): number {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, "record.json");
    try {
      if (!fs.statSync(file).isFile()) throw new Error(`Invalid teardown snapshot: ${file}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
      publish(file, snapshot, true);
    }
    const attempt = (this.last?.attempt ?? 0) + 1;
    this.append({
      attempt,
      event: "started",
      at,
      request: { force: request.force ?? false, kill: request.kill ?? false, reason: request.reason },
    });
    return attempt;
  }

  finish(
    attempt: number,
    result: TeardownResult,
    at: string,
    verified: { stewardIds: string[]; resources: TeardownResources },
  ): void {
    const { status, steps, warnings } = result;
    this.append({
      attempt, event: "finished", at, status, steps, warnings,
      stewardIds: verified.stewardIds, resources: verified.resources,
    });
  }

  private append(entry: AttemptStarted | AttemptFinished): void {
    // Preserve all existing bytes. Atomically publish the extended journal so
    // a short write cannot corrupt the last entry or prevent a later retry.
    const history = this.history + JSON.stringify(entry) + "\n";
    publish(this.journal, history);
    this.history = history;
    this.last = entry;
  }
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function archiveTeardownEvidence(
  dir: string,
  primary: SessionRecord,
  readContainerLogs: (id: string) => string | Promise<string>,
  warnings: string[],
  readCurrent: () => SessionRecord = () => primary,
): Promise<void> {
  let logs: string | undefined;
  if (primary.containerId) {
    try {
      logs = await readContainerLogs(primary.containerId);
    } catch (error) {
      warnings.push(`container logs unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (primary.kind === "spawn") {
    warnings.push("container logs unavailable: no tracked container ID");
  }
  if (logs !== undefined) publish(path.join(dir, "container.log"), logs);

  const current = readCurrent();
  const extraction = parseExtractionResult(current.extractionResult);
  if (!extraction) {
    if (primary.kind === "spawn" || current.extractionResult !== undefined) {
      warnings.push("registry extraction result unavailable or malformed");
    }
    return;
  }

  const artifacts = path.join(dir, "artifacts");
  const resultPath = path.join(artifacts, "extraction-result.json");
  const patchPath = path.join(artifacts, "spawn.patch");
  const resultJson = JSON.stringify(extraction, null, 2) + "\n";
  fs.mkdirSync(artifacts, { recursive: true });

  if (extraction.status === "failed") {
    publish(resultPath, resultJson);
    fs.rmSync(patchPath, { force: true });
    return;
  }

  const { patchText, sha256: expected } = extraction.patch;
  if (sha256(patchText) !== expected) {
    warnings.push("registry extraction patch digest mismatch");
    // Preserve any previously archived patch and the JSON that describes it.
    if (!fs.existsSync(patchPath)) publish(resultPath, resultJson);
    return;
  }

  publish(patchPath, patchText);
  if (sha256(fs.readFileSync(patchPath)) !== expected) {
    throw new Error("archived extraction patch digest mismatch");
  }
  publish(resultPath, resultJson);
}
