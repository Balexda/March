import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE_IMAGE } from "../hatchery/spawn-config.js";
import {
  CASTRA_CONTAINER_HOME,
  CASTRA_CONTAINER_NAME,
  CASTRA_DOCKERFILE_NAME,
  CASTRA_IMAGE_TAG,
  CASTRA_SERVICE_NAME,
  castraPort,
} from "./config.js";

/**
 * Builds and runs the single shared Castra container. Mirrors
 * `src/hatchery/legate-container.ts`: agent-deck/tmux now live in exactly one
 * place — here — and consumers reach the API over HTTP instead of mounting
 * agent-deck themselves.
 */

export class CastraContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CastraContainerError";
  }
}

const STDERR_TAIL_CHARS = 4_000;
const DOCKER_OUTPUT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * The shared March docker network. Declared by the otel-lgtm compose stack, but
 * `docker run --network march` fails if it doesn't already exist, so Castra
 * ensures it (create-if-missing) rather than depending on compose start order.
 */
export const MARCH_NETWORK = "march";

// Forwarded by name (value inherited from the host env; unset → no-op). The
// service name is set explicitly below, not passed through, so Castra telemetry
// is always tagged march-castra regardless of the host's MARCH_OTEL_SERVICE_NAME.
const CASTRA_PASSTHROUGH_ENV = [
  "ANTHROPIC_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "CASTRA_API_TOKEN",
  "MARCH_OTEL",
  "MARCH_OTEL_ENDPOINT",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
] as const;

function stderrTail(stderr: unknown): string {
  let text: string;
  if (Buffer.isBuffer(stderr)) text = stderr.toString("utf-8");
  else if (typeof stderr === "string") text = stderr;
  else if (stderr == null) text = "";
  else text = String(stderr);
  text = text.trimEnd();
  if (text.length <= STDERR_TAIL_CHARS) return text;
  return "..." + text.slice(-STDERR_TAIL_CHARS);
}

export function renderCastraDockerfile(baseImage: string = BASE_IMAGE): string {
  return (
    `FROM ${baseImage}\n` +
    `USER root\n` +
    `RUN apt-get update \\\n` +
    ` && apt-get install -y --no-install-recommends bash ca-certificates git jq openssh-client python3 tmux \\\n` +
    ` && rm -rf /var/lib/apt/lists/*\n` +
    `RUN mkdir -p ${CASTRA_CONTAINER_HOME} && chmod 0777 ${CASTRA_CONTAINER_HOME}\n` +
    `WORKDIR ${CASTRA_CONTAINER_HOME}\n`
  );
}

export function writeCastraDockerfile(
  contextPath: string,
  baseImage: string = BASE_IMAGE,
): string {
  const dockerfilePath = path.join(contextPath, CASTRA_DOCKERFILE_NAME);
  fs.writeFileSync(dockerfilePath, renderCastraDockerfile(baseImage), { encoding: "utf-8" });
  return dockerfilePath;
}

export interface CastraContainerMount {
  readonly source: string;
  readonly target: string;
  readonly required?: boolean;
}

export interface BuildCastraContainerArgsInput {
  /**
   * The March install root on the host (the package dir containing `dist/` and
   * `node_modules/`). Mounted at the same absolute path and run with `node`, so
   * the in-container CLI is the same build the operator invoked.
   */
  readonly marchInstallDir: string;
  readonly homeDir: string;
  readonly port?: number;
  /**
   * Repos (and their worktree-parent dirs) to bind at IDENTICAL absolute paths,
   * so worktrees agent-deck creates line up with the host and spawn containers
   * (path parity — agent-deck is relocated, not re-homed).
   */
  readonly repoPaths?: readonly string[];
  readonly dockerSocketPath?: string;
  readonly imageTag?: string;
}

function addMountIfPresent(
  mounts: CastraContainerMount[],
  source: string,
  target: string = source,
  required = false,
): void {
  if ((required || fs.existsSync(source)) && !mounts.some((m) => m.target === target)) {
    mounts.push({ source, target, required });
  }
}

export function castraContainerMounts(
  input: BuildCastraContainerArgsInput,
): CastraContainerMount[] {
  const mounts: CastraContainerMount[] = [];
  // The CLI bundle + node_modules, at the same path so `node <dir>/dist/cli.js` resolves.
  addMountIfPresent(mounts, input.marchInstallDir, input.marchInstallDir, true);
  // The one agent-deck install/state, plus the credentials launched sessions need.
  addMountIfPresent(
    mounts,
    path.join(input.homeDir, ".agent-deck"),
    path.join(CASTRA_CONTAINER_HOME, ".agent-deck"),
  );
  addMountIfPresent(
    mounts,
    path.join(input.homeDir, ".claude"),
    path.join(CASTRA_CONTAINER_HOME, ".claude"),
  );
  addMountIfPresent(
    mounts,
    path.join(input.homeDir, ".config", "gh"),
    path.join(CASTRA_CONTAINER_HOME, ".config", "gh"),
  );
  addMountIfPresent(
    mounts,
    path.join(input.homeDir, ".gitconfig"),
    path.join(CASTRA_CONTAINER_HOME, ".gitconfig"),
  );
  addMountIfPresent(
    mounts,
    path.join(input.homeDir, ".ssh"),
    path.join(CASTRA_CONTAINER_HOME, ".ssh"),
  );
  addMountIfPresent(
    mounts,
    path.join(input.homeDir, ".march"),
    path.join(CASTRA_CONTAINER_HOME, ".march"),
  );
  addMountIfPresent(mounts, input.dockerSocketPath ?? "/var/run/docker.sock", "/var/run/docker.sock");
  const tmuxSocket = process.env.TMUX?.split(",")[0];
  if (tmuxSocket) {
    addMountIfPresent(mounts, path.dirname(tmuxSocket), path.dirname(tmuxSocket));
  }
  if (typeof process.getuid === "function") {
    const defaultTmuxDir = path.join(os.tmpdir(), `tmux-${process.getuid()}`);
    addMountIfPresent(mounts, defaultTmuxDir, defaultTmuxDir);
  }
  // Repo + worktree-parent dirs at identical paths (path parity).
  for (const repoPath of input.repoPaths ?? []) {
    addMountIfPresent(mounts, repoPath, repoPath);
  }
  return mounts;
}

