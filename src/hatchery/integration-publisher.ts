import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TesseraClient } from "../tessera/client.js";
import { hatcheryGitEnv, resolveHatcheryOrigin, runScopedNetworkGit } from "./github-read.js";
import type { StewardHandoffInput } from "./spawn-handoff.js";

export interface IntegrationCommit {
  readonly spawnId: string;
  readonly branch: string;
  readonly commitSha: string;
  readonly patchSha256: string;
  readonly committedAt: string;
}

interface Target {
  readonly target: string;
  readonly branchRef: string;
}

export interface PublicationFailure {
  readonly failureReason: "commit_failed" | "push_failed" | "timeout";
  readonly spawnId: string;
  readonly branch: string;
  readonly patchSha256: string;
  readonly commit?: IntegrationCommit;
}

export class IntegrationPublicationError extends Error {
  constructor(readonly publication: PublicationFailure) {
    super(`Steward publication failed (${publication.failureReason})`);
    this.name = "IntegrationPublicationError";
  }
}

function git(cwd: string, args: string[], options?: { index?: string; input?: string }): string {
  const env = {
    ...hatcheryGitEnv(),
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "March Steward",
    GIT_AUTHOR_EMAIL: "march-steward@users.noreply.github.com",
    GIT_COMMITTER_NAME: "March Steward",
    GIT_COMMITTER_EMAIL: "march-steward@users.noreply.github.com",
    ...(options?.index ? { GIT_INDEX_FILE: options.index } : {}),
  };
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd, env, input: options?.input, encoding: "utf-8",
    stdio: [options?.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: 1024 * 1024, timeout: 5_000, killSignal: "SIGKILL",
  }).trimEnd();
}

function message(handoff: StewardHandoffInput): string {
  return [
    "Integrate validated spawn changes",
    "",
    `March-Spawn-Id: ${handoff.spawnId}`,
    `March-Patch-SHA256: ${handoff.patchSha256}`,
  ].join("\n");
}

