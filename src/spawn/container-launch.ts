import { execFileSync } from "node:child_process";
import { SPAWN_CONFIG } from "../hatchery/spawn-config.js";
import { spawnImageTag } from "./snapshot-build.js";

/**
 * Error thrown by docker run / container-management operations in the
 * launch pipeline. Distinct from {@link import("./snapshot-build.js").BuildError}
 * (image build) so callers can distinguish "image build failed" from
 * "container failed to start" without string-matching.
 *
 * The message is human-readable and suitable for writing directly to
 * stderr; for launch failures it includes the tail of the docker stderr
 * stream so operators can diagnose without re-running the launch.
 */
export class LaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchError";
  }
}

/**
 * In-container path where Story 6 will materialise the finalized prompt
 * file before launch. The Claude Code entrypoint constructed by
 * {@link buildClaudeCodeEntrypoint} reads from this path via
 * `$(cat /march/prompt.txt)`.
 *
 * Exported as a load-bearing contract: any consumer that places a prompt
 * file into the container must use this path, and any future migration to
 * a per-backend `SpawnBackend.buildEntrypoint` must continue to honor it.
 */
export const CONTAINER_PROMPT_PATH = "/march/prompt.txt";

/** Maximum docker stderr characters surfaced in a {@link LaunchError}. */
const STDERR_TAIL_CHARS = 4_000;

/**
 * Cap on the captured docker stderr/stdout buffer. Mirrors the rationale
 * documented in `snapshot-build.ts`: `execFileSync`'s default `maxBuffer`
 * is 1 MiB, which a verbose docker daemon error (e.g. failed image pull,
 * cgroup setup, network policy) can blow past — overflowing reports as
 * `ENOBUFS` and masquerades as a launch failure. 16 MiB gives plenty of
 * headroom while still bounding memory if the daemon goes haywire.
 */
const DOCKER_OUTPUT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Returns the canonical container name for a given spawn ID. The container
 * name (`--name march-spawn-<spawn-id>`) intentionally matches the image
 * tag computed by {@link spawnImageTag} so an operator who runs `docker ps`
 * and `docker images` sees a consistent naming surface across the spawn's
 * lifecycle.
 */
function spawnContainerName(spawnId: string): string {
  return `march-spawn-${spawnId}`;
}

/**
 * Tail-truncates a docker stderr buffer (or arbitrary unknown payload)
 * into a string suitable for embedding in an error message. Mirrors the
 * helper in `snapshot-build.ts` verbatim.
 */
function stderrTail(stderr: unknown): string {
  // Buffer | string per the `child_process` types, but accept anything.
  let text: string;
  if (Buffer.isBuffer(stderr)) text = stderr.toString("utf-8");
  else if (typeof stderr === "string") text = stderr;
  else if (stderr == null) text = "";
  else text = String(stderr);
  text = text.trimEnd();
  if (text.length <= STDERR_TAIL_CHARS) return text;
  return "…" + text.slice(-STDERR_TAIL_CHARS);
}

/**
 * Constructs the Claude Code container entrypoint. Returns the argv array
 * docker should exec inside the container, parameterised on the in-container
 * prompt-file path so the future `SpawnBackend.buildEntrypoint(promptFilePath)`
 * migration (Feature 3) is a rename rather than a re-architecting.
 *
 * Output matches the contracts' Claude Code Implementation section verbatim:
 *
 * ```
 * ["sh", "-c",
 *  "claude -p \"$(cat /march/prompt.txt)\" --output-format json --dangerously-skip-permissions --bare --no-session-persistence"]
 * ```
 *
 * The shell wrapper (`sh -c`) is required because Docker's exec form does
 * not invoke a shell, and the entrypoint relies on `$(cat ...)` shell
 * expansion to inline the prompt without exposing it on the argv.
 */
function buildClaudeCodeEntrypoint(promptFilePath: string): string[] {
  return [
    "sh",
    "-c",
    `claude -p "$(cat ${promptFilePath})" --output-format json --dangerously-skip-permissions --bare --no-session-persistence`,
  ];
}

/** Inputs to {@link launchSpawnContainer}. */
export interface LaunchSpawnContainerInput {
  /** SpawnId — used to derive the container name and image tag. */
  readonly spawnId: string;
}

