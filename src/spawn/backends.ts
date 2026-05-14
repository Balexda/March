import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * In-container working directory declared by the generated spawn Dockerfile.
 * Backend entrypoints use this rather than relying on the image default.
 */
export const CONTAINER_WORKDIR = "/march/workspace";

export interface BackendCredentialMount {
  readonly hostPath: string;
  readonly containerPath: string;
  readonly readOnly: boolean;
  readonly env: Readonly<Record<string, string>>;
}

export interface BackendCredentialMountSpec {
  readonly name: string;
  readonly containerPath: string;
  readonly readOnly: boolean;
  readonly resolveHostPath: (env: NodeJS.ProcessEnv) => string;
  readonly env: Readonly<Record<string, string>>;
}

export interface SpawnBackend {
  readonly name: string;
  readonly baseImage: string;
  readonly requiredEnvVars: readonly string[];
  readonly credentialMounts: readonly BackendCredentialMountSpec[];
  buildEntrypoint(promptFilePath: string): readonly string[];
}

export const claudeCodeBackend: SpawnBackend = {
  name: "claude-code",
  baseImage: "march-spawn-claude:latest",
  requiredEnvVars: ["ANTHROPIC_API_KEY"],
  credentialMounts: [],
  buildEntrypoint(promptFilePath: string): readonly string[] {
    return [
      "sh",
      "-c",
      `claude -p "$(cat ${promptFilePath})" --output-format json --dangerously-skip-permissions --bare --no-session-persistence`,
    ];
  },
};

export const codexBackend: SpawnBackend = {
  name: "codex",
  baseImage: "march-spawn-codex:latest",
  requiredEnvVars: [],
  credentialMounts: [
    {
      name: "Codex credential directory",
      containerPath: "/march/codex-auth",
      readOnly: true,
      resolveHostPath(env: NodeJS.ProcessEnv): string {
        return env.CODEX_HOME && env.CODEX_HOME.length > 0
          ? env.CODEX_HOME
          : path.join(env.HOME && env.HOME.length > 0 ? env.HOME : os.homedir(), ".codex");
      },
      env: {
        CODEX_HOME: "/march/codex-home",
      },
    },
  ],
  buildEntrypoint(promptFilePath: string): readonly string[] {
    return [
      "sh",
      "-c",
      `cp -R /march/codex-auth/. /march/codex-home/ && chmod -R u+rwX /march/codex-home && codex exec --json --ephemeral --ignore-rules --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --cd ${CONTAINER_WORKDIR} - < ${promptFilePath}`,
    ];
  },
};

const BACKENDS: Readonly<Record<string, SpawnBackend>> = {
  [claudeCodeBackend.name]: claudeCodeBackend,
  [codexBackend.name]: codexBackend,
};

export const defaultBackendName = claudeCodeBackend.name;

export function listBackends(): readonly string[] {
  return Object.keys(BACKENDS);
}

export function getBackend(name: string): SpawnBackend | undefined {
  return BACKENDS[name];
}

export type BackendSelectionSource = "default" | "flag" | "env";

export interface ResolveBackendSelectionInput {
  readonly flagValue?: string;
  readonly envValue?: string;
}

export interface ResolveBackendSelectionResult {
  readonly requestedName: string;
  readonly source: BackendSelectionSource;
  readonly backend?: SpawnBackend;
}

export function resolveBackendSelection(
  input: ResolveBackendSelectionInput,
): ResolveBackendSelectionResult {
  const flagValue = input.flagValue?.trim();
  if (flagValue) {
    return {
      requestedName: flagValue,
      source: "flag",
      backend: getBackend(flagValue),
    };
  }

  const envValue = input.envValue?.trim();
  if (envValue) {
    return {
      requestedName: envValue,
      source: "env",
      backend: getBackend(envValue),
    };
  }

  return {
    requestedName: defaultBackendName,
    source: "default",
    backend: getBackend(defaultBackendName),
  };
}

export function resolveCredentialMounts(
  backend: SpawnBackend,
  env: NodeJS.ProcessEnv = process.env,
): readonly BackendCredentialMount[] {
  return backend.credentialMounts.map((mount) => ({
    hostPath: mount.resolveHostPath(env),
    containerPath: mount.containerPath,
    readOnly: mount.readOnly,
    env: mount.env,
  }));
}

export function missingRequiredEnvVars(
  backend: SpawnBackend,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  return backend.requiredEnvVars.filter((envVar) => !env[envVar]);
}

export function missingCredentialMounts(
  backend: SpawnBackend,
  env: NodeJS.ProcessEnv = process.env,
): readonly BackendCredentialMount[] {
  return resolveCredentialMounts(backend, env).filter(
    (mount) => !isReadableDirectory(mount.hostPath),
  );
}

function isReadableDirectory(hostPath: string): boolean {
  try {
    const stat = fs.statSync(hostPath);
    if (!stat.isDirectory()) return false;
    fs.accessSync(hostPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
