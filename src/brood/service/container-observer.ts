import { execFileSync } from "node:child_process";

/**
 * Liveness evidence about one tracked container, as observed from the
 * container substrate (not from the registry's persisted lifecycle status).
 */
export interface ContainerObservation {
  /** The container still exists in the substrate (running or exited). */
  readonly present: boolean;
  /** The container exists AND is currently running. */
  readonly running: boolean;
}

/**
 * Service-owned liveness observation source. Brood — never the CLI — performs
 * this read, per the feature map's rule that "state and Docker reconciliation
 * live behind the service, not in the CLI process".
 *
 * Implementations MUST throw {@link ContainerObserverUnavailableError} when the
 * source cannot be reached, so callers can report an explicit failure instead
 * of silently returning unreconciled data labelled as reconciled.
 */
export interface ContainerObserver {
  observe(
    containerIds: readonly string[],
  ): Promise<ReadonlyMap<string, ContainerObservation>>;
}

/** Thrown when the liveness source cannot be reached (surfaces as `503`). */
export class ContainerObserverUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerObserverUnavailableError";
  }
}

/**
 * Cap on captured docker stdout. `execFileSync`'s 1 MiB default is ample for a
 * two-column listing, but the bound is explicit for the same reason
 * `container-launch.ts` bounds its buffers: an unexpectedly chatty daemon must
 * fail loudly rather than balloon service memory.
 */
const DOCKER_OUTPUT_MAX_BUFFER = 4 * 1024 * 1024;

/** Tail-truncates a docker stderr buffer for the surfaced error message. */
function tail(value: unknown, max = 500): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length > max ? `…${text.slice(-max)}` : text;
}

/**
 * Default observer: one `docker ps --all` per read, regardless of row count.
 *
 * A single listing is used rather than a per-container `docker inspect` so the
 * cost stays O(1) in tracked sessions, and so "the id is absent from the
 * listing" is an unambiguous signal that the container is gone — `inspect`
 * cannot distinguish a missing container from a failing daemon.
 */
export function dockerContainerObserver(): ContainerObserver {
  return {
    async observe(containerIds) {
      const observed = new Map<string, ContainerObservation>();
      // Nothing tracked to observe (e.g. steward-only rows, which are hosted in
      // Castra and own no container): the observation pass trivially succeeds
      // without shelling out, so a docker-less host is not reported unreachable.
      if (containerIds.length === 0) return observed;
      let stdout: string;
      try {
        stdout = execFileSync(
          "docker",
          ["ps", "--all", "--no-trunc", "--format", "{{.ID}}\t{{.State}}"],
          {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
            maxBuffer: DOCKER_OUTPUT_MAX_BUFFER,
          },
        );
      } catch (err) {
        const stderr = (err as { stderr?: unknown }).stderr;
        throw new ContainerObserverUnavailableError(
          `docker liveness observation failed: ${tail(stderr) || (err as Error).message}`,
        );
      }
      const states = new Map<string, string>();
      for (const line of stdout.split("\n")) {
        const [id, state] = line.trim().split("\t");
        if (id) states.set(id, (state ?? "").trim());
      }
      for (const id of containerIds) {
        const state = states.get(id);
        observed.set(
          id,
          state === undefined
            ? { present: false, running: false }
            : { present: true, running: state === "running" },
        );
      }
      return observed;
    },
  };
}
