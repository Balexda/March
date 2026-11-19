import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startHeraldSpan } from "../observability/herald-trace.js";
import { TesseraClientError, type TesseraClient } from "../tessera/client.js";

export type GitHubReadClient = Pick<TesseraClient, "issueGitHubToken">;
class GitHubReadError extends Error {
  constructor(readonly status?: 401) {
    super(status ? "GitHub read rejected the credential" : "GitHub read failed");
  }
}

type Run = (command: string, args: string[], options: Record<string, unknown>) => Promise<string>;

// System trust anchors for the credentialed git transport. Pinned on the command
// line so checkout-local `http.ssl*` settings cannot replace them.
const CA_BUNDLES = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
  "/etc/ssl/cert.pem",
];

// gh reports a rejected credential either as `… (HTTP 401)` or, from its HTTP
// error formatter, as a line starting `HTTP 401: …`.
const GH_UNAUTHORIZED = [/\(HTTP 401\)/, /^(?:gh: )?HTTP 401: /m];

// Git reports a rejected credential in several forms depending on whether it
// re-enters its authentication path (helpers and prompts are disabled here).
const GIT_UNAUTHORIZED = [
  /^fatal: unable to access .*: The requested URL returned error: 401\s*$/m,
  /^fatal: Authentication failed for '[^']*'\s*$/m,
  /^fatal: could not read (?:Username|Password) for '[^']*': (?:terminal prompts disabled|No such device or address)\s*$/m,
];

export function repoFromOrigin(remote: string): string | undefined {
  return /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i
    .exec(remote.trim())?.[1];
}

export function createGitHubRead(client: GitHubReadClient, parentEnv: NodeJS.ProcessEnv, run: Run) {
  const cleanEnv = Object.fromEntries(Object.entries(parentEnv).filter(([name]) =>
    !/^(?:GH_|GITHUB_|GIT_|MARCH_TESSERA_CLIENT_KEY$|MARCH_GIT_AUTH_HEADER$)/i.test(name)));
  const timeout = 30_000;

  async function scoped(
    repo: string | null,
    sliceId: string | undefined,
    invoke: (token: string) => Promise<string>,
  ): Promise<string> {
    const span = startHeraldSpan({ name: "herald.github.read", dispatchKey: sliceId });

    async function issue(refresh?: true) {
      if (!repo) throw new TesseraClientError("github_repo_unavailable");
      const { token } = await client.issueGitHubToken({ identity: "app", access: "read", repo, sliceId, refresh });
      if (/\s/.test(token)) throw new TesseraClientError("invalid_response");
      return token;
    }
    let failed = true;
    try {
      const token = await issue();
      try {
        const result = await invoke(token);
        failed = false;
        return result;
      } catch (err) {
        if (!(err instanceof GitHubReadError) || err.status !== 401) throw err;
        const result = await invoke(await issue(true));
        failed = false;
        return result;
      }
    } finally {
      span.end({ error: failed });
    }
  }

  async function command(name: "gh" | "git", args: string[], options: Record<string, unknown>) {
    try {
      return await run(name, args, { ...options, timeout, killSignal: "SIGKILL" });
    } catch (err) {
      // Match status diagnostics, never a bare 401 in arbitrary output.
      const stderr = (err as { stderr?: string })?.stderr ?? "";
      const unauthorized = name === "gh"
        ? GH_UNAUTHORIZED.some((pattern) => pattern.test(stderr))
        : GIT_UNAUTHORIZED.some((pattern) => pattern.test(stderr));
      throw new GitHubReadError(unauthorized ? 401 : undefined);
    }
  }

  return {
    gh(repo: string | null, args: string[], sliceId?: string) {
      return scoped(repo, sliceId, async (token) => {
        const config = await mkdtemp(join(tmpdir(), "march-herald-gh-")).catch(() => {
          throw new TesseraClientError("github_config_failed");
        });
        try {
          return await command("gh", args, {
            env: { ...cleanEnv, GH_CONFIG_DIR: config, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_TOKEN: token },
          });
        } finally {
          await rm(config, { recursive: true, force: true });
        }
      });
    },
    async git(repo: string | null, cwd: string, args: string[], ref: string) {
      if (!repo) throw new TesseraClientError("github_repo_unavailable");
      const url = `https://github.com/${repo}.git`;
      const env = {
        ...cleanEnv,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/false",
        GIT_ALLOW_PROTOCOL: "https",
      };
      // Local insteadOf rules still apply to literal URLs. Check the effective
      // destination before giving the transport its repository credential.
      if ((await command("git", ["ls-remote", "--get-url", url], { cwd, env })).trim() !== url) {
        throw new TesseraClientError("github_remote_rewritten");
      }
      const caInfo = CA_BUNDLES.find((path) => existsSync(path));
      if (!caInfo) throw new TesseraClientError("github_tls_unavailable");
      const config = [
        "-c", "credential.helper=",
        "-c", "http.sslVerify=true",
        "-c", `http.${url}.sslVerify=true`,
        "-c", `http.sslCAInfo=${caInfo}`,
        "-c", `http.${url}.sslCAInfo=${caInfo}`,
        "-c", `http.sslCAPath=${dirname(caInfo)}`,
        "-c", `http.${url}.sslCAPath=${dirname(caInfo)}`,
        "-c", "core.hooksPath=/dev/null",
        "-c", "http.followRedirects=false",
        "-c", `http.${url}.followRedirects=false`,
        "-c", "http.extraHeader=",
        "-c", `http.${url}.extraHeader=`,
        "--config-env", `http.${url}.extraHeader=MARCH_GIT_AUTH_HEADER`,
      ];
      return scoped(repo, undefined, (token) => command("git", [...config, ...args, "--", url, ref], {
        cwd,
        env: { ...env, MARCH_GIT_AUTH_HEADER: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` },
      }));
    },
  };
}
