import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type BackendCredentialMount,
  resolveCredentialMounts,
  type SpawnBackend,
} from "./backends.js";
import { SPAWN_CONFIG } from "../hatchery/spawn-config.js";
import { spawnImageTag } from "./snapshot-build.js";
import {
  IN_SPAWN_EMITTER_PATH,
  inSpawnEmitterScript,
  type SpawnOtelContext,
  wrapEntrypointWithEmitter,
} from "../observability/in-spawn-emitter.js";

/**
 * Error thrown by docker create/start/wait/logs operations in the
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
 * the selected backend reads from this path.
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

interface ParsedMountFlag {
  /** The offending flag exactly as it appears in the launch argv, value included. */
  readonly flag: string;
  /**
   * Docker's `--mount type=` value; always `bind` for the `-v` / `--volume`
   * short forms. Anything other than `bind` is rejected unconditionally — see
   * the F4 US5 contract's permitted-flag table.
   */
  readonly mountType: string;
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
}

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
 * Stage 4 mount validator. It inspects the concrete docker argv that will be
 * launched and rejects every host bind mount except the selected backend's
 * declared credential mounts, plus every non-bind `--mount` type (named
 * volumes carry cross-spawn persistence, forbidden in M1).
 *
 * `imageTag` marks the end of the docker flag section: Docker stops parsing
 * its own flags at the image token, so everything from there on is the
 * container's command. Scanning it would let a backend entrypoint that
 * happens to use `-v` (verbose) be misread as a bind mount. When omitted the
 * whole argv is scanned, which is what the direct unit tests want.
 */
export function validateLaunchBindMounts(
  backend: SpawnBackend,
  args: readonly string[],
  credentialMounts: readonly BackendCredentialMount[] = resolveCredentialMounts(backend),
  imageTag?: string,
): void {
  const allowed = new Set(
    credentialMounts.map(
      (mount) =>
        `${mount.hostPath}\0${mount.containerPath}\0${mount.readOnly ? "ro" : "rw"}`,
    ),
  );

  const imageIdx = imageTag === undefined ? -1 : args.indexOf(imageTag);
  const dockerFlags = imageIdx === -1 ? args : args.slice(0, imageIdx);

  for (const mount of parseMountFlags(dockerFlags)) {
    if (mount.mountType !== "bind") {
      throw new LaunchError(
        [
          `docker create rejected non-bind mount ${JSON.stringify(mount.flag)} for backend "${backend.name}".`,
          `Only backend-declared credential bind mounts are permitted; --mount type=${mount.mountType} is not.`,
          `Declared credential mounts: ${formatDeclaredCredentialMounts(credentialMounts)}.`,
        ].join(" "),
      );
    }

    const key = `${mount.source}\0${mount.target}\0${mount.readOnly ? "ro" : "rw"}`;
    if (!allowed.has(key)) {
      throw new LaunchError(
        [
          `docker create rejected undeclared bind mount ${JSON.stringify(mount.flag)} for backend "${backend.name}".`,
          "Only backend-declared credential mounts are permitted.",
          `Declared credential mounts: ${formatDeclaredCredentialMounts(credentialMounts)}.`,
        ].join(" "),
      );
    }
  }
}

function parseMountFlags(args: readonly string[]): readonly ParsedMountFlag[] {
  const mounts: ParsedMountFlag[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--tmpfs" || arg.startsWith("--tmpfs=")) {
      if (arg === "--tmpfs") i++;
      continue;
    }

    if (arg === "-v" || arg === "--volume") {
      const value = args[i + 1];
      if (value !== undefined) mounts.push(parseVolumeFlag(`${arg} ${value}`, value));
      i++;
      continue;
    }

    if (arg.startsWith("-v=")) {
      mounts.push(parseVolumeFlag(arg, arg.slice("-v=".length)));
      continue;
    }

    if (arg.startsWith("--volume=")) {
      mounts.push(parseVolumeFlag(arg, arg.slice("--volume=".length)));
      continue;
    }

    if (arg === "--mount") {
      const value = args[i + 1];
      if (value !== undefined) mounts.push(parseMountFlag(`${arg} ${value}`, value));
      i++;
      continue;
    }

    if (arg.startsWith("--mount=")) {
      mounts.push(parseMountFlag(arg, arg.slice("--mount=".length)));
    }
  }

  return mounts;
}

