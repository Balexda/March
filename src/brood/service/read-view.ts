import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BroodReadView, SessionRecord } from "./types.js";

export interface ContainerLiveness {
  readonly containerId: string;
  readonly present: boolean;
  readonly running?: boolean;
}

export interface DeriveBroodReadViewOptions {
  readonly now?: Date;
  readonly liveness?: ContainerLiveness;
  readonly reconciled?: boolean;
}

export interface ContainerLivenessObserver {
  (containerId: string): Promise<ContainerLiveness>;
}

function humanizeAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function ageFor(record: SessionRecord, now: Date): string {
  const created = Date.parse(record.createdAt);
  if (!Number.isFinite(created)) return "";
  return humanizeAge(now.getTime() - created);
}

function disposed(record: SessionRecord): boolean {
  if (record.status === "torndown" || record.torndownAt) return true;
  return record.worktreePath ? !fs.existsSync(record.worktreePath) : false;
}

function containerLive(
  record: SessionRecord,
  liveness?: ContainerLiveness,
): boolean {
  const applies =
    liveness !== undefined &&
    record.containerId !== undefined &&
    liveness.containerId === record.containerId;
  if (applies) return liveness.present && liveness.running === true;
  return record.status === "running";
}

export function deriveBroodReadView(
  record: SessionRecord,
  options: DeriveBroodReadViewOptions = {},
): BroodReadView {
  return {
    record,
    age: ageFor(record, options.now ?? new Date()),
    needsAttention: record.status === "failed",
    disposed: disposed(record),
    containerLive: containerLive(record, options.liveness),
    reconciled: options.reconciled === true,
  };
}

export async function deriveBroodInspectView(
  record: SessionRecord,
  options: {
    readonly reconcile: boolean;
    readonly observeContainer?: ContainerLivenessObserver;
    readonly now?: Date;
  },
): Promise<BroodReadView> {
  if (!options.reconcile) {
    return deriveBroodReadView(record, {
      now: options.now,
      reconciled: false,
    });
  }
  if (!record.containerId) {
    return deriveBroodReadView(record, {
      now: options.now,
      reconciled: true,
    });
  }
  const observe = options.observeContainer ?? defaultContainerLivenessObserver;
  const liveness = await observe(record.containerId);
  return deriveBroodReadView(record, {
    now: options.now,
    liveness,
    reconciled: true,
  });
}

const execFileAsync = promisify(execFile);

/**
 * Upper bound on one container liveness probe. Inspect reconciliation is
 * enabled by default, so this probe sits on a hot read path of a
 * single-threaded Fastify service: an unbounded probe against a wedged Docker
 * CLI or daemon would stall every other Brood route, teardown included. On
 * timeout the child is killed and the probe rejects, which the inspect route
 * degrades to `reconciled: false` plus an errored span.
 */
export const CONTAINER_LIVENESS_TIMEOUT_MS = 2_000;

/** Probe overrides. Tests use these to bound a deliberately hanging command. */
export interface ContainerLivenessProbe {
  readonly command?: string;
  readonly buildArgs?: (containerId: string) => string[];
  readonly timeoutMs?: number;
}

export async function defaultContainerLivenessObserver(
  containerId: string,
  probe: ContainerLivenessProbe = {},
): Promise<ContainerLiveness> {
  try {
    const { stdout } = await execFileAsync(
      probe.command ?? "docker",
      probe.buildArgs?.(containerId) ?? [
        "inspect",
        "-f",
        "{{.State.Status}}",
        containerId,
      ],
      {
        encoding: "utf-8",
        timeout: probe.timeoutMs ?? CONTAINER_LIVENESS_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
    );
    return { containerId, present: true, running: stdout.trim() === "running" };
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    const message =
      typeof stderr === "string"
        ? stderr
        : err instanceof Error
          ? err.message
          : String(err);
    // A definitively absent container is an observation, not a probe failure.
    // Everything else — including a timeout kill — propagates so the route
    // degrades rather than reporting a container as gone on bad evidence.
    if (message.includes("No such object")) {
      return { containerId, present: false };
    }
    throw err;
  }
}
