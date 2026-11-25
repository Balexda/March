import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
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
  /** Registration identity of each verified steward, checked before recovery. */
  stewards?: StewardIdentity[];
  /** Primary resource identity this attempt reclaimed. */
  resources?: TeardownResources;
}

/** The steward registration a removal verified: its row, owner, and Castra target. */
export interface StewardIdentity {
  id: string;
  parentId: string | null;
  sessionId: string;
  profile: string | null;
}

export function stewardIdentity(record: SessionRecord): StewardIdentity {
  return {
    id: record.id,
    parentId: record.parentId ?? null,
    sessionId: record.agentDeckSessionId ?? record.id,
    profile: record.profile ?? null,
  };
}

export function sameSteward(recorded: StewardIdentity, current: SessionRecord | undefined): boolean {
  if (!current || current.kind !== "steward") return false;
  const now = stewardIdentity(current);
  return recorded.id === now.id && recorded.parentId === now.parentId &&
    recorded.sessionId === now.sessionId && recorded.profile === now.profile;
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

async function readOptional(file: string, signal: AbortSignal): Promise<string> {
  try {
    return await fs.readFile(file, { encoding: "utf8", signal });
  } catch (error) {
    if (!isMissing(error)) throw error;
    return "";
  }
}

// Publish complete files so failed writes leave the previous evidence intact.
async function publish(file: string, content: string, signal: AbortSignal, once = false): Promise<void> {
  signal.throwIfAborted();
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, content, { flag: "wx", signal });
    signal.throwIfAborted();
    if (once) {
      try {
        await fs.link(temp, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } else {
      await fs.rename(temp, file);
      return;
    }
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
  await fs.rm(temp, { force: true });
}

export class TeardownArchive {
  private readonly journal: string;
  private history = "";
  private last?: AttemptStarted | AttemptFinished;

  constructor(private readonly dir: string) {
    this.journal = path.join(dir, "teardown.ndjson");
  }

  async load(signal: AbortSignal): Promise<void> {
    this.history = await readOptional(this.journal, signal);
    const end = this.history.trimEnd().length;
    if (end > 0) {
      const start = this.history.lastIndexOf("\n", end - 1) + 1;
      this.last = JSON.parse(this.history.slice(start, end)) as AttemptStarted | AttemptFinished;
    }
  }

  get completion(): AttemptFinished | undefined {
    return this.last?.event === "finished" && this.last.status === "torndown"
      ? this.last
      : undefined;
  }

  async start(snapshot: string, request: TeardownRequest, at: string, signal: AbortSignal): Promise<number> {
    await fs.mkdir(this.dir, { recursive: true });
    signal.throwIfAborted();
    const file = path.join(this.dir, "record.json");
    try {
      if (!(await fs.stat(file)).isFile()) throw new Error(`Invalid teardown snapshot: ${file}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await publish(file, snapshot, signal, true);
    }
    const attempt = (this.last?.attempt ?? 0) + 1;
    await this.append({
      attempt,
      event: "started",
      at,
      request: { force: request.force ?? false, kill: request.kill ?? false, reason: request.reason },
    }, signal);
    return attempt;
  }

  async finish(
    attempt: number,
    result: TeardownResult,
    at: string,
    verified: { stewards: StewardIdentity[]; resources: TeardownResources },
    signal: AbortSignal,
  ): Promise<void> {
    const { status, steps, warnings } = result;
    await this.append({
      attempt, event: "finished", at, status, steps, warnings,
      stewardIds: verified.stewards.map((steward) => steward.id),
      stewards: verified.stewards,
      resources: verified.resources,
    }, signal);
  }

  private async append(entry: AttemptStarted | AttemptFinished, signal: AbortSignal): Promise<void> {
    // Preserve all existing bytes. Atomically publish the extended journal so
    // a short write cannot corrupt the last entry or prevent a later retry.
    const history = this.history + JSON.stringify(entry) + "\n";
    await publish(this.journal, history, signal);
    if (entry.event === "finished" && signal.aborted) {
      // A rename already submitted to the filesystem cannot be cancelled.
      // Restore the unmatched start before releasing the archive fence.
      await publish(this.journal, this.history, new AbortController().signal);
      signal.throwIfAborted();
    }
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
  logs: string | undefined,
  warnings: string[],
  current: SessionRecord,
  signal: AbortSignal,
): Promise<void> {
  if (logs !== undefined) await publish(path.join(dir, "container.log"), logs, signal);

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
  signal.throwIfAborted();
  await fs.mkdir(artifacts, { recursive: true });

  if (extraction.status === "failed") {
    await publish(resultPath, resultJson, signal);
    signal.throwIfAborted();
    await fs.rm(patchPath, { force: true });
    return;
  }

  const { patchText, sha256: expected } = extraction.patch;
  if (sha256(patchText) !== expected) {
    warnings.push("registry extraction patch digest mismatch");
    // Preserve any previously archived patch and the JSON that describes it.
    try {
      await fs.stat(patchPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await publish(resultPath, resultJson, signal);
    }
    return;
  }

  await publish(patchPath, patchText, signal);
  if (sha256(await fs.readFile(patchPath, { signal })) !== expected) {
    throw new Error("archived extraction patch digest mismatch");
  }
  await publish(resultPath, resultJson, signal);
}
