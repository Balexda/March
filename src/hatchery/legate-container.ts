import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_VERSION } from "../shared/version.js";

export class HatcheryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HatcheryError";
  }
}

export const LEGATE_IMAGE_TAG = `march-legate:${CLI_VERSION}`;
export const LEGATE_DOCKERFILE_NAME = "Dockerfile";
export const LEGATE_CONTAINER_HOME = "/home/march";

/**
 * Base image for the Legate loop container. Unlike spawn sandboxes (which run a
 * coding agent and use the heavier claude/codex bases), the loop container only
 * needs Node + a small toolchain it shells out to, so it builds from a stock
 * Node image and self-installs the rest. This deliberately does NOT use the
 * spawn BASE_IMAGE — the loop never runs claude in its own container.
 */
export const LEGATE_BASE_IMAGE = "node:22-bookworm-slim";

/** Where the baked march CLI lives inside the image. */
export const LEGATE_CLI_IMAGE_DIR = "/opt/march";
/** Sub-dir of the build context that carries the baked CLI artifacts. */
const LEGATE_CLI_CONTEXT_DIR = "march";
/** Port the loop HTTP service listens on inside the container. */
export const LEGATE_LOOP_CONTAINER_PORT = 8787;

/**
 * Deterministic loopback host port for a conductor's loop service. One container
 * per profile means they would otherwise all collide on a single host port, so
 * we hash the conductor name into 8800-9799. Deterministic so the legate-agent
 * can recompute where to reach its loop without discovery.
 */
export function legateLoopHostPort(conductorName: string): number {
  const digest = crypto.createHash("sha256").update(conductorName).digest();
  return 8800 + (digest.readUInt16BE(0) % 1000);
}

const STDERR_TAIL_CHARS = 4_000;
const DOCKER_OUTPUT_MAX_BUFFER = 16 * 1024 * 1024;

