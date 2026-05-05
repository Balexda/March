import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BASE_IMAGE } from "./spawn-config.js";

/**
 * Error thrown by docker build / image-management operations in the
 * snapshot pipeline. Distinct from {@link SnapshotError} (context
 * assembly) so callers can distinguish "context could not be assembled"
 * from "docker daemon rejected the build" without string-matching.
 *
 * The message is human-readable and suitable for writing directly to
 * stderr; for build failures it includes the tail of the docker stderr
 * stream so operators can diagnose without re-running the build.
 */
export class BuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildError";
  }
}

/**
 * The fixed filename of the generated Dockerfile inside the build
 * context. We use the conventional `Dockerfile` name even though we
 * pass it explicitly via `-f`, to match operator expectations when
 * inspecting a leaked context directory after a crash.
 */
export const SPAWN_DOCKERFILE_NAME = "Dockerfile";

/** Maximum docker stderr characters surfaced in a {@link BuildError}. */
const STDERR_TAIL_CHARS = 4_000;

/**
 * Returns the canonical image tag for a given spawn ID. Centralised so the
 * build, removal, and (eventually) container-launch helpers all agree on the
 * tag format `march-spawn-<spawn-id>` from the contracts.
 */
export function spawnImageTag(spawnId: string): string {
  return `march-spawn-${spawnId}`;
}

/**
 * Generates and writes the Dockerfile for a spawn into the given build
 * context directory. Content matches the Spawn Dispatch contracts' Image
 * Build template verbatim:
 *
 * ```dockerfile
 * FROM <base-image-tag>
 * COPY --chown=march:march . /march/workspace
 * WORKDIR /march/workspace
 * ```
 *
 * @param contextPath - Absolute path to the temp build-context directory
 *   produced by {@link createBuildContext}.
 * @param baseImage - Base image tag for the `FROM` line. Defaults to the
 *   shared {@link BASE_IMAGE} constant from `spawn-config.ts`.
 * @returns Absolute path to the written Dockerfile (always
 *   `<contextPath>/Dockerfile`).
 */
export function writeSpawnDockerfile(
  contextPath: string,
  baseImage: string = BASE_IMAGE,
): string {
  const dockerfilePath = path.join(contextPath, SPAWN_DOCKERFILE_NAME);
  // Trailing newline so POSIX tools don't whine about a missing final LF
  // and so a manual `cat` of a leaked context doesn't run into the next
  // shell prompt — small ergonomic win, no behavioral impact on docker.
  const content =
    `FROM ${baseImage}\n` +
    `COPY --chown=march:march . /march/workspace\n` +
    `WORKDIR /march/workspace\n`;
  fs.writeFileSync(dockerfilePath, content, { encoding: "utf-8" });
  return dockerfilePath;
}

/** Inputs to {@link buildSpawnImage}. */
export interface BuildSpawnImageInput {
  /** SpawnId — used to derive the image tag `march-spawn-<id>`. */
  readonly spawnId: string;
  /** Absolute path to the build-context directory (passed as the final
   * positional arg to `docker build`). */
  readonly contextPath: string;
  /** Absolute path to the generated Dockerfile (passed via `-f`). */
  readonly dockerfilePath: string;
}

/**
 * Tail-truncates a docker stderr buffer (or arbitrary unknown payload)
 * into a string suitable for embedding in an error message.
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
 * Invokes `docker build -t march-spawn-<id> -f <dockerfile> <context>` for
 * a single spawn. The build context is COPY-only (no bind mounts) per
 * FR-010 / AS 4.3 — a temp directory populated by
 * {@link createBuildContext} that contains real file copies of the
 * worktree's tracked files.
 *
 * On success the image is tagged in the local docker daemon and the tag
 * (which is also the image identifier the rest of the pipeline uses) is
 * returned so callers can record it on the SpawnRecord.
 *
 * On failure a {@link BuildError} is thrown whose message includes the
 * tail of the docker stderr stream so operators can diagnose without
 * re-running the build. Before the error is rethrown, a best-effort
 * `docker image rm <tag>` is issued so a partially tagged image (e.g.
 * one whose final layer failed) does not linger and confuse a subsequent
 * dispatch attempt. If that cleanup itself fails, the cleanup error is
 * intentionally swallowed: the original build failure is more diagnostic
 * and the cleanup is best-effort by contract.
 *
 * @throws {BuildError} If `docker build` exits non-zero.
 */
export function buildSpawnImage(input: BuildSpawnImageInput): string {
  const tag = spawnImageTag(input.spawnId);
  try {
    execFileSync(
      "docker",
      [
        "build",
        "-t",
        tag,
        "-f",
        input.dockerfilePath,
        input.contextPath,
      ],
      {
        // Capture stderr so the BuildError can surface it. stdout is
        // ignored (build output is voluminous and not user-facing here);
        // stdin is closed so docker doesn't block on TTY detection.
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (err) {
    const tail = stderrTail((err as { stderr?: unknown }).stderr);
    // Best-effort cleanup of the partially tagged image. If docker never
    // tagged the image (e.g. the build failed before the final layer),
    // `docker image rm` will exit non-zero — `removeSpawnImage` swallows
    // that, so this never re-throws over the original error.
    try {
      removeSpawnImage(input.spawnId);
    } catch {
      // intentionally ignored — see doc comment
    }
    throw new BuildError(
      tail.length > 0
        ? `docker build failed for "${tag}":\n${tail}`
        : `docker build failed for "${tag}": ${(err as Error).message}`,
    );
  }
  return tag;
}

/**
 * Removes the docker image tagged for the given spawn ID. Idempotent and
 * never throws, so it is safe to invoke on the rollback path even when
 * the build never succeeded (or never ran). Exposed for the dispatch
 * action's reverse-order cleanup chain (image → worktree → branch).
 *
 * Implementation note: we deliberately do not pass `-f` (force) — if a
 * future code path tags additional aliases on this image, we want
 * accidental refcount issues to surface rather than silently delete
 * shared layers. Today there are no aliases, so the no-force flag is
 * effectively cosmetic.
 */
export function removeSpawnImage(spawnId: string): void {
  const tag = spawnImageTag(spawnId);
  try {
    execFileSync("docker", ["image", "rm", tag], {
      // Discard stdout entirely — caller does not care about removed
      // image hashes. Capture stderr to avoid noisy "no such image"
      // messages reaching the operator's terminal during rollback.
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    // Idempotent by contract: a missing image is a successful no-op.
    // Other failures (daemon down, permissions) are also swallowed here
    // because the rollback path has nothing useful to do with them and
    // surfacing them would mask the original dispatch error that
    // triggered the rollback. Operators can still diagnose via
    // `docker image ls` after the fact.
  }
}