/**
 * Invokes `docker run -d` for a single spawn against the image tag produced
 * by Story 4 (`march-spawn-<spawn-id>`), composing the security and resource
 * flags from {@link SPAWN_CONFIG} and the Claude Code entrypoint per the
 * contracts' Container Launch and Claude Code Implementation sections.
 *
 * The argv composition is, in order:
 *
 * ```
 * run -d
 * --name march-spawn-<spawn-id>
 * --cap-drop=<cap> (per entry in SPAWN_CONFIG.capDrop; defaults to ["ALL"])
 * --user <SPAWN_CONFIG.user>
 * --memory <SPAWN_CONFIG.memoryLimit>
 * --cpus <SPAWN_CONFIG.cpuLimit>
 * --network <SPAWN_CONFIG.networkMode>
 * (-e <var> per entry in SPAWN_CONFIG.envWhitelist — passthrough form)
 * <imageTag>
 * <claudeCodeEntrypoint...>
 * ```
 *
 * `SPAWN_CONFIG.timeoutSeconds` is intentionally NOT emitted at this
 * stage — Stage 6 (Wait) enforces the timeout per the Dispatch Pipeline
 * contract; Story 7 owns that enforcement.
 *
 * Env-vars are passed via `-e VAR` passthrough (Docker reads the value from
 * the operator's environment), not `-e VAR=<inlined>`. See SD-001 for the
 * rationale; Feature 4 may add a pre-flight check that the operator has
 * `ANTHROPIC_API_KEY` set before reaching this stage.
 *
 * On success, returns the trimmed container ID captured from `docker run -d`
 * stdout (the full container ID, not the name) so callers can populate the
 * SpawnRecord's `containerId` field.
 *
 * On failure a {@link LaunchError} is thrown whose message includes the
 * tail of the docker stderr stream so operators can diagnose without
 * re-running the launch. Before the error is rethrown, a best-effort
 * `docker rm -f <name>` is issued so a partially started container does
 * not linger and confuse a subsequent dispatch attempt. If that cleanup
 * itself fails, the cleanup error is intentionally swallowed: the original
 * launch failure is more diagnostic and the cleanup is best-effort by
 * contract.
 *
 * @throws {LaunchError} If `docker run -d` exits non-zero.
 */
export function launchSpawnContainer(input: LaunchSpawnContainerInput): string {
  const { spawnId } = input;
  const containerName = spawnContainerName(spawnId);
  const imageTag = spawnImageTag(spawnId);

  // Cap-drop flags derived from SPAWN_CONFIG.capDrop so the constant is
  // the single auditable source of truth for what's surfaced to docker
  // run. Combined `--cap-drop=<cap>` form matches the contracts' template.
  const capDropFlags = SPAWN_CONFIG.capDrop.map((cap) => `--cap-drop=${cap}`);

  const envFlags: string[] = [];
  for (const envVar of SPAWN_CONFIG.envWhitelist) {
    // Passthrough form: `-e VAR` (no `=value`) so Docker reads the value
    // from the operator's environment at launch time. Per SD-001.
    envFlags.push("-e", envVar);
  }

  const args: string[] = [
    "run",
    "-d",
    "--name",
    containerName,
    ...capDropFlags,
    "--user",
    SPAWN_CONFIG.user,
    "--memory",
    SPAWN_CONFIG.memoryLimit,
    "--cpus",
    SPAWN_CONFIG.cpuLimit,
    "--network",
    SPAWN_CONFIG.networkMode,
    ...envFlags,
    imageTag,
    ...buildClaudeCodeEntrypoint(CONTAINER_PROMPT_PATH),
  ];

  let stdout: Buffer | string;
  try {
    stdout = execFileSync("docker", args, {
      // stdin is closed so docker doesn't block on TTY detection.
      // stdout is captured because `docker run -d` prints the container
      // ID we need to return. stderr stays piped so the LaunchError can
      // surface it. Both streams are bounded with an explicit `maxBuffer`
      // so a verbose failure does not trigger ENOBUFS — see the constant
      // doc comment for rationale.
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: DOCKER_OUTPUT_MAX_BUFFER,
    });
  } catch (err) {
    const tail = stderrTail((err as { stderr?: unknown }).stderr);
    // Best-effort cleanup of any partially started container. If docker
    // never created the container (e.g. the run failed during flag
    // validation), `docker rm -f` will exit non-zero — `removeSpawnContainer`
    // swallows that, so this never re-throws over the original error.
    try {
      removeSpawnContainer(spawnId);
    } catch {
      // intentionally ignored — see doc comment
    }
    throw new LaunchError(
      tail.length > 0
        ? `docker run failed for "${containerName}":\n${tail}`
        : `docker run failed for "${containerName}": ${(err as Error).message}`,
    );
  }

  // `docker run -d` prints the full container ID followed by a newline.
  const text = Buffer.isBuffer(stdout) ? stdout.toString("utf-8") : stdout;
  return text.trim();
}

/**
 * Removes the docker container named for the given spawn ID. Idempotent
 * and never throws, so it is safe to invoke on the rollback path even
 * when the launch never succeeded (or never ran). Exposed for the dispatch
 * action's reverse-order cleanup chain (container → image → worktree →
 * branch). Mirrors the never-throws contract of `removeSpawnImage` and
 * `removeSpawnWorktree`.
 *
 * Implementation note: we use `docker rm -f` so a still-running container
 * (if launch succeeded but a subsequent stage failed) is also cleaned up.
 * `-f` issues a SIGKILL before removal — acceptable here because the
 * rollback path is by definition a failure mode and graceful shutdown is
 * Story 7's concern, not this slice's.
 */
export function removeSpawnContainer(spawnId: string): void {
  const containerName = spawnContainerName(spawnId);
  try {
    execFileSync("docker", ["rm", "-f", containerName], {
      // Discard stdout entirely — caller does not care about removed
      // container IDs. Capture stderr so we can swallow noisy "no such
      // container" messages rather than leaking them to the operator's
      // terminal during rollback.
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    // Idempotent by contract: a missing container is a successful no-op.
    // Other failures (daemon down, permissions) are also swallowed here
    // because the rollback path has nothing useful to do with them and
    // surfacing them would mask the original dispatch error that
    // triggered the rollback. Operators can still diagnose via
    // `docker ps -a` after the fact.
  }
}