function parseVolumeFlag(flag: string, value: string): ParsedMountFlag {
  const [source = "", target = "", ...options] = value.split(":");
  return {
    flag,
    mountType: "bind",
    source,
    target,
    readOnly: options.includes("ro") || options.includes("readonly"),
  };
}

function parseMountFlag(flag: string, value: string): ParsedMountFlag {
  const fields = new Map<string, string>();
  const bareOptions = new Set<string>();

  for (const segment of value.split(",")) {
    const equalsIdx = segment.indexOf("=");
    if (equalsIdx === -1) {
      bareOptions.add(segment);
      continue;
    }
    fields.set(segment.slice(0, equalsIdx), segment.slice(equalsIdx + 1));
  }

  return {
    flag,
    // Docker defaults `--mount` to type=volume when `type=` is omitted.
    mountType: fields.get("type") ?? "volume",
    source: fields.get("source") ?? fields.get("src") ?? "",
    target: fields.get("target") ?? fields.get("dst") ?? fields.get("destination") ?? "",
    readOnly:
      bareOptions.has("readonly") ||
      bareOptions.has("ro") ||
      fields.get("readonly") === "true" ||
      fields.get("readonly") === "1" ||
      fields.get("ro") === "true" ||
      fields.get("ro") === "1",
  };
}

function formatDeclaredCredentialMounts(
  credentialMounts: readonly BackendCredentialMount[],
): string {
  if (credentialMounts.length === 0) return "none";
  return credentialMounts
    .map(
      (mount) =>
        `${mount.name} (${mount.hostPath} -> ${mount.containerPath}${
          mount.readOnly ? ", read-only" : ", read-write"
        })`,
    )
    .join(", ");
}

/** Inputs to {@link createSpawnContainer}. */
export interface LaunchSpawnContainerInput {
  /** SpawnId — used to derive the container name and image tag. */
  readonly spawnId: string;
  /** Backend selected for this spawn. */
  readonly backend: SpawnBackend;
  /**
   * When set, the container is wired for telemetry: it gets a host-gateway
   * route + OTLP env vars, and the backend entrypoint is wrapped to emit a
   * `spawn.exec` span. Omit to keep the default no-egress sandbox posture.
   */
  readonly otel?: SpawnOtelContext;
}

export interface WaitForSpawnContainerResult {
  readonly exitCode: number;
}

/**
 * Invokes `docker create` for a single spawn against the image tag produced
 * by Story 4 (`march-spawn-<spawn-id>`), composing the security and resource
 * flags from {@link SPAWN_CONFIG} and the selected backend's entrypoint per
 * the contracts' Container Launch section.
 *
 * The argv composition is, in order:
 *
 * ```
 * create
 * --name march-spawn-<spawn-id>
 * --cap-drop=<cap> (per entry in SPAWN_CONFIG.capDrop; defaults to ["ALL"])
 * --user <SPAWN_CONFIG.user>
 * --memory <SPAWN_CONFIG.memoryLimit>
 * --cpus <SPAWN_CONFIG.cpuLimit>
 * --network <SPAWN_CONFIG.networkMode>
 * (-e <var> per entry in backend.requiredEnvVars — passthrough form)
 * (-e <var=value> and -v <source:target:ro> per backend credential mount)
 * <imageTag>
 * <backend.buildEntrypoint...>
 * ```
 *
 * `SPAWN_CONFIG.timeoutSeconds` is intentionally NOT emitted at this
 * stage — `waitForSpawnContainer` enforces the timeout per the Dispatch
 * Pipeline contract.
 *
 * Required env-vars are passed via `-e VAR` passthrough (Docker reads the
 * value from the operator's environment), not `-e VAR=<inlined>`. Credential
 * mount env-vars are explicit container-local values such as
 * `CODEX_HOME=/march/codex-home`; they never include host secrets.
 *
 * On success, returns the trimmed container ID captured from `docker create`
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
 * Before `docker create` is invoked at all, the fully composed argv is run
 * through {@link validateLaunchBindMounts}, so an undeclared host bind mount
 * is rejected without ever creating a container.
 *
 * @throws {LaunchError} If the composed argv carries a bind mount the selected
 * backend does not declare, or if `docker create` exits non-zero.
 */
