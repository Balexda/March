import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROMPT_PATH } from "./spawn-config.js";

/**
 * Stage 5 prompt-handoff helper for the Spawn Dispatch pipeline.
 *
 * Writes the finalized prompt produced by `finalizePrompt` (Task 3) into
 * a running spawn container at the path consumed by
 * `claudeCodeBackend.buildEntrypoint` — by default
 * {@link PROMPT_PATH} (`/march/prompt.txt`).
 *
 * Per the spec's Critical Assumption ("The finalized prompt is written
 * to a file inside the container") and the contracts' Stage 5 row
 * ("Write finalized prompt to container, invoke backend CLI"), the
 * prompt is delivered to the running container at handoff time — it is
 * NOT baked into the image. The Image Build template (`FROM/COPY/
 * WORKDIR`) in `snapshot-build.ts`, the `createBuildContext` output in
 * `snapshot.ts`, and the Snapshot Exclusion List remain untouched.
 *
 * The chosen handoff mechanism (SD-002 of the US6 slice 1 tasks file)
 * is `docker cp <hostTempFile> <containerId>:<targetPath>`:
 *   1. Write the finalized prompt to a host-side temp file (a unique
 *      directory under {@link os.tmpdir} owned end-to-end by this
 *      helper).
 *   2. Invoke `docker cp` to copy the file into the container.
 *   3. Remove the temp directory regardless of success or failure.
 *
 * Pipeline note: this helper is the Stage 5 boundary between Stage 4
 * (Launch — owned by Story 5) and Stage 6 (Wait — owned by Story 7). It
 * is intentionally NOT invoked from the dispatch action in `src/cli.ts`
 * by this slice; Story 5 owns the call-sequence wiring (`docker create`
 * → this handoff → `docker start` per SD-003) so the launch sequence is
 * added in one place.
 */

/**
 * Error thrown by Stage 5 prompt-handoff failures (host-side temp file
 * write failure or `docker cp` failure). Distinct from
 * {@link import("./container-launch.js").LaunchError},
 * {@link import("./snapshot-build.js").BuildError}, and
 * {@link import("./spawn-record.js").SpawnRecordError} so callers can
 * map this to the SpawnRecord `created → failed` transition per FR-021
 * and route artifact cleanup through the existing reverse-order chain
 * (container → image → worktree+branch).
 *
 * The message is human-readable and suitable for writing directly to
 * stderr; for `docker cp` failures it includes the tail of the docker
 * stderr stream so operators can diagnose without re-running the
 * handoff.
 */
export class HandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffError";
  }
}

/** Maximum docker stderr characters surfaced in a {@link HandoffError}. */
const STDERR_TAIL_CHARS = 4_000;

/**
 * Cap on the captured docker stderr buffer. Mirrors the rationale
 * documented in `snapshot-build.ts` and `container-launch.ts`:
 * `execFileSync`'s default `maxBuffer` is 1 MiB, which a verbose
 * docker daemon error can blow past — overflowing reports as
 * `ENOBUFS` and masquerades as a handoff failure. 16 MiB gives plenty
 * of headroom while still bounding memory if the daemon goes haywire.
 */
const DOCKER_STDERR_MAX_BUFFER = 16 * 1024 * 1024;

/** Inputs to {@link handoffPromptToContainer}. */
export interface HandoffPromptInput {
  /**
   * Full container ID (or container name) of a running spawn container —
   * the value Story 5's Stage 4 Launch returns from `docker run -d` /
   * `docker create` + `docker start`.
   */
  readonly containerId: string;
  /**
   * The finalized prompt string (output of `finalizePrompt` from
   * `prompt-finalize.ts`). Written verbatim to the host temp file; the
   * helper does not transform, escape, or normalise it.
   */
  readonly finalizedPrompt: string;
  /**
   * Override the in-container destination path. Defaults to
   * {@link PROMPT_PATH} so the entrypoint and handoff destination
   * cannot drift apart (SD-004). Exposed as a parameter purely so the
   * unit and integration tests can target an alternate path inside the
   * container without monkey-patching the constant — production callers
   * always rely on the default.
   */
  readonly containerPromptPath?: string;
}

/**
 * Tail-truncates a docker stderr buffer (or arbitrary unknown payload)
 * into a string suitable for embedding in an error message. Mirrors
 * the helper in `snapshot-build.ts` and `container-launch.ts` verbatim.
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
 * Writes the finalized prompt into a running container at the path
 * consumed by `claudeCodeBackend.buildEntrypoint` (default
 * {@link PROMPT_PATH}) via `docker cp <hostTempFile> <container>:<path>`
 * per SD-002.
 *
 * The host-side temp file lives in a unique directory under
 * {@link os.tmpdir} created by {@link fs.mkdtempSync}; both the file
 * and its parent directory are removed in a `finally` block regardless
 * of whether `docker cp` succeeded so a partial-success path cannot
 * leak operator prompts to disk.
 *
 * @throws {HandoffError} If the host-side temp file cannot be written,
 *   or if `docker cp` exits non-zero.
 */
export function handoffPromptToContainer(input: HandoffPromptInput): void {
  const targetPath = input.containerPromptPath ?? PROMPT_PATH;

  // Host-side temp dir so the temp file lives on the same filesystem
  // we control end-to-end; mkdtempSync gives us a unique directory
  // whose basename we own. Per SD-002 the temp file is cleaned up
  // regardless of success or failure.
  let tempDir: string;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "march-prompt-handoff-"));
  } catch (err) {
    throw new HandoffError(
      `Failed to create temp directory for prompt handoff: ${(err as Error).message}`,
    );
  }

  const tempFile = path.join(tempDir, "prompt.txt");
  try {
    fs.writeFileSync(tempFile, input.finalizedPrompt, { encoding: "utf-8" });
  } catch (err) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    throw new HandoffError(
      `Failed to write finalized prompt to temp file "${tempFile}": ${(err as Error).message}`,
    );
  }

  try {
    execFileSync(
      "docker",
      ["cp", tempFile, `${input.containerId}:${targetPath}`],
      {
        // stdin is closed so docker doesn't block on TTY detection.
        // stdout is discarded — `docker cp` prints nothing useful on
        // success. stderr stays piped so the HandoffError can surface
        // it. Bounded with an explicit `maxBuffer` so a verbose failure
        // does not trigger ENOBUFS — see the constant doc comment.
        stdio: ["ignore", "ignore", "pipe"],
        maxBuffer: DOCKER_STDERR_MAX_BUFFER,
      },
    );
  } catch (err) {
    const tail = stderrTail((err as { stderr?: unknown }).stderr);
    throw new HandoffError(
      tail.length > 0
        ? `docker cp failed for container "${input.containerId}":\n${tail}`
        : `docker cp failed for container "${input.containerId}": ${(err as Error).message}`,
    );
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
