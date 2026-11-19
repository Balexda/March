import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emitTesseraSpan } from "../../../observability/tessera-trace.js";
import { getGitHubToken, TesseraClientError } from "../../../tessera/client.js";
import type { GitHubTokenRequest } from "../../../tessera/types.js";
import { execText } from "./exec.js";

const remotePattern = /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)\/?$/i;

export class LegateGitHubError extends Error {
  constructor(readonly status?: number) {
    super(status ? `GitHub command failed (HTTP ${status})` : "GitHub command failed");
  }
}

async function resolveRepository(cwd: string | undefined, sliceId: string | undefined): Promise<string> {
  try {
    if (cwd) {
      const remote = await execText("git", ["config", "--local", "--get", "remote.origin.url"], {
        cwd, timeout: 5_000, killSignal: "SIGKILL",
      });
      const repo = remote.trim().match(remotePattern)?.[1].replace(/\.git$/i, "");
      if (repo && repo.split("/").every(part => part && part !== "." && part !== "..")) return repo;
    }
  } catch {
    // The local git diagnostic can contain checkout or remote configuration.
  }
  emitTesseraSpan("tessera.discovery", { sliceId, error: true, attributes: { "march.service": "legate" } });
  throw new TesseraClientError("invalid_request");
}

async function requestToken(req: GitHubTokenRequest): Promise<string> {
  const span = {
    sliceId: req.sliceId, startTimeMs: Date.now(),
    attributes: { "march.service": "legate", "tessera.access": req.access },
  };
  try {
    const { token } = await getGitHubToken(req);
    if (/[\s\0]/.test(token)) throw new TesseraClientError("invalid_response");
    emitTesseraSpan("tessera.issue", span);
    return token;
  } catch (error) {
    emitTesseraSpan("tessera.issue", { ...span, error: true });
    throw error;
  }
}

async function runScopedGh(repo: string, args: string[], cwd: string | undefined, token: string): Promise<string> {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "march-legate-gh-"));
  try {
    const env = { ...process.env };
    for (const key of ["GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
      "GH_DEBUG", "DEBUG", "MARCH_TESSERA_CLIENT_KEY"]) delete env[key];
    Object.assign(env, {
      GH_TOKEN: token, GH_CONFIG_DIR: configDir, GH_HOST: "github.com",
      GH_REPO: repo, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1",
    });
    const scopedArgs = args[0] === "api"
      ? args.map(arg => arg.replace(/^repos\/\{owner\}\/\{repo\}\//, `repos/${repo}/`))
      : [...args, "--repo", repo];
    return await execText("gh", scopedArgs, { cwd, env, timeout: 30_000, killSignal: "SIGKILL" });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    const status = /^gh: [^\r\n]*\(HTTP (\d{3})\)\s*$/m.exec(stderr)?.[1]
      ?? /^(?:gh: )?HTTP (\d{3})(?=[:\s]|$)/m.exec(stderr)?.[1];
    throw new LegateGitHubError(status ? Number(status) : undefined);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

export async function execLegateGh(
  access: GitHubTokenRequest["access"],
  args: string[],
  cwd?: string,
  sliceId?: string,
): Promise<string> {
  const repo = await resolveRepository(cwd, sliceId);
  const req: GitHubTokenRequest = { repo, access, identity: "app", sliceId };
  const token = await requestToken(req);
  try {
    return await runScopedGh(repo, args, cwd, token);
  } catch (error) {
    if (!(error instanceof LegateGitHubError) || error.status !== 401) throw error;
  }
  return runScopedGh(repo, args, cwd, await requestToken({ ...req, refresh: true }));
}
