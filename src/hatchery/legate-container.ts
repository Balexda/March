import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI_VERSION } from "../shared/version.js";
import { BASE_IMAGE } from "./spawn-config.js";

export class HatcheryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HatcheryError";
  }
}

export const LEGATE_IMAGE_TAG = `march-legate:${CLI_VERSION}`;
export const LEGATE_DOCKERFILE_NAME = "Dockerfile";
export const LEGATE_CONTAINER_HOME = "/home/march";

const STDERR_TAIL_CHARS = 4_000;
const DOCKER_OUTPUT_MAX_BUFFER = 16 * 1024 * 1024;

const LEGATE_PASSTHROUGH_ENV = [
  "ANTHROPIC_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
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

export function renderLegateDockerfile(baseImage: string = BASE_IMAGE): string {
  return (
    `FROM ${baseImage}\n` +
    `USER root\n` +
    `RUN apt-get update \\\n` +
    ` && apt-get install -y --no-install-recommends bash ca-certificates git jq openssh-client python3 tmux \\\n` +
    ` && rm -rf /var/lib/apt/lists/*\n` +
    `RUN mkdir -p ${LEGATE_CONTAINER_HOME} /workspace && chmod 0777 ${LEGATE_CONTAINER_HOME} /workspace\n` +
    `WORKDIR /workspace\n`
  );
}

export function writeLegateDockerfile(
  contextPath: string,
  baseImage: string = BASE_IMAGE,
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

function addMountIfPresent(
  mounts: LegateContainerMount[],
  source: string,
  target: string = source,
  required = false,
): void {
  if (required || fs.existsSync(source)) {
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
  addMountIfPresent(
    mounts,
    path.join(input.homeDir, ".agent-deck"),
    path.join(LEGATE_CONTAINER_HOME, ".agent-deck"),
  );
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
  return mounts;
}

export interface LegateContainerRunArgsInput
  extends BuildLegateContainerArgsInput {
  readonly conductorName: string;
  readonly profile: string;
  readonly loopScriptPath?: string;
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

  args.push(
    imageTag,
    "sh",
    "-lc",
    input.loopScriptPath
      ? `printf 'March Legate loop starting: %s (%s)\\n' "$MARCH_LEGATE_CONDUCTOR" "$MARCH_LEGATE_PROFILE"; exec node ${JSON.stringify(input.loopScriptPath)}`
      : "printf 'March Legate container ready: %s (%s)\\n' \"$MARCH_LEGATE_CONDUCTOR\" \"$MARCH_LEGATE_PROFILE\"; trap 'exit 0' TERM INT; while :; do sleep 3600; done",
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
}

export function ensureLegateContainer(
  input: EnsureLegateContainerInput,
): LegateContainerResult {
  const imageTag = input.imageTag ?? LEGATE_IMAGE_TAG;
  const containerName = legateContainerName(input.conductorName);
  const contextPath = fs.mkdtempSync(path.join(os.tmpdir(), "march-legate-image-"));
  const dockerfilePath = writeLegateDockerfile(
    contextPath,
    input.baseImage ?? BASE_IMAGE,
  );

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
    };
  } finally {
    try {
      fs.rmSync(contextPath, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
}