export function createSpawnContainer(input: LaunchSpawnContainerInput): string {
  const { backend, spawnId } = input;
  const containerName = spawnContainerName(spawnId);
  const imageTag = spawnImageTag(spawnId);

  // Cap-drop flags derived from SPAWN_CONFIG.capDrop so the constant is
  // the single auditable source of truth for what's surfaced to docker
  // create. Combined `--cap-drop=<cap>` form matches the contracts' template.
  const capDropFlags = SPAWN_CONFIG.capDrop.map((cap) => `--cap-drop=${cap}`);

  const envFlags: string[] = [];
  for (const envVar of backend.requiredEnvVars) {
    // Passthrough form: `-e VAR` (no `=value`) so Docker reads the value
    // from the operator's environment at launch time.
    envFlags.push("-e", envVar);
  }

  const credentialMounts = resolveCredentialMounts(backend);
  const volumeFlags: string[] = [];
  for (const mount of credentialMounts) {
    const suffix = mount.readOnly ? ":ro" : "";
    volumeFlags.push("-v", `${mount.hostPath}:${mount.containerPath}${suffix}`);
    for (const [envVar, value] of Object.entries(mount.env)) {
      envFlags.push("-e", `${envVar}=${value}`);
    }
  }

  // Telemetry wiring (only when an OTEL context is supplied): a host-gateway
  // route + OTLP env so the in-container emitter can reach the collector, and a
  // wrapped entrypoint that emits the agent-run span.
  const hostFlags: string[] = [];
  let entrypoint = backend.buildEntrypoint(CONTAINER_PROMPT_PATH);
  if (input.otel) {
    hostFlags.push("--add-host", "host.docker.internal:host-gateway");
    envFlags.push(
      "-e",
      `OTEL_EXPORTER_OTLP_ENDPOINT=${input.otel.endpoint}`,
      "-e",
      `TRACEPARENT=${input.otel.traceparent}`,
      "-e",
      `OTEL_RESOURCE_ATTRIBUTES=${input.otel.resourceAttributes}`,
    );
    entrypoint = wrapEntrypointWithEmitter(entrypoint);
  }

  const args: string[] = [
    "create",
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
    ...hostFlags,
    ...volumeFlags,
    ...envFlags,
    imageTag,
    ...entrypoint,
  ];

  validateLaunchBindMounts(backend, args, credentialMounts, imageTag);

  let stdout: Buffer | string;
  try {
    stdout = execFileSync("docker", args, {
      // stdin is closed so docker doesn't block on TTY detection.
      // stdout is captured because `docker create` prints the container
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
    // never created the container (e.g. create failed during flag
    // validation), `docker rm -f` will exit non-zero — `removeSpawnContainer`
    // swallows that, so this never re-throws over the original error.
    try {
      removeSpawnContainer(spawnId);
    } catch {
      // intentionally ignored — see doc comment
    }
    throw new LaunchError(
      tail.length > 0
        ? `docker create failed for "${containerName}":\n${tail}`
        : `docker create failed for "${containerName}": ${(err as Error).message}`,
    );
  }

  // `docker create` prints the full container ID followed by a newline.
  const text = Buffer.isBuffer(stdout) ? stdout.toString("utf-8") : stdout;
  return text.trim();
}

export const launchSpawnContainer = createSpawnContainer;

export function copyPromptToContainer(
  containerId: string,
  prompt: string,
): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "march-spawn-prompt-"));
  const promptPath = path.join(tmpDir, "prompt.txt");
  try {
    fs.writeFileSync(promptPath, prompt, "utf-8");
    execFileSync("docker", ["cp", promptPath, `${containerId}:${CONTAINER_PROMPT_PATH}`], {
      stdio: ["ignore", "ignore", "pipe"],
      maxBuffer: DOCKER_OUTPUT_MAX_BUFFER,
    });
  } catch (err) {
    const tail = stderrTail((err as { stderr?: unknown }).stderr);
    throw new LaunchError(
      tail.length > 0
        ? `docker cp prompt failed for "${containerId}":\n${tail}`
        : `docker cp prompt failed for "${containerId}": ${(err as Error).message}`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Copy the in-container OTLP emitter script to {@link IN_SPAWN_EMITTER_PATH}.
 * Call after {@link copyPromptToContainer} and before {@link startSpawnContainer}
 * when launching with an OTEL context. Best-effort: a failure here leaves the
 * wrapped entrypoint to no-op (`node … 2>/dev/null || true`) without affecting
 * the spawn.
 */
export function copyOtelEmitterToContainer(containerId: string): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "march-spawn-otel-"));
  const scriptPath = path.join(tmpDir, "otel-emit.js");
  try {
    fs.writeFileSync(scriptPath, inSpawnEmitterScript(), "utf-8");
    execFileSync(
      "docker",
      ["cp", scriptPath, `${containerId}:${IN_SPAWN_EMITTER_PATH}`],
      {
        stdio: ["ignore", "ignore", "pipe"],
        maxBuffer: DOCKER_OUTPUT_MAX_BUFFER,
      },
    );
  } catch {
    // Best-effort — telemetry must never fail the spawn.
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function startSpawnContainer(containerId: string): void {
  try {
    execFileSync("docker", ["start", containerId], {
      stdio: ["ignore", "ignore", "pipe"],
      maxBuffer: DOCKER_OUTPUT_MAX_BUFFER,
    });
  } catch (err) {
    const tail = stderrTail((err as { stderr?: unknown }).stderr);
    throw new LaunchError(
      tail.length > 0
        ? `docker start failed for "${containerId}":\n${tail}`
        : `docker start failed for "${containerId}": ${(err as Error).message}`,
    );
  }
}

export function waitForSpawnContainer(
  containerId: string,
): WaitForSpawnContainerResult {
  let stdout: Buffer | string;
  try {
    stdout = execFileSync("docker", ["wait", containerId], {
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: DOCKER_OUTPUT_MAX_BUFFER,
      timeout: SPAWN_CONFIG.timeoutSeconds * 1000,
    });
  } catch (err) {
    if (isExecTimeout(err)) {
      forceRemoveContainer(containerId);
      throw new LaunchError(
        `docker wait timed out for "${containerId}" after ${SPAWN_CONFIG.timeoutSeconds}s; container was removed`,
      );
    }
    const tail = stderrTail((err as { stderr?: unknown }).stderr);
    throw new LaunchError(
      tail.length > 0
        ? `docker wait failed for "${containerId}":\n${tail}`
        : `docker wait failed for "${containerId}": ${(err as Error).message}`,
    );
  }

  const text = Buffer.isBuffer(stdout) ? stdout.toString("utf-8") : stdout;
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new LaunchError(
      `docker wait returned unexpected output for "${containerId}": ${JSON.stringify(text)}`,
    );
  }
  return { exitCode: Number.parseInt(trimmed, 10) };
}

