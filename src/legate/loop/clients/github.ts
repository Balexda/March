import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emitTesseraSpan } from "../../../observability/tessera-trace.js";
import { getGitHubToken, TesseraClientError } from "../../../tessera/client.js";
import type { GitHubTokenRequest } from "../../../tessera/types.js";
import { resolveOriginRepo } from "../../../shared/github-remote.js";
import { COPILOT_LOGIN } from "../../../observe/review-bot-comments.js";
import type { ReviewPostOutcome } from "../handlers/review-backoff.js";
import { execText } from "./exec.js";

export class LegateGitHubError extends Error {
  constructor(readonly status?: number, readonly retryAt?: string, readonly rateLimited = status === 429) {
    super(status ? `GitHub command failed (HTTP ${status})` : "GitHub command failed");
  }
}

async function resolveRepository(cwd: string | undefined, sliceId: string | undefined): Promise<string> {
  // Same origin-based rule observation uses (src/shared/github-remote.ts), so a
  // PR number sensed in one repository is never mutated in another.
  const repo = cwd ? await resolveOriginRepo(cwd) : null;
  if (repo) return repo;
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
    const code = status ? Number(status) : undefined;
    if (args[0] === "api" && args.includes("--include") && (code === 429 || code === 403)) {
      const stdout = (error as { stdout?: string }).stdout ?? "";
      const [headers, ...body] = stdout.split(/\r?\n\r?\n/);
      const retryAfter = /^retry-after:[ \t]*(.+)$/im.exec(headers)?.[1]?.trim();
      const remaining = /^x-ratelimit-remaining:[ \t]*(\d+)/im.exec(headers)?.[1];
      if (code === 429 || retryAfter || remaining === "0" || /secondary rate limit/i.test(body.join("\n"))) {
        const reset = /^x-ratelimit-reset:[ \t]*(\d+)/im.exec(headers)?.[1];
        const retryMs = /^\d+$/.test(retryAfter ?? "") ? Date.now() + Number(retryAfter) * 1000
          : retryAfter ? Date.parse(retryAfter) : remaining === "0" && reset ? Number(reset) * 1000 : NaN;
        throw new LegateGitHubError(code, Math.abs(retryMs) <= 8.64e15 ? new Date(retryMs).toISOString() : undefined, true);
      }
    }
    throw new LegateGitHubError(code);
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

/** Request Copilot with a slice-scoped Tessera user entitlement for this call only. */
export async function requestCopilotReview(repoPath: string, prNumber: number, sliceId: string): Promise<ReviewPostOutcome> {
  let token: string;
  try {
    token = await requestToken({ identity: "user", access: "write", sliceId });
  } catch {
    return { ok: false, kind: "identity_unavailable", detail: "Tessera user identity unavailable" };
  }
  try {
    const repo = await resolveRepository(repoPath, sliceId);
    await runScopedGh(repo, [
      "api", "--include", "--method", "POST", `repos/{owner}/{repo}/pulls/${prNumber}/requested_reviewers`,
      "-f", `reviewers[]=${COPILOT_LOGIN}[bot]`,
    ], repoPath, token);
    return { ok: true };
  } catch (error) {
    if (error instanceof LegateGitHubError && error.rateLimited) {
      return { ok: false, kind: "rate_limited", resetAt: error.retryAt };
    }
    return { ok: false, kind: "failed", detail: "GitHub review request failed" };
  }
}
