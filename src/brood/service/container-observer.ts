import { execFile } from "node:child_process";

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
 * Cap on captured docker stdout. `execFile`'s 1 MiB default is ample for a
 * two-column listing, but the bound is explicit for the same reason
 * `container-launch.ts` bounds its buffers: an unexpectedly chatty daemon must
 * fail loudly rather than balloon service memory.
 */
const DOCKER_OUTPUT_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Upper bound on one `docker ps` observation. The read runs inside a request
 * handler, so a stalled daemon must not hold the request (or, as a synchronous
 * call once did, the whole event loop) forever: past this bound the child is
 * killed and the read surfaces as the same `503` an unreachable daemon does.
 */
export const DOCKER_OBSERVE_TIMEOUT_MS = 10_000;

/** Result of one docker invocation: captured stdout, or a rejection. */
export type DockerRunner = (
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly maxBuffer: number },
) => Promise<string>;

/** Options for {@link dockerContainerObserver}; both exist for tests. */
export interface DockerContainerObserverOptions {
  /** Finite bound on the docker call. Defaults to {@link DOCKER_OBSERVE_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Process runner. Defaults to an async, non-blocking `execFile`. */
  readonly runDocker?: DockerRunner;
}

/**
 * Default runner: asynchronous `execFile`, so the service event loop keeps
 * serving health checks and unreconciled reads while docker answers. A timeout
 * kills the child (SIGTERM) and rejects with `killed: true`.
 */
const execDocker: DockerRunner = (args, { timeoutMs, maxBuffer }) =>
  new Promise((resolve, reject) => {
    execFile(
      "docker",
      [...args],
      { encoding: "utf-8", timeout: timeoutMs, maxBuffer },
      (err, stdout, stderr) => {
        if (err) {
          reject(Object.assign(err, { stdout, stderr }));
          return;
        }
        resolve(stdout);
      },
    );
  });

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
export function dockerContainerObserver(
  options: DockerContainerObserverOptions = {},
): ContainerObserver {
  const timeoutMs = options.timeoutMs ?? DOCKER_OBSERVE_TIMEOUT_MS;
  const runDocker = options.runDocker ?? execDocker;
  return {
    async observe(containerIds) {
      const observed = new Map<string, ContainerObservation>();
      // Nothing tracked to observe (e.g. steward-only rows, which are hosted in
      // Castra and own no container): the observation pass trivially succeeds
      // without shelling out, so a docker-less host is not reported unreachable.
      if (containerIds.length === 0) return observed;
      let stdout: string;
      try {
        stdout = await runDocker(
          ["ps", "--all", "--no-trunc", "--format", "{{.ID}}\t{{.State}}"],
          { timeoutMs, maxBuffer: DOCKER_OUTPUT_MAX_BUFFER },
        );
      } catch (err) {
        const e = err as { stderr?: unknown; killed?: boolean; message?: string };
        if (e.killed) {
          throw new ContainerObserverUnavailableError(
            `docker liveness observation timed out after ${timeoutMs}ms`,
          );
        }
        throw new ContainerObserverUnavailableError(
          `docker liveness observation failed: ${tail(e.stderr) || (e.message ?? String(err))}`,
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
