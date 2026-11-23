/**
 * @l1 @deterministic @ci
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { emptyMultiProfileState, emptySystemState } from "../../herald/events.js";
import type { ProfileClient } from "../../herald/profiles/client.js";
import type { ProfileRecord } from "../../herald/profiles/types.js";
import { emitTesseraSpan } from "../../observability/tessera-trace.js";
import { configureLoopRuntime, getLoopSnapshot, runTickOnce } from "./runtime.js";

const { snapshotFor, append } = vi.hoisted(() => ({ snapshotFor: vi.fn(), append: vi.fn() }));
vi.mock("./clients/herald.js", () => ({
  LegateHerald: class {
    consume = vi.fn(async () => emptyMultiProfileState());
    snapshotFor = snapshotFor;
    append = append;
    takeRecoveryRequests = () => [];
    takeStewardAttachments = () => [];
  },
}));
vi.mock("../../observability/tessera-trace.js", () => ({ emitTesseraSpan: vi.fn() }));
vi.mock("../../castra/client.js", () => ({
  CastraClient: class { sendPrompt = vi.fn(); },
}));

const root = mkdtempSync(join(tmpdir(), "march-legate-runtime-"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

it("keeps ticking after a slice's issuance failure and scopes healthy merge and read children", async () => {
  const profiles = ["denied", "healthy"].map((profile): ProfileRecord => {
    const repoPath = join(root, profile);
    mkdirSync(repoPath);
    execFileSync("git", ["init", "-q", repoPath]);
    execFileSync("git", ["-C", repoPath, "remote", "add", "origin", `git@github.com:org/${profile}.git`]);
    return {
      profile, repoPath, repoName: profile, workerGroup: "workers",
      mergePolicy: { dependencyUpdates: { autoMerge: profile === "healthy" } },
    } as ProfileRecord;
  });
  snapshotFor.mockImplementation((profile: string) => {
    const sliceId = `slice-${profile}`;
    return {
      ...emptySystemState(),
      sessions: {
        worker: { id: "worker", present: true, group: "workers", status: "idle" },
        reviewerWorker: { id: "reviewerWorker", present: true, group: "workers", status: "idle" },
      },
      slices: {
        [sliceId]: {
          sliceId, stage: "pr-open", sessionId: "worker",
          pr: {
            number: 8, url: `https://github.com/org/${profile}/pull/8`, state: "OPEN", head_sha: "abc123",
            checks: "PASS", mergeable: "MERGEABLE", merge_state_status: "clean",
            needs_response_count: 0, human_approval_count: 1, changes_requested_count: 0,
          },
        },
        ...(profile === "healthy" ? {
          "slice-with-comment": {
            sliceId: "slice-with-comment", stage: "pr-open", sessionId: "reviewerWorker",
            pr: {
              number: 9, state: "OPEN", head_sha: "def456", checks: "PASS", mergeable: "MERGEABLE",
              needs_response_count: 0,
              conversation_comments: [{ id: 11, author: "reviewer", body_preview: "Please check this" }],
            },
          },
        } : {}),
      },
    };
  });
  const bin = join(root, "bin");
  const callsPath = join(root, "gh.ndjson");
  mkdirSync(bin);
  mkdirSync(join(root, ".config", "gh"), { recursive: true });
  writeFileSync(join(root, ".config", "gh", "hosts.yml"), "github.com:\n  oauth_token: operator-login\n");
  writeFileSync(join(bin, "gh"), `#!${process.execPath}
const fs = require("node:fs");
const { GH_TOKEN, GH_CONFIG_DIR, MARCH_TESSERA_CLIENT_KEY } = process.env;
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({
  args, token: GH_TOKEN, config: GH_CONFIG_DIR, contents: fs.readdirSync(GH_CONFIG_DIR),
  hasClientKey: !!MARCH_TESSERA_CLIENT_KEY,
}) + "\\n");
if (GH_TOKEN === "write-initial") {
  console.error("gh: Bad credentials (HTTP 401)");
  process.exitCode = 1;
} else if (args[1] === "list") console.log("[]");
`, { mode: 0o755 });

  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  vi.stubEnv("HOME", root);
  vi.stubEnv("GH_TOKEN", undefined);
  vi.stubEnv("GITHUB_TOKEN", undefined);
  vi.stubEnv("MARCH_TESSERA_GH_TOKEN_FALLBACK", undefined);
  vi.stubEnv("MARCH_TESSERA_CLIENT_KEY", "client-key");
  vi.stubEnv("MARCH_TESSERA_URL", "http://tessera:9477");
  const requests: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("http://tessera:9477/v1/github/token");
    const request = JSON.parse(String(init.body));
    requests.push({ ...request, sliceId: new Headers(init.headers).get("x-march-slice-id") });
    if (request.repo === "org/denied") {
      return Response.json({ error: { code: "provider_unavailable", message: "private provider detail" } }, { status: 503 });
    }
    const token = request.access === "read" ? "read-token" : request.refresh ? "write-refreshed" : "write-initial";
    return Response.json({
      token, identity: "app[bot]", repo: request.repo, access: request.access,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(), commit_identity: { name: "App", email: "app@example.com" },
    });
  }));

  const list = vi.fn(async () => [...profiles]);
  configureLoopRuntime({
    profileClient: { list } as unknown as ProfileClient, intervalSeconds: 60, homeDir: root,
    probeServices: async () => ({ hatchery: { state: "ok", checked_at: "T", reasons: [], remedy: null, detail: null } }),
  });
  await runTickOnce();
  expect(requests).toEqual([
    { repo: "org/denied", identity: "app", access: "write", sliceId: "slice-denied" },
    // The PR label reconciler's open-PR listing also needs a read token; the denied repo's is refused too.
    { repo: "org/denied", identity: "app", access: "read", sliceId: null },
    { repo: "org/healthy", identity: "app", access: "write", sliceId: "slice-healthy" },
    { repo: "org/healthy", identity: "app", access: "write", sliceId: "slice-healthy", refresh: true },
    { repo: "org/healthy", identity: "app", access: "read", sliceId: null },
  ]);
  expect(emitTesseraSpan).toHaveBeenCalledWith("tessera.issue", expect.objectContaining({ sliceId: "slice-denied", error: true }));
  const { byProfile } = getLoopSnapshot();
  expect(byProfile.denied.workingState.slices["slice-denied"]).toMatchObject({
    stage: "pr-open", pr: { state: "OPEN" }, last_action_note: "auto-merge failed: Tessera request failed",
  });
  expect(byProfile.healthy.workingState.slices["slice-healthy"].stage).toBe("merged");
  const calls = readFileSync(callsPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls.map(call => call.token)).toEqual(["write-initial", "write-refreshed", "write-refreshed", "read-token", "read-token"]);
  const mergeArgs = ["pr", "merge", "8", "--squash", "--match-head-commit", "abc123", "--repo", "org/healthy"];
  expect(calls[0].args).toEqual(mergeArgs);
  expect(calls[1].args).toEqual(mergeArgs);
  expect(calls[2].args).toEqual([
    "api", "--method", "POST", "repos/org/healthy/issues/comments/11/reactions", "-f", "content=eyes",
  ]);
  expect(emitTesseraSpan).toHaveBeenCalledWith("tessera.issue", expect.objectContaining({
    sliceId: "slice-with-comment", attributes: expect.objectContaining({ "tessera.access": "write" }),
  }));
  expect(calls[3].args).toEqual(expect.arrayContaining(["pr", "list", "--repo", "org/healthy"]));
  // The PR label reconciler's single open-PR listing.
  expect(calls[4].args).toEqual(expect.arrayContaining(["pr", "list", "--state", "open", "--limit", "200", "--repo", "org/healthy"]));
  expect(new Set(calls.map(call => call.config)).size).toBe(calls.length);
  for (const call of calls) {
    expect(call.contents).toEqual([]);
    expect(call.hasClientKey).toBe(false);
    expect(existsSync(call.config)).toBe(false);
  }
  expect(process.env.GH_TOKEN).toBeUndefined();
  await runTickOnce();
  expect(list).toHaveBeenCalledTimes(2);
  // The per-tick service probe result is cached on the snapshot for GET /status.
  expect(getLoopSnapshot().services?.hatchery?.state).toBe("ok");
});