export function castraCliEntry(marchInstallDir: string): string {
  return path.join(marchInstallDir, "dist", "cli.js");
}

export function buildCastraContainerRunArgs(input: BuildCastraContainerArgsInput): string[] {
  const imageTag = input.imageTag ?? CASTRA_IMAGE_TAG;
  const port = input.port ?? castraPort();
  const args = [
    "run",
    "-d",
    "--name",
    CASTRA_CONTAINER_NAME,
    "--restart",
    "unless-stopped",
    "--network",
    MARCH_NETWORK,
    "--publish",
    `127.0.0.1:${port}:${port}`,
    "--workdir",
    input.marchInstallDir,
  ];

  if (typeof process.getuid === "function" && typeof process.getgid === "function") {
    args.push("--user", `${process.getuid()}:${process.getgid()}`);
  }

  for (const mount of castraContainerMounts(input)) {
    args.push("--mount", `type=bind,src=${mount.source},dst=${mount.target}`);
  }

  args.push(
    "-e",
    `HOME=${CASTRA_CONTAINER_HOME}`,
    "-e",
    "MARCH_CASTRA_CONTAINER=1",
    "-e",
    `CASTRA_PORT=${port}`,
    // Explicit (not passthrough) so Castra telemetry is always march-castra.
    "-e",
    `MARCH_OTEL_SERVICE_NAME=${CASTRA_SERVICE_NAME}`,
  );
  for (const envVar of CASTRA_PASSTHROUGH_ENV) {
    args.push("-e", envVar);
  }

  const cliEntry = castraCliEntry(input.marchInstallDir);
  args.push(
    imageTag,
    "sh",
    "-lc",
    `printf 'March Castra starting on :%s\\n' "$CASTRA_PORT"; ` +
      `exec node ${JSON.stringify(cliEntry)} castra serve --port ${port} --host 0.0.0.0`,
  );
  return args;
}

/**
 * Ensure the shared `march` docker network exists, creating it if absent. A
 * no-op when otel-lgtm (or a previous run) already created it. Idempotent.
 */
export function ensureMarchNetwork(): void {
  try {
    execFileSync("docker", ["network", "inspect", MARCH_NETWORK], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    return; // already exists
  } catch {
    // fall through to create
  }
  try {
    execFileSync("docker", ["network", "create", MARCH_NETWORK], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    const tail = stderrTail((err as { stderr?: unknown }).stderr);
    throw new CastraContainerError(
      tail.length > 0
        ? `failed to create docker network "${MARCH_NETWORK}":\n${tail}`
        : `failed to create docker network "${MARCH_NETWORK}": ${(err as Error).message}`,
    );
  }
}

export interface EnsureCastraContainerInput extends BuildCastraContainerArgsInput {
  readonly baseImage?: string;
}

export interface CastraContainerResult {
  readonly imageTag: string;
  readonly containerName: string;
  readonly containerId: string;
  readonly port: number;
  readonly replaced: boolean;
}

export function ensureCastraContainer(
  input: EnsureCastraContainerInput,
): CastraContainerResult {
  const imageTag = input.imageTag ?? CASTRA_IMAGE_TAG;
  const port = input.port ?? castraPort();
  const contextPath = fs.mkdtempSync(path.join(os.tmpdir(), "march-castra-image-"));
  const dockerfilePath = writeCastraDockerfile(contextPath, input.baseImage ?? BASE_IMAGE);

  // The container joins --network march; ensure it exists before `docker run`,
  // which would otherwise fail when otel-lgtm hasn't created it.
  ensureMarchNetwork();

  try {
    try {
      execFileSync("docker", ["build", "-t", imageTag, "-f", dockerfilePath, contextPath], {
        stdio: ["ignore", "ignore", "pipe"],
        maxBuffer: DOCKER_OUTPUT_MAX_BUFFER,
      });
    } catch (err) {
      const tail = stderrTail((err as { stderr?: unknown }).stderr);
      throw new CastraContainerError(
        tail.length > 0
          ? `docker build failed for "${imageTag}":\n${tail}`
          : `docker build failed for "${imageTag}": ${(err as Error).message}`,
      );
    }

    let replaced = false;
    try {
      execFileSync("docker", ["rm", "-f", CASTRA_CONTAINER_NAME], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      replaced = true;
    } catch {
      replaced = false;
    }

    let stdout: Buffer | string;
    try {
      stdout = execFileSync("docker", buildCastraContainerRunArgs({ ...input, imageTag, port }), {
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: DOCKER_OUTPUT_MAX_BUFFER,
      });
    } catch (err) {
      const tail = stderrTail((err as { stderr?: unknown }).stderr);
      throw new CastraContainerError(
        tail.length > 0
          ? `docker run failed for "${CASTRA_CONTAINER_NAME}":\n${tail}`
          : `docker run failed for "${CASTRA_CONTAINER_NAME}": ${(err as Error).message}`,
      );
    }

    const text = Buffer.isBuffer(stdout) ? stdout.toString("utf-8") : stdout;
    return {
      imageTag,
      containerName: CASTRA_CONTAINER_NAME,
      containerId: text.trim(),
      port,
      replaced,
    };
  } finally {
    try {
      fs.rmSync(contextPath, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
}