function isExecTimeout(err: unknown): boolean {
  const e = err as {
    code?: unknown;
    errno?: unknown;
    killed?: unknown;
    signal?: unknown;
  };
  return (
    e.code === "ETIMEDOUT" ||
    e.errno === "ETIMEDOUT" ||
    e.killed === true ||
    e.signal === "SIGTERM"
  );
}

function forceRemoveContainer(containerId: string): void {
  try {
    execFileSync("docker", ["rm", "-f", containerId], {
      stdio: ["ignore", "ignore", "pipe"],
      maxBuffer: DOCKER_OUTPUT_MAX_BUFFER,
    });
  } catch {
    // Best-effort timeout cleanup; the timeout error remains the useful signal.
  }
}

/**
 * Bounds the synchronous `docker logs` read. Brood's `GET /sessions/:id/logs`
 * calls this from inside a Fastify handler, so an unresponsive daemon or
 * socket would otherwise block the event loop indefinitely and hang every
 * other Brood endpoint. A timeout kill surfaces through the `catch` below as
 * the contracted upstream read failure.
 */
const DOCKER_LOGS_TIMEOUT_MS = 15_000;

export function readSpawnContainerLogs(containerId: string): string {
  try {
    const stdout = execFileSync("docker", ["logs", containerId], {
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: DOCKER_OUTPUT_MAX_BUFFER,
      timeout: DOCKER_LOGS_TIMEOUT_MS,
    });
    return Buffer.isBuffer(stdout) ? stdout.toString("utf-8") : stdout;
  } catch (err) {
    const tail = stderrTail((err as { stderr?: unknown }).stderr);
    throw new LaunchError(
      tail.length > 0
        ? `docker logs failed for "${containerId}":\n${tail}`
        : `docker logs failed for "${containerId}": ${(err as Error).message}`,
    );
  }
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