function expectedTree(cwd: string, base: string, handoff: StewardHandoffInput): string {
  const digest = createHash("sha256").update(handoff.patchText).digest("hex");
  if (digest !== handoff.patchSha256) throw new Error("patch_digest_mismatch");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "march-publish-index-"));
  const index = path.join(dir, "index");
  try {
    git(cwd, ["read-tree", base], { index });
    try {
      git(cwd, ["apply", "--cached", "-"], { index, input: handoff.patchText });
    } catch (error) {
      if (timedOut(error)) throw error;
      git(cwd, ["read-tree", "--reset", base], { index });
      git(cwd, ["apply", "--cached", "--3way", "-"], { index, input: handoff.patchText });
    }
    const tree = git(cwd, ["write-tree"], { index });
    if (tree === git(cwd, ["rev-parse", base + "^{tree}"])) throw new Error("empty_patch_tree");
    return tree;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function describeCommit({ target, branchRef }: Target, handoff: StewardHandoffInput, sha: string): IntegrationCommit {
  return {
    spawnId: handoff.spawnId,
    branch: branchRef.slice("refs/heads/".length),
    commitSha: sha,
    patchSha256: handoff.patchSha256,
    committedAt: git(target, ["show", "-s", "--format=%cI", sha]),
  };
}

function equivalent(cwd: string, sha: string, handoff: StewardHandoffInput): boolean {
  const [parents, tree, body] = git(cwd, ["show", "-s", "--format=%P%x00%T%x00%B", sha]).split("\0");
  return !!parents && !parents.includes(" ") && body === message(handoff) &&
    expectedTree(cwd, parents, handoff) === tree;
}

function branchHead({ target, branchRef }: Target): string {
  if (git(target, ["symbolic-ref", "--quiet", "HEAD"]) !== branchRef) throw new Error("branch_changed");
  return git(target, ["rev-parse", "--verify", branchRef + "^{commit}"]);
}

function timedOut(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ETIMEDOUT";
}

export function publicationError(
  target: Target,
  handoff: StewardHandoffInput,
  error: unknown,
  commit?: IntegrationCommit,
): IntegrationPublicationError {
  return new IntegrationPublicationError({
    failureReason: timedOut(error) ? "timeout" : commit ? "push_failed" : "commit_failed",
    spawnId: handoff.spawnId,
    branch: target.branchRef.slice("refs/heads/".length),
    patchSha256: handoff.patchSha256,
    ...(commit ? { commit } : {}),
  });
}

export function findIntegrationCommit(target: Target, handoff: StewardHandoffInput): IntegrationCommit | undefined {
  const sha = branchHead(target);
  if (!equivalent(target.target, sha, handoff)) return undefined;
  const tree = git(target.target, ["write-tree"]);
  if (tree !== git(target.target, ["rev-parse", sha + "^{tree}"])) throw new Error("unexpected_staged_tree");
  return describeCommit(target, handoff, sha);
}

export function createIntegrationCommit(target: Target, handoff: StewardHandoffInput): IntegrationCommit {
  const reused = findIntegrationCommit(target, handoff);
  if (reused) return reused;
  const cwd = target.target;
  try {
    const base = branchHead(target);
    const tree = expectedTree(cwd, base, handoff);
    if (tree !== git(cwd, ["write-tree"])) throw new Error("unexpected_staged_tree");
    const sha = git(cwd, ["commit-tree", tree, "-p", base, "--no-gpg-sign"], { input: message(handoff) + "\n" });
    const commit = describeCommit(target, handoff, sha);
    if (branchHead(target) !== base) throw new Error("branch_changed");
    git(cwd, ["update-ref", "--no-deref", target.branchRef, sha, base]);
    return commit;
  } catch (error) {
    // A competing attempt may have advanced the branch while we verified the
    // index or tried the compare-and-swap.
    const raced = findIntegrationCommit(target, handoff);
    if (raced) return raced;
    throw error;
  }
}

export async function pushIntegrationCommit(
  target: Target,
  handoff: StewardHandoffInput,
  commit: IntegrationCommit,
  options: { homeDir?: string; sliceId?: string } = {},
): Promise<IntegrationCommit> {
  let transport: string | undefined;
  try {
    const origin = await resolveHatcheryOrigin(target.target);
    if (!origin) throw new Error("origin_missing");
    const cwd = target.target;
    if (!origin.repo && !origin.url.startsWith("file://")) origin.url = path.resolve(cwd, origin.url);
    const ref = target.branchRef;
    if (branchHead(target) !== commit.commitSha || !equivalent(cwd, commit.commitSha, handoff)) {
      throw new Error("unverified_commit");
    }
    // Credentialed Git reads verified objects through an alternate. Its
    // configuration and any fetched objects live outside the worktree.
    transport = fs.mkdtempSync(path.join(os.tmpdir(), "march-publish-transport-"));
    const gitDir = transport;
    const format = git(cwd, ["rev-parse", "--show-object-format"]);
    const objects = git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
    git(gitDir, ["init", "--bare", "--template=", "--object-format=" + format]);
    fs.writeFileSync(path.join(gitDir, "objects", "info", "alternates"), objects + "\n");

    const clientKey = origin.repo
      ? fs.readFileSync(path.join(options.homeDir ?? os.homedir(), ".march", "steward", "tessera-client-key"), "utf8").trim()
      : undefined;
    if (origin.repo && !clientKey) throw new Error("steward_key_missing");
    const client = new TesseraClient({ clientKey, env: { MARCH_TESSERA_URL: process.env.MARCH_TESSERA_URL } });
    const request = origin.repo
      ? { identity: "app", access: "write", repo: origin.repo, sliceId: options.sliceId } as const
      : undefined;
    let token = request ? (await client.issueGitHubToken(request)).token : undefined;
    const run = async (beforeUrl: string[], afterUrl: string[]) => {
      let result = await runScopedNetworkGit(gitDir, origin, beforeUrl, afterUrl, token, gitDir);
      if (request && result.unauthorized) {
        token = (await client.issueGitHubToken({ ...request, refresh: true })).token;
        result = await runScopedNetworkGit(gitDir, origin, beforeUrl, afterUrl, token, gitDir);
      }
      if (result.timedOut) throw Object.assign(new Error("git_timeout"), { code: "ETIMEDOUT" });
      return result;
    };
    if (branchHead(target) !== commit.commitSha) throw new Error("branch_changed");
    const push = await run(
      ["push", "--no-follow-tags", "--no-verify", "--recurse-submodules=no", "--"],
      [commit.commitSha + ":" + ref],
    );
    if (push.code === 0) return commit;

    const lookup = await run(["ls-remote", "--exit-code", "--refs", "--"], [ref]);
    const [sha, remoteRef] = lookup.stdout.trim().split("\t");
    if (lookup.code !== 0 || remoteRef !== ref || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) {
      throw new Error("remote_ref_unavailable");
    }
    if (sha === commit.commitSha) return commit;
    const fetch = await run(
      ["fetch", "--no-tags", "--no-recurse-submodules", "--no-auto-maintenance", "--"],
      [ref],
    );
    const identity = (oid: string) => git(gitDir, ["show", "-s", "--format=%P%x00%T%x00%B", oid]);
    if (fetch.code !== 0) throw new Error("remote_fetch_failed");
    const fetched = git(gitDir, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
    if (identity(fetched) !== identity(commit.commitSha)) throw new Error("remote_diverged");
    return describeCommit({ target: gitDir, branchRef: ref }, handoff, fetched);
  } catch (error) {
    throw publicationError(target, handoff, error, commit);
  } finally {
    if (transport) fs.rmSync(transport, { recursive: true, force: true });
  }
}
