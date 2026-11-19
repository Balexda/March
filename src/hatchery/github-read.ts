import { execFile } from "node:child_process";
import { getGitHubToken, TesseraClientError } from "../tessera/client.js";

export class HatcheryGitHubError extends Error {
  constructor(readonly code: string, cause?: TesseraClientError) {
    super(`Hatchery GitHub read failed (${code})`, { cause });
    this.name = "HatcheryGitHubError";
  }
}

type Origin = { url: string; repo?: string };

export function hatcheryGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_ENTERPRISE_TOKEN;
  delete env.GITHUB_ENTERPRISE_TOKEN;
  delete env.MARCH_TESSERA_CLIENT_KEY;
  return env;
}

function git(cwd: string, args: string[], env = hatcheryGitEnv()) {
  return new Promise<{ code: number; stdout: string; unauthorized: boolean }>((resolve) => {
    execFile("git", args, {
      cwd, env, timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      // Git may stop to request credentials after a 401 without reporting the
      // HTTP code in its fatal message. Only inspect the redacted status lines.
      const statuses = [...stderr.matchAll(/<= Recv header: HTTP\/[\d.]+ (\d{3})\b/g)];
      resolve({
        code: error ? typeof error.code === "number" ? error.code : -1 : 0,
        stdout,
        unauthorized: !!error && (statuses.at(-1)?.[1] === "401" ||
          /requested URL returned error: 401\b/i.test(stderr)),
      });
    });
  });
}

export async function resolveHatcheryOrigin(cwd: string): Promise<Origin | undefined> {
  // Read the configured URL before Git applies any host URL rewrites.
  const result = await git(cwd, ["config", "--local", "--includes", "--get", "remote.origin.url"]);
  if (result.code === 1) return undefined;
  if (result.code !== 0) throw new HatcheryGitHubError("origin_lookup_failed");
  const url = result.stdout.trim();
  const github = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/github\.com\/)([a-z0-9-]+)\/([\w.-]+?)\/?$/i.exec(url);
  if (github) {
    const name = github[2].replace(/\.git$/i, "");
    if (!name || name === "." || name === "..") throw new HatcheryGitHubError("unsupported_origin");
    const repo = `${github[1]}/${name}`;
    return { repo, url: `https://github.com/${repo}.git` };
  }
  if (url && !url.startsWith("-") && (/^file:\/\/\//.test(url) || !url.includes(":"))) return { url };
  throw new HatcheryGitHubError("unsupported_origin");
}

async function withHatcheryGitHubRead<T>(
  repo: string,
  sliceId: string | undefined,
  operation: (token: string) => Promise<{ status: number; value: T }>,
): Promise<T> {
  const request = { repo, identity: "app", access: "read", sliceId } as const;
  try {
    const result = await operation((await getGitHubToken(request)).token);
    if (result.status !== 401) return result.value;
    return (await operation((await getGitHubToken({ ...request, refresh: true })).token)).value;
  } catch (error) {
    if (error instanceof TesseraClientError) throw new HatcheryGitHubError("tessera:" + error.code, error);
    throw error;
  }
}

export async function runHatcheryNetworkGit(
  cwd: string,
  origin: Origin,
  beforeUrl: string[],
  afterUrl: string[],
  sliceId?: string,
): Promise<number> {
  const run = async (token?: string) => {
    const env = hatcheryGitEnv();
    for (const key of Object.keys(env)) {
      if (/^(?:GIT_CONFIG|GIT_TRACE|GIT_CURL_VERBOSE)/.test(key)) delete env[key];
    }
    delete env.GIT_SSL_NO_VERIFY;
    const config = [
      ["credential.helper", ""],
      ["core.askPass", ""],
      ["http.extraHeader", ""],
      ["http.followRedirects", "false"],
      ["http.sslVerify", "true"],
    ];
    if (token) config.push([
      `http.${origin.url}.extraHeader`,
      `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    ]);
    Object.assign(env, {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: String(config.length),
      GIT_ALLOW_PROTOCOL: token ? "https" : "file",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/false",
      SSH_ASKPASS: "/bin/false",
    });
    if (token) Object.assign(env, {
      GIT_TRACE_CURL: "1",
      GIT_TRACE_CURL_NO_DATA: "1",
      GIT_TRACE_REDACT: "1",
    });
    config.forEach(([key, value], index) => {
      env[`GIT_CONFIG_KEY_${index}`] = key;
      env[`GIT_CONFIG_VALUE_${index}`] = value;
    });
    const result = await git(cwd, [...beforeUrl, origin.url, ...afterUrl], env);
    return { status: result.unauthorized ? 401 : 0, value: result.code };
  };
  return origin.repo ? withHatcheryGitHubRead(origin.repo, sliceId, run) : (await run()).value;
}

export async function readHatcheryGitHubJson(repo: string, resource: string, sliceId?: string): Promise<unknown> {
  return withHatcheryGitHubRead<{ ok: false } | { ok: true; body: unknown }>(repo, sliceId, async (token) => {
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}${resource}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status, value: { ok: false } as const };
      }
      // An incomplete list cannot establish that a branch has no open PR.
      if (response.headers.get("link")?.includes('rel="next"')) {
        await response.body?.cancel();
        throw new HatcheryGitHubError("incomplete_lookup");
      }
      return { status: response.status, value: { ok: true, body: await response.json() } as const };
    } catch (error) {
      if (error instanceof HatcheryGitHubError) throw error;
      throw new HatcheryGitHubError("lookup_failed");
    }
  }).then((result) => {
    if (!result.ok) throw new HatcheryGitHubError("lookup_failed");
    return result.body;
  });
}
