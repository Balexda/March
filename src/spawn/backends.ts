import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * In-container working directory declared by the generated spawn Dockerfile.
 * Backend entrypoints use this rather than relying on the image default.
 */
export const CONTAINER_WORKDIR = "/march/workspace";

/**
 * Sentinel prefix the deterministic spawn wrapper prints on a single stdout
 * line, followed by the base64-encoded `git diff <base>..HEAD`. Printed last
 * (after the agent exits) so it is contiguous and immune to any diff content —
 * no marker collision. `extractPatchFromSpawnOutput` decodes this instead of
 * scraping the agent's free-text message (which truncated on large patches and
 * produced the "corrupt patch" failure this scaffold removes).
 */
export const PATCH_SENTINEL = "__MARCH_PATCH_B64__";

/**
 * Wrap a backend's *agent command* in the deterministic git scaffold so the
 * worker produces its patch from a real container-local git repo rather than
 * hand-rendering a diff as text. The snapshot ships a flat file tree with no
 * `.git`, so the wrapper creates one, captures a base commit, runs the agent
 * (which now makes the change AND commits it), and emits the diff:
 *
 *   1. `git init` + a fixed identity, then commit the snapshot as the base.
 *   2. run the agent command inside a subshell; preserve its exit code.
 *   3. if the agent failed (non-zero), exit with its code — no patch.
 *   4. if `HEAD == base` but the tree is dirty, capture the uncommitted work so
 *      nothing is lost; if `HEAD == base` and the tree is clean, fail clearly
 *      (a real no-op) with exit 3.
 *   5. print `__MARCH_PATCH_B64__:<base64 of git diff base..HEAD>` last.
 *
 * `.gitignore` ships as a tracked file, so `git add -A` already excludes
 * `node_modules/`, `dist/`, etc. Both backends compose through this so the
 * scaffold lives in exactly one place.
 */
function composeGitScaffoldedEntrypoint(
  agentCommand: string,
): readonly string[] {
  const script = [
    `cd ${CONTAINER_WORKDIR}`,
    `git init -q`,
    `git config user.email "spawn@march.local"`,
    `git config user.name "March Spawn"`,
    `git add -A`,
    `git commit -q -m spawn-base --allow-empty >/dev/null 2>&1 || true`,
    `__march_base=$(git rev-parse HEAD)`,
    `( ${agentCommand} )`,
    `__march_rc=$?`,
    `if [ "$__march_rc" -ne 0 ]; then exit "$__march_rc"; fi`,
    `# Capture any edits the agent left uncommitted — even if it ALSO made a`,
    `# commit (e.g. it committed the main change, then ticked a tasks.md box or`,
    `# ran a formatter without amending). Running this unconditionally keeps`,
    `# those trailing edits in the diff instead of silently dropping them.`,
    `if [ -n "$(git status --porcelain)" ]; then`,
    `  git add -A && git commit -q -m "spawn: capture uncommitted changes"`,
    `fi`,
    `__march_head=$(git rev-parse HEAD)`,
    `if [ "$__march_head" = "$__march_base" ]; then`,
    `  echo "march-spawn: worker produced no commit and the worktree is clean" >&2`,
    `  exit 3`,
    `fi`,
    `__march_patch=$(git diff "$__march_base".."$__march_head" | base64 | tr -d '\\n')`,
    `# Lead with a newline so the sentinel always starts its own line even when`,
    `# the agent's final stdout did not end in one (otherwise the '^...' anchor`,
    `# in extractPatchFromSpawnOutput would miss it).`,
    `printf '\\n%s:%s\\n' '${PATCH_SENTINEL}' "$__march_patch"`,
  ].join("\n");
  return ["sh", "-c", script];
}

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
  readonly allowedEgressHosts: readonly string[];
}

export const claudeCodeBackend: SpawnBackend = {
  name: "claude-code",
  baseImage: "march-spawn-claude:latest",
  requiredEnvVars: ["ANTHROPIC_API_KEY"],
  credentialMounts: [],
  buildEntrypoint(promptFilePath: string): readonly string[] {
    return composeGitScaffoldedEntrypoint(
      `claude -p "$(cat ${promptFilePath})" --output-format json --dangerously-skip-permissions --bare --no-session-persistence`,
    );
  },
  allowedEgressHosts: ["api.anthropic.com"],
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
    // Keep the credential-mount `cp` prelude; the git scaffold wraps the whole
    // agent command. `--skip-git-repo-check` is now harmless (the scaffold
    // creates a real repo) but left in so the codex command is unchanged.
    return composeGitScaffoldedEntrypoint(
      `cp -R /march/codex-auth/. /march/codex-home/ && chmod -R u+rwX /march/codex-home && codex exec --json --ephemeral --ignore-rules --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --cd ${CONTAINER_WORKDIR} - < ${promptFilePath}`,
    );
  },
  allowedEgressHosts: ["chatgpt.com"],
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