const LEGATE_PASSTHROUGH_ENV = [
  "ANTHROPIC_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  // Where the loop reaches the Hatchery SERVICE (it POSTs spawns over HTTP rather
  // than shelling out). From inside the container this must be reachable — e.g.
  // http://host.docker.internal:8080, or http://hatchery:8080 on the `march`
  // network. Defaults to http://localhost:8080 when unset.
  "MARCH_HATCHERY_URL",
  // Where the loop reaches CASTRA — the interactive-sessions service that fronts
  // agent-deck. The loop calls Castra's HTTP API (shared src/castra/client.ts)
  // for all session ops instead of mounting/shelling out to agent-deck, so
  // neither the binary nor ~/.agent-deck is mounted any more. CASTRA_URL must be
  // reachable from inside the container (e.g. http://host.docker.internal:9264 or
  // http://castra:9264 on the `march` net); CASTRA_API_TOKEN authorizes /v1/*.
  "CASTRA_URL",
  "CASTRA_API_TOKEN",
  // Observability: forwarded so emitters that read these at runtime ship spans +
  // metrics to the otel-lgtm stack. Each is `-e NAME` (value inherited from the
  // env), so an unset var is simply a no-op. From inside the container the
  // endpoint must be reachable — e.g. http://host.docker.internal:4318, or
  // otel-lgtm:4318 when the container is attached to the `march` network. The
  // loop's own spans use the endpoint frozen into meta at `march legate init`
  // time, so init must run with the same MARCH_OTEL_ENDPOINT the container uses.
  "MARCH_OTEL",
  "MARCH_OTEL_ENDPOINT",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "MARCH_OTEL_SERVICE_NAME",
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

export function legateContainerName(conductorName: string): string {
  return `march-legate-${conductorName}`;
}

export function renderLegateDockerfile(
  baseImage: string = LEGATE_BASE_IMAGE,
): string {
  return (
    `FROM ${baseImage}\n` +
    `USER root\n` +
    // Toolchain the deterministic loop shells out to every tick (git/gh for PR +
    // branch state, jq, python3, tmux/openssh for agent-deck-launched workers).
    // The loop no longer bind-mounts agent-deck — it reaches interactive sessions
    // through the Castra service over HTTP (see legateContainerMounts).
    `RUN apt-get update \\\n` +
    ` && apt-get install -y --no-install-recommends bash ca-certificates curl git gnupg jq openssh-client python3 tmux \\\n` +
    ` && rm -rf /var/lib/apt/lists/*\n` +
    // Seed GitHub's SSH host key so git-over-SSH (the common remote form) verifies
    // without an interactive prompt — the host's system known_hosts isn't mounted.
    `RUN ssh-keyscan -t rsa,ed25519 github.com >> /etc/ssh/ssh_known_hosts 2>/dev/null || true\n` +
    // gh CLI from its official apt repo (the loop reads PR/branch state via gh).
    `RUN mkdir -p -m 755 /etc/apt/keyrings \\\n` +
    ` && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \\\n` +
    ` && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \\\n` +
    ` && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \\\n` +
    ` && apt-get update && apt-get install -y --no-install-recommends gh \\\n` +
    ` && rm -rf /var/lib/apt/lists/*\n` +
    // Smithy CLI — the loop runs \`smithy status\` each tick to find ready work.
    `RUN npm install -g @balexda/smithy@latest && npm cache clean --force\n` +
    `RUN mkdir -p ${LEGATE_CONTAINER_HOME} /workspace && chmod 0777 ${LEGATE_CONTAINER_HOME} /workspace\n` +
    // Bake the CLI so the loop runs as `march legate loop` (a real service)
    // rather than a raw node script. tsup externalizes runtime deps, so the
    // bundle is NOT standalone — install production deps from the lockfile.
    // package.json rides along so version.ts + ESM resolution (type:module) work
    // from ${LEGATE_CLI_IMAGE_DIR}/dist/cli.js.
    `COPY ${LEGATE_CLI_CONTEXT_DIR}/ ${LEGATE_CLI_IMAGE_DIR}/\n` +
    `RUN cd ${LEGATE_CLI_IMAGE_DIR} \\\n` +
    ` && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \\\n` +
    ` && npm cache clean --force\n` +
    `RUN ln -sf ${LEGATE_CLI_IMAGE_DIR}/dist/cli.js /usr/local/bin/march \\\n` +
    ` && chmod +x ${LEGATE_CLI_IMAGE_DIR}/dist/cli.js\n` +
    `WORKDIR /workspace\n`
  );
}

/**
 * Locate the installed march package root (the dir holding both package.json and
 * dist/cli.js) by walking up from this module. Works whether running from the
 * bundled dist or from source. Throws if the CLI hasn't been built.
 */
export function locateMarchPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (
      fs.existsSync(path.join(dir, "package.json")) &&
      fs.existsSync(path.join(dir, "dist", "cli.js"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new HatcheryError(
    "Could not locate the built march CLI (dist/cli.js) to bake into the Legate " +
      "image. Run `npm run build` first.",
  );
}

/**
 * Copy the CLI bundle + package.json + lockfile (+ templates) into the image
 * build context so the Dockerfile can `npm ci --omit=dev` and bake `march`.
 */
function stageCliIntoContext(contextPath: string): void {
  const root = locateMarchPackageRoot();
  const dest = path.join(contextPath, LEGATE_CLI_CONTEXT_DIR);
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(path.join(root, "dist"), path.join(dest, "dist"), { recursive: true });
  fs.copyFileSync(path.join(root, "package.json"), path.join(dest, "package.json"));
  const lock = path.join(root, "package-lock.json");
  if (!fs.existsSync(lock)) {
    throw new HatcheryError(
      "Could not find package-lock.json to bake the Legate image's production " +
        "deps (npm ci). Run `npm install` to generate it.",
    );
  }
  fs.copyFileSync(lock, path.join(dest, "package-lock.json"));
  const templates = path.join(root, "src", "templates");
  if (fs.existsSync(templates)) {
    fs.cpSync(templates, path.join(dest, "src", "templates"), { recursive: true });
  }
}

export function writeLegateDockerfile(
  contextPath: string,
  baseImage: string = LEGATE_BASE_IMAGE,
): string {
  const dockerfilePath = path.join(contextPath, LEGATE_DOCKERFILE_NAME);
  fs.writeFileSync(dockerfilePath, renderLegateDockerfile(baseImage), {
    encoding: "utf-8",
  });
  return dockerfilePath;
}

export interface LegateContainerMount {
  readonly source: string;
  readonly target: string;
  readonly required?: boolean;
}

export interface BuildLegateContainerArgsInput {
  readonly repoPath: string;
  readonly conductorDir: string;
  readonly loopConductorDir?: string;
  readonly homeDir: string;
  readonly dockerSocketPath?: string;
}

/**
 * Build a `GIT_SSH_COMMAND` that points git's ssh at the mounted SSH keys by
 * absolute path — a workaround for Balexda/March#154: OpenSSH resolves `~/.ssh`
 * from the passwd database (the image user's home, e.g. /home/node), not `$HOME`,
 * so the keys we mount under {@link LEGATE_CONTAINER_HOME}/.ssh are otherwise
 * never found and git-over-SSH fails with "Permission denied (publickey)".
 * Returns null when no private keys are present. github's host key is seeded into
 * the image's system known_hosts, so only the identity needs pinning.
 */
export function gitSshCommandForMountedKeys(homeDir: string): string | null {
  const sshDir = path.join(homeDir, ".ssh");
  let entries: string[];
  try {
    entries = fs.readdirSync(sshDir);
  } catch {
    return null;
  }
  const keys = entries
    .filter((name) => /^id_/.test(name) && !name.endsWith(".pub"))
    // ed25519 first, then the rest, for a stable preferred order.
    .sort((a, b) =>
      (a.includes("ed25519") ? 0 : 1) - (b.includes("ed25519") ? 0 : 1) ||
      a.localeCompare(b),
    );
  if (keys.length === 0) return null;
  const identityArgs = keys
    .map((name) => `-i ${LEGATE_CONTAINER_HOME}/.ssh/${name}`)
    .join(" ");
  return `ssh -o IdentitiesOnly=yes ${identityArgs}`;
}

function addMountIfPresent(
  mounts: LegateContainerMount[],
  source: string,
  target: string = source,
  required = false,
): void {
  if ((required || fs.existsSync(source)) && !mounts.some((m) => m.target === target)) {
    mounts.push({ source, target, required });
  }
}

export function legateContainerMounts(
  input: BuildLegateContainerArgsInput,
): LegateContainerMount[] {
  const mounts: LegateContainerMount[] = [];
  addMountIfPresent(mounts, input.repoPath, input.repoPath, true);
  addMountIfPresent(mounts, input.conductorDir, input.conductorDir, true);
  if (input.loopConductorDir && input.loopConductorDir !== input.conductorDir) {
    addMountIfPresent(mounts, input.loopConductorDir, input.loopConductorDir, true);
  }
  addMountIfPresent(
    mounts,
    path.join(input.homeDir, ".march"),
    path.join(LEGATE_CONTAINER_HOME, ".march"),
  );
  // No ~/.agent-deck mount: the loop reaches agent-deck through Castra's HTTP API
  // now (Balexda/March#157), so neither the binary nor its config lives here.
  addMountIfPresent(
    mounts,
    path.join(input.homeDir, ".claude"),
    path.join(LEGATE_CONTAINER_HOME, ".claude"),
  );
  addMountIfPresent(
    mounts,
    path.join(input.homeDir, ".config", "gh"),
    path.join(LEGATE_CONTAINER_HOME, ".config", "gh"),
  );
  addMountIfPresent(
    mounts,
    path.join(input.homeDir, ".gitconfig"),
    path.join(LEGATE_CONTAINER_HOME, ".gitconfig"),
  );
  addMountIfPresent(
    mounts,
    path.join(input.homeDir, ".ssh"),
    path.join(LEGATE_CONTAINER_HOME, ".ssh"),
  );
  addMountIfPresent(
    mounts,
    input.dockerSocketPath ?? "/var/run/docker.sock",
    "/var/run/docker.sock",
  );
  const tmux = process.env.TMUX;
  const tmuxSocket = tmux?.split(",")[0];
  if (tmuxSocket) {
    addMountIfPresent(mounts, path.dirname(tmuxSocket), path.dirname(tmuxSocket));
  }
  if (typeof process.getuid === "function") {
    const defaultTmuxDir = path.join(os.tmpdir(), `tmux-${process.getuid()}`);
    addMountIfPresent(mounts, defaultTmuxDir, defaultTmuxDir);
  }
  return mounts;
}

export interface LegateContainerRunArgsInput
  extends BuildLegateContainerArgsInput {
  readonly conductorName: string;
  readonly profile: string;
  readonly imageTag?: string;
}

export function buildLegateContainerRunArgs(
  input: LegateContainerRunArgsInput,
): string[] {
  const imageTag = input.imageTag ?? LEGATE_IMAGE_TAG;
  const args = [
    "run",
    "-d",
    "--name",
    legateContainerName(input.conductorName),
    "--restart",
    "unless-stopped",
    "--workdir",
    input.loopConductorDir ?? input.conductorDir,
  ];

  if (typeof process.getuid === "function" && typeof process.getgid === "function") {
    args.push("--user", `${process.getuid()}:${process.getgid()}`);
  }

  for (const mount of legateContainerMounts(input)) {
    args.push(
      "--mount",
      `type=bind,src=${mount.source},dst=${mount.target}`,
    );
  }

  args.push(
    "-e",
    `HOME=${LEGATE_CONTAINER_HOME}`,
    "-e",
    "MARCH_LEGATE_CONTAINER=1",
    "-e",
    `MARCH_LEGATE_PROFILE=${input.profile}`,
    "-e",
    `MARCH_LEGATE_CONDUCTOR=${input.conductorName}`,
  );
  for (const envVar of LEGATE_PASSTHROUGH_ENV) {
    args.push("-e", envVar);
  }

  // Workaround for #154: make git-over-SSH find the mounted keys (ssh ignores
  // $HOME and uses the passwd home, where nothing is mounted).
  const gitSsh = gitSshCommandForMountedKeys(input.homeDir);
  if (gitSsh) {
    args.push("-e", `GIT_SSH_COMMAND=${gitSsh}`);
  }

  // Publish the loop HTTP API on a deterministic loopback host port so the
  // host-side legate-agent can reach it. Loopback only — never public.
  args.push(
    "-p",
    `127.0.0.1:${legateLoopHostPort(input.conductorName)}:${LEGATE_LOOP_CONTAINER_PORT}`,
  );

  // The loop now runs as a service (`march legate loop`) from the baked-in CLI,
  // reading legate-loop-meta.json from the workdir (the loop conductor dir).
  args.push(
    imageTag,
    "sh",
    "-lc",
    `printf 'March Legate loop starting: %s (%s)\\n' "$MARCH_LEGATE_CONDUCTOR" "$MARCH_LEGATE_PROFILE"; exec march legate loop`,
  );
  return args;
}

export interface EnsureLegateContainerInput extends LegateContainerRunArgsInput {
  readonly baseImage?: string;
}

export interface LegateContainerResult {
  readonly imageTag: string;
  readonly containerName: string;
  readonly containerId: string;
  readonly replaced: boolean;
  /** Loopback host port the loop's HTTP API is published on. */
  readonly hostPort: number;
}

export function ensureLegateContainer(
  input: EnsureLegateContainerInput,
): LegateContainerResult {
  const imageTag = input.imageTag ?? LEGATE_IMAGE_TAG;
  const containerName = legateContainerName(input.conductorName);
  const contextPath = fs.mkdtempSync(path.join(os.tmpdir(), "march-legate-image-"));
  const dockerfilePath = writeLegateDockerfile(
    contextPath,
    input.baseImage ?? LEGATE_BASE_IMAGE,
  );
  stageCliIntoContext(contextPath);

  try {
    try {
      execFileSync(
        "docker",
        ["build", "-t", imageTag, "-f", dockerfilePath, contextPath],
        {
          stdio: ["ignore", "ignore", "pipe"],
          maxBuffer: DOCKER_OUTPUT_MAX_BUFFER,
        },
      );
    } catch (err) {
      const tail = stderrTail((err as { stderr?: unknown }).stderr);
      throw new HatcheryError(
        tail.length > 0
          ? `docker build failed for "${imageTag}":\n${tail}`
          : `docker build failed for "${imageTag}": ${(err as Error).message}`,
      );
    }

    let replaced = false;
    try {
      execFileSync("docker", ["rm", "-f", containerName], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      replaced = true;
    } catch {
      replaced = false;
    }

    let stdout: Buffer | string;
    try {
      stdout = execFileSync(
        "docker",
        buildLegateContainerRunArgs({ ...input, imageTag }),
        {
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: DOCKER_OUTPUT_MAX_BUFFER,
        },
      );
    } catch (err) {
      const tail = stderrTail((err as { stderr?: unknown }).stderr);
      throw new HatcheryError(
        tail.length > 0
          ? `docker run failed for "${containerName}":\n${tail}`
          : `docker run failed for "${containerName}": ${(err as Error).message}`,
      );
    }

    const text = Buffer.isBuffer(stdout) ? stdout.toString("utf-8") : stdout;
    return {
      imageTag,
      containerName,
      containerId: text.trim(),
      replaced,
      hostPort: legateLoopHostPort(input.conductorName),
    };
  } finally {
    try {
      fs.rmSync(contextPath, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
}
