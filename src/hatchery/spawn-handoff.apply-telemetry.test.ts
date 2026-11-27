/**
 * @l1 @deterministic @ci
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Span } from "@opentelemetry/sdk-trace-base";
import type { SpawnBackend } from "../spawn/backends.js";
import { getActiveOtel, initOtel } from "../observability/otel.js";
import { traceIdForDispatch } from "../observability/trace-ids.js";
import { removeSpawnWorktree } from "../brood/worktree.js";
import { loadSpawnRecord } from "../brood/spawn-record.js";
import { BroodClient } from "../brood/service/client.js";
import type { IntegrationAttemptState } from "../brood/service/types.js";
import { TesseraClient } from "../tessera/client.js";
import * as branchPublisher from "./integration-publisher.js";

// Issue #244 acceptance: a steward.apply failure must produce a span carrying the
// slice/spawn/worktree/patch diagnostics AND a trace-correlated log. This drives
// runHatcherySpawn to a REAL git-apply conflict (a new-file patch the worktree
// base already contains with different content — neither --index nor --3way can
// resolve it) with telemetry on, then inspects the steward.apply span + the
// emitted log record.

const { worktreePath, sendPrompt, sessionOutput, workerPatch, recordedState, launchCollision, removeSession, liveSessions } = vi.hoisted(() => ({
  launchCollision: { value: false },
  liveSessions: { value: ["ad-xyz"] as string[] },
  worktreePath: { value: "" },
  sendPrompt: vi.fn(async () => {}),
  removeSession: vi.fn(async () => ({ removed: true })),
  sessionOutput: vi.fn<() => Promise<string>>(),
  workerPatch: { value: "" },
  recordedState: { paths: undefined as string[] | undefined, unavailable: false },
}));

// We exercise the steward.apply telemetry, not the #211 rollback — stub the
// exact-path removal so the real one doesn't warn about the temp worktree.
vi.mock("../brood/worktree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../brood/worktree.js")>();
  return { ...actual, removeSpawnWorktree: vi.fn() };
});

vi.mock("../brood/spawn-record.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../brood/spawn-record.js")>();
  return {
    ...actual,
    loadSpawnRecord: (...args: Parameters<typeof actual.loadSpawnRecord>) =>
      recordedState.unavailable ? undefined : actual.loadSpawnRecord(...args),
    readSpawnRecordExtractionResult: (...args: Parameters<typeof actual.readSpawnRecordExtractionResult>) => {
      const result = actual.readSpawnRecordExtractionResult(...args);
      if (result?.status !== "succeeded" || !recordedState.paths) return result;
      return { ...result, patch: { ...result.patch, touchedPaths: recordedState.paths } };
    },
  };
});

vi.mock("../castra/client.js", () => {
  class CastraClientError extends Error {}
  class CastraClient {}
  const createCastraClientFromEnv = () => ({
    launchSession: vi.fn(
      async (req: { title: string; group?: string; branch: string; createBranch?: boolean }) => {
        if (req.createBranch === false) {
          return { sessionId: "ad-relaunched", title: req.title, group: req.group ?? "g", branch: req.branch, worktreePath: worktreePath.value };
        }
        if (launchCollision.value) {
          throw new Error(`agent-deck launch failed: Error: branch 'feature/${req.branch}' already exists`);
        }
        return {
        sessionId: "ad-xyz",
        title: req.title,
        group: req.group ?? "g",
        branch: req.branch,
        worktreePath: worktreePath.value,
        };
      },
    ),
    listSessions: vi.fn(async () => liveSessions.value.map((sessionId) => ({ sessionId }))),
    removeSession,
    sendPrompt,
    sessionOutput,
  });
  return { CastraClient, CastraClientError, createCastraClientFromEnv };
});

vi.mock("../spawn/snapshot.js", () => {
  class SnapshotError extends Error {}
  return {
    SnapshotError,
    createBuildContext: vi.fn(() => ({ contextPath: "/ctx", cleanup: vi.fn() })),
  };
});

vi.mock("../spawn/snapshot-build.js", () => {
  class BuildError extends Error {}
  return {
    BuildError,
    writeSpawnDockerfile: vi.fn(() => "/ctx/Dockerfile"),
    buildSpawnImage: vi.fn(() => "march-spawn-img:latest"),
    removeSpawnImage: vi.fn(),
  };
});

// A new-file patch for `f`, which already exists in the base — conflicts.
const CONFLICTING_PATCH =
  "diff --git a/f b/f\nnew file mode 100644\nindex 0000000..deadbee\n--- /dev/null\n+++ b/f\n@@ -0,0 +1 @@\n+totally different content\n";
// The worker now emits the patch on the deterministic sentinel line (base64),
// not as raw `agent_message` text — mirror that so extraction yields the patch.

vi.mock("../spawn/container-launch.js", () => {
  class LaunchError extends Error {}
  return {
    LaunchError,
    createSpawnContainer: vi.fn(() => "container-id"),
    copyPromptToContainer: vi.fn(),
    copyOtelEmitterToContainer: vi.fn(),
    startSpawnContainer: vi.fn(),
    waitForSpawnContainer: vi.fn(() => ({ exitCode: 0 })),
    readSpawnContainerLogs: vi.fn(() => "__MARCH_PATCH_B64__:" + Buffer.from(workerPatch.value).toString("base64")),
    removeSpawnContainer: vi.fn(),
  };
});

import { runHatcherySpawn } from "./spawn-handoff.js";

const backend: SpawnBackend = {
  name: "codex",
  baseImage: "march-spawn-codex:latest",
  requiredEnvVars: [],
  credentialMounts: [],
  buildEntrypoint: () => ["sh", "-c", "true"],
  allowedEgressHosts: ["chatgpt.com"],
};

const tmpDirs: string[] = [];
function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-tel-home-"));
  tmpDirs.push(dir);
  return dir;
}
let repoPath: string;
const branch = "smithy/cut/01-spawn";

function makeWorktree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-tel-wt-"));
  tmpDirs.push(dir);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "f"), "hello\n");
  git("add", "f");
  git("commit", "-qm", "init");
  const remote = path.join(makeHome(), "remote.git");
  git("init", "-q", "--bare", remote);
  git("remote", "add", "origin", remote);
  repoPath = dir;
  const target = path.join(makeHome(), "integration");
  git("worktree", "add", "-qb", "feature/" + branch, target);
  return target;
}

function captureSpans(): Span[] {
  const tracer = getActiveOtel().getTracer();
  const created: Span[] = [];
  const real = tracer.startSpan.bind(tracer);
  vi.spyOn(tracer, "startSpan").mockImplementation((...args: Parameters<typeof real>) => {
    const span = real(...args) as Span;
    created.push(span);
    return span;
  });
  return created;
}

beforeEach(() => {
  worktreePath.value = makeWorktree();
  workerPatch.value = CONFLICTING_PATCH;
  sendPrompt.mockClear();
  removeSession.mockClear();
  sessionOutput.mockReset();
  launchCollision.value = false;
  liveSessions.value = ["ad-xyz"];
  recordedState.paths = undefined;
  recordedState.unavailable = false;
  vi.stubEnv("MARCH_BROOD_URL", "");
  vi.stubEnv("MARCH_HERALD_URL", "");
  initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  initOtel({});
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("steward.apply diagnostics (#244)", () => {
  it("sets diagnostic attributes on the steward.apply span and emits a correlated log on a conflict", async () => {
    const created = captureSpans();
    const emit = vi.spyOn(getActiveOtel().getLogger(), "emit");
    const home = makeHome();

    await expect(
      runHatcherySpawn({
        repoPath,
        prompt: "do the thing",
        backend,
        agentDeckProfile: "march",
        branch,
        sliceId: "my-slice-id",
        homeDir: home,
      }),
    ).rejects.toMatchObject({
      application: {
        spawnId: expect.any(String), status: "failed", touchedPaths: ["f"],
        diagnostic: "patch_conflict",
      },
    });
    expect(sendPrompt).not.toHaveBeenCalled();

    const span = created.find((s) => s.name === "steward.apply")!;
    expect(span).toBeDefined();
    expect(span.attributes).toMatchObject({
      "march.slice_id": "my-slice-id",
      "march.spawn_id": expect.stringMatching(/^\d{8}-[0-9a-f]{6}$/),
      "march.worktree": worktreePath.value,
      "march.patch.files": 1,
      "march.patch.first_path": "f",
      "march.patch.reject": "patch_conflict",
    });
    expect(span.attributes["march.patch.bytes"]).toBeGreaterThan(0);
    expect(span.status.code).toBe(2);
    expect(span.spanContext().traceId).toBe(traceIdForDispatch("my-slice-id"));

    // A trace-correlated log line for the failure.
    const logCall = emit.mock.calls.find(
      (c) => (c[0].attributes as Record<string, unknown>)?.event_kind === "steward_apply_failed",
    );
    expect(logCall).toBeDefined();
    expect(logCall![0].attributes).toMatchObject({
      "march.slice_id": "my-slice-id",
      "march.patch.reject": "patch_conflict",
    });
  });
});

it("fails the slice trace on a Tessera outage and processes the next local job", async () => {
  execFileSync("git", ["remote", "set-url", "origin", "git@github.com:team/repo.git"], {
    cwd: worktreePath.value,
  });
  vi.stubEnv("MARCH_TESSERA_URL", "http://outage-test-tessera");
  vi.stubEnv("MARCH_TESSERA_CLIENT_KEY", "outage-test-key");
  vi.stubEnv("MARCH_TESSERA_GH_TOKEN_FALLBACK", "");
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  const issuance = vi.fn(async () => { throw new Error("private transport diagnostics"); });
  vi.stubGlobal("fetch", issuance);
  const spans = captureSpans();
  const input = {
    repoPath, prompt: "do the thing", backend, branch,
    sliceId: "pin-outage-slice", homeDir: makeHome(),
  };

  await expect(runHatcherySpawn(input)).rejects.toMatchObject({
    name: "HatcheryGitHubError", code: "tessera:unreachable",
    message: "Hatchery GitHub read failed (tessera:unreachable)",
  });
  const pin = spans.find((span) => span.name === "manager.pin_base");
  expect(pin?.spanContext().traceId).toBe(traceIdForDispatch(input.sliceId));
  expect(pin?.status).toMatchObject({ code: 2, message: "Hatchery GitHub read failed (tessera:unreachable)" });
  expect(spans.some((span) => span.name === "spawn.start")).toBe(false);
  // The Brood launch row must exist before a pin failure can abort the spawn.
  expect(spans.some((span) => span.name === "brood.register" &&
    span.spanContext().traceId === pin?.spanContext().traceId)).toBe(true);
  expect(spans.find((span) => span.name === "hatchery.spawn" && span.spanContext().traceId === pin?.spanContext().traceId)
    ?.attributes["march.failure_stage"]).toBe("pin_base");

  worktreePath.value = makeWorktree();
  await expect(runHatcherySpawn({ ...input, repoPath, sliceId: "next-local-slice" })).rejects.toThrow(/git apply failed/);
  expect(issuance).toHaveBeenCalledTimes(1);
  expect(spans.some((span) => span.name === "steward.apply" &&
    span.spanContext().traceId === traceIdForDispatch("next-local-slice"))).toBe(true);
});

const ADD_PATCH = CONFLICTING_PATCH.replaceAll("/f", "/new file.txt");

function runFixture() {
  return runHatcherySpawn({ repoPath, branch, prompt: "do the thing", backend, homeDir: makeHome() });
}

function gitAt(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

it("reports exactly the staged paths and preserves the operator's file and index", async () => {
  fs.writeFileSync(path.join(repoPath, "f"), "operator staged edit\n");
  gitAt(repoPath, "add", "f");
  const indexBefore = fs.readFileSync(path.join(repoPath, ".git", "index"));
  workerPatch.value = ADD_PATCH;

  const result = await runFixture();

  expect(result.application).toEqual({
    spawnId: result.spawnId, status: "applied", touchedPaths: ["new file.txt"],
    appliedAt: expect.any(String),
  });
  expect(gitAt(worktreePath.value, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).toBe("new file.txt\n");
  expect(fs.readFileSync(path.join(repoPath, "f"), "utf8")).toBe("operator staged edit\n");
  expect(fs.readFileSync(path.join(repoPath, ".git", "index"))).toEqual(indexBefore);
  expect(fs.existsSync(path.join(repoPath, "new file.txt"))).toBe(false);
  expect(sendPrompt).toHaveBeenCalledTimes(1);
});

it.each(["success", "ack lost", "persistence unavailable", "late review"] as const)("handles %s after publishing the exact reviewed commit", async (mode) => {
  workerPatch.value = ADD_PATCH;
  const homeDir = makeHome();
  const sliceId = "pr-publication-slice";
  const brood = integrationFixture();
  if (mode === "ack lost") {
    const write = brood.write.getMockImplementation()!;
    brood.write.mockImplementation(async (...args) => {
      await write(...args);
      throw new Error("lost acknowledgement");
    });
  }
  if (mode === "persistence unavailable") {
    brood.write.mockRejectedValue(new Error("unavailable"));
    brood.read.mockRejectedValue(new Error("unavailable"));
  }
  const repo = "team/project";
  const pushedBranch = "feature/" + branch;
  const remote = gitAt(repoPath, "remote", "get-url", "origin").trim();
  const pushLocally = branchPublisher.pushIntegrationCommit;
  vi.spyOn(branchPublisher, "pushIntegrationCommit").mockImplementation(async (target, handoff, commit, options) => {
    const result = await pushLocally(target, handoff, commit, options);
    options?.onPushed?.(repo);
    return result;
  });
  fs.mkdirSync(path.join(homeDir, ".march", "steward"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".march", "steward", "tessera-client-key"), "fake-client-key");
  vi.stubEnv("MARCH_TESSERA_URL", "http://tessera.test");
  vi.spyOn(TesseraClient.prototype, "issueGitHubToken").mockResolvedValue({ token: "fake-token" } as
    Awaited<ReturnType<TesseraClient["issueGitHubToken"]>>);
  sessionOutput.mockImplementation(async () => {
    const [{ prompt }] = sendPrompt.mock.lastCall as unknown as [{ prompt: string }];
    const id = /Review receipt ID: ([\w-]+)/.exec(prompt)?.[1];
    if (mode === "late review") vi.spyOn(Date, "now").mockReturnValue(Date.parse(brood.request.stewardDeadline) + 1);
    return `Review complete.\nREVIEW ${id} passed\n`;
  });
  let publishedCommit: string | undefined;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/branches/release")) return Response.json({ name: "release" });
    expect(url.pathname).toBe(`/repos/${repo}/pulls`);
    if (init?.method === "GET") return Response.json([]);
    expect(sessionOutput).toHaveBeenCalledTimes(1);
    publishedCommit = gitAt(remote, "rev-parse", "refs/heads/" + pushedBranch).trim();
    const payload = JSON.parse(String(init?.body));
    expect(payload).toMatchObject({ base: "release", head: "team:" + pushedBranch });
    expect(payload.body).toContain("Steward verification passed.");
    expect(payload.body).toContain("new file.txt");
    return Response.json({
      state: "open", number: 42, html_url: `https://github.com/${repo}/pull/42`,
      head: { ref: pushedBranch, sha: publishedCommit, repo: { full_name: repo } },
      base: { ref: "release", repo: { full_name: repo } },
    }, { status: 201 });
  });
  vi.stubGlobal("fetch", fetch);
  const spans = captureSpans();

  const completion = runHatcherySpawn({
    repoPath, branch, prompt: "do the thing", backend, baseBranch: "release", homeDir, sliceId, ...brood.request,
  });
  if (mode === "persistence unavailable") {
    await expect(completion).rejects.toMatchObject({
      outcome: { status: "failed", failureReason: "persistence", pullRequest: { number: 42 } },
    });
    expect(publishedCommit).toMatch(/^[a-f0-9]{40}$/);
    return;
  }
  if (mode === "late review") {
    await expect(completion).rejects.toMatchObject({
      outcome: { status: "failed", failureReason: "timeout", commit: { commitSha: expect.any(String) } },
    });
    expect(publishedCommit).toBeUndefined();
    expect(removeSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "ad-xyz", pruneWorktree: false }));
    return;
  }
  const result = await completion;

  expect(result.commit.commitSha).toBe(publishedCommit);
  expect(result.integrationOutcome).toMatchObject({
    status: "succeeded", spawnId: result.spawnId, commit: { commitSha: publishedCommit },
    pullRequest: { number: 42 }, stewardSessionId: "ad-xyz",
  });
  expect(brood.write).toHaveBeenCalledWith(brood.request.attemptId, result.integrationOutcome);
  expect(result.pullRequestPublication).toMatchObject({
    status: "succeeded", pullRequest: { number: 42, headBranch: pushedBranch, baseBranch: "release" },
  });
  for (const name of ["steward.pr.publish", "steward.pr.lookup", "steward.pr.create"]) {
    expect(spans.find((span) => span.name === name)?.spanContext().traceId).toBe(traceIdForDispatch(sliceId));
  }
});

it("gates Steward handoff on publication and preserves the retryable local commit", async () => {
  workerPatch.value = ADD_PATCH;
  const target = worktreePath.value;
  gitAt(target, "remote", "set-url", "origin", path.join(makeHome(), "missing.git"));
  const spans = captureSpans();
  const sliceId = "publication-failure-slice";

  await expect(runHatcherySpawn({
    repoPath, branch, prompt: "do the thing", backend, homeDir: makeHome(), sliceId,
  })).rejects.toMatchObject({
    message: "Steward publication failed (push_failed)",
    publication: {
      failureReason: "push_failed",
      branch: "feature/" + branch,
      commit: { commitSha: expect.any(String) },
    },
  });
  expect(gitAt(target, "show", "HEAD:new file.txt")).toBe("totally different content\n");
  expect(sendPrompt).not.toHaveBeenCalled();
  const span = spans.find((candidate) => candidate.name === "steward.push");
  expect(span?.status.code).toBe(2);
  expect(span?.spanContext().traceId).toBe(traceIdForDispatch(sliceId));
});

it("resumes a preserved publication when a retry collides at manager launch", async () => {
  workerPatch.value = ADD_PATCH;
  const target = worktreePath.value;
  const remote = gitAt(target, "remote", "get-url", "origin").trim();
  gitAt(target, "remote", "set-url", "origin", path.join(makeHome(), "missing.git"));
  const homeDir = makeHome();
  const sliceId = "publication-resume-slice";
  const failure = await runHatcherySpawn({
    repoPath, branch, prompt: "do the thing", backend, homeDir, sliceId,
  }).catch((error: { publication: { spawnId: string; commit: { commitSha: string } } }) => error.publication);
  const preserved = (failure as { commit: { commitSha: string } }).commit.commitSha;

  gitAt(target, "remote", "set-url", "origin", remote);
  launchCollision.value = true;
  const spans = captureSpans();
  // A different request naming the same branch must not inherit the publication.
  await expect(runHatcherySpawn({ repoPath, branch, prompt: "other work", backend, homeDir, sliceId }))
    .rejects.toThrow(/already exists|diverged|manager/i);
  await expect(runHatcherySpawn({ repoPath, branch, prompt: "do the thing", backend, homeDir, sliceId: "other-slice" }))
    .rejects.toThrow(/already exists|diverged|manager/i);
  expect(gitAt(remote, "for-each-ref", "refs/heads/feature/" + branch).trim()).toBe("");
  sendPrompt.mockClear();
  const result = await runHatcherySpawn({ repoPath, branch, prompt: "do the thing", backend, homeDir, sliceId });

  expect(result.spawnId).toBe((failure as { spawnId: string }).spawnId);
  expect(result.commit.commitSha).toBe(preserved);
  expect(result.managerSession).toMatchObject({ sessionId: "ad-xyz", worktreePath: target });
  expect(gitAt(remote, "rev-parse", "refs/heads/feature/" + branch).trim()).toBe(preserved);
  expect(gitAt(target, "rev-parse", "@{upstream}").trim()).toBe(preserved);
  expect(gitAt(target, "rev-list", "--count", "HEAD").trim()).toBe("2");
  expect(sendPrompt).toHaveBeenCalledTimes(1);
  expect(sendPrompt).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: "ad-xyz",
    prompt: expect.stringContaining(`Published commit: ${preserved}`),
  }));
  const push = spans.find((candidate) => candidate.name === "steward.push");
  expect(push?.status.code).not.toBe(2);
  expect(push?.spanContext().traceId).toBe(traceIdForDispatch(sliceId));
});

it("relaunches a removed Steward on the preserved checkout before resuming publication", async () => {
  workerPatch.value = ADD_PATCH;
  const target = worktreePath.value;
  const remote = gitAt(target, "remote", "get-url", "origin").trim();
  gitAt(target, "remote", "set-url", "origin", path.join(makeHome(), "missing.git"));
  const homeDir = makeHome();
  const sliceId = "publication-relaunch-slice";
  const failure = await runHatcherySpawn({
    repoPath, branch, prompt: "do the thing", backend, homeDir, sliceId,
  }).catch((error: { publication: { spawnId: string; commit: { commitSha: string } } }) => error.publication);
  const spawnId = (failure as { spawnId: string }).spawnId;

  gitAt(target, "remote", "set-url", "origin", remote);
  launchCollision.value = true;
  liveSessions.value = [];
  sendPrompt.mockClear();
  const result = await runHatcherySpawn({ repoPath, branch, prompt: "do the thing", backend, homeDir, sliceId });

  expect(result.spawnId).toBe(spawnId);
  expect(result.managerSession).toMatchObject({ sessionId: "ad-relaunched", worktreePath: target });
  expect(loadSpawnRecord(spawnId, homeDir)?.stewardSessionId).toBe("ad-relaunched");
  expect(sendPrompt).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "ad-relaunched" }));
  expect(sendPrompt).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: "ad-xyz" }));
});

it("decodes Git-quoted header paths so a non-ASCII filename passes the staged-path check", async () => {
  // Mixed patch: one plain name and one Git quotes by default (core.quotePath).
  workerPatch.value =
    ADD_PATCH.replaceAll("/new file.txt", "/regular.txt") +
    'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"\nnew file mode 100644\n' +
    'index 0000000..deadbee\n--- /dev/null\n+++ "b/caf\\303\\251.txt"\n@@ -0,0 +1 @@\n+bonjour\n';

  const result = await runFixture();

  expect(result.application).toMatchObject({
    status: "applied", touchedPaths: ["café.txt", "regular.txt"],
  });
  expect(sendPrompt).toHaveBeenCalledTimes(1);
});

it.each(["missing", "missing branch", "wrong branch", "detached", "other repo", "operator symlink", "operator subdirectory"])(
  "stops before staging when the target is %s",
  async (invalidTarget) => {
    const target = worktreePath.value;
    switch (invalidTarget) {
      case "missing":
        worktreePath.value = path.join(makeHome(), "missing");
        break;
      case "missing branch":
        gitAt(target, "update-ref", "-d", "refs/heads/feature/" + branch);
        break;
      case "wrong branch":
        gitAt(target, "switch", "-qc", "unexpected");
        break;
      case "detached":
        gitAt(target, "switch", "-q", "--detach");
        break;
      case "other repo": {
        const operatorRepo = repoPath;
        worktreePath.value = makeWorktree();
        repoPath = operatorRepo;
        break;
      }
      case "operator symlink":
        worktreePath.value = path.join(makeHome(), "operator");
        fs.symlinkSync(repoPath, worktreePath.value, "dir");
        break;
      case "operator subdirectory":
        worktreePath.value = path.join(repoPath, "subdir");
        fs.mkdirSync(worktreePath.value);
        break;
    }
    workerPatch.value = ADD_PATCH;

    await expect(runFixture()).rejects.toMatchObject({
      application: { status: "failed", diagnostic: "integration_target_unavailable" },
    });
    expect(gitAt(repoPath, "diff", "--cached", "--name-only")).toBe("");
    expect(gitAt(target, "diff", "--cached", "--name-only")).toBe(invalidTarget === "missing branch" ? "f\n" : "");
    expect(sendPrompt).not.toHaveBeenCalled();
  },
);

it("refuses unrelated staged changes before applying", async () => {
  const target = worktreePath.value;
  fs.writeFileSync(path.join(target, "unrelated"), "existing staged content\n");
  gitAt(target, "add", "unrelated");
  workerPatch.value = ADD_PATCH;

  await expect(runFixture()).rejects.toMatchObject({
    application: { status: "failed", diagnostic: "staged_paths_mismatch" },
  });
  expect(gitAt(target, "diff", "--cached", "--name-only")).toBe("unrelated\n");
  expect(sendPrompt).not.toHaveBeenCalled();
});

it("rejects an empty staged diff when the three-way result already exists", async () => {
  const target = worktreePath.value;
  fs.writeFileSync(path.join(target, "new file.txt"), "totally different content\n");
  gitAt(target, "add", "new file.txt");
  workerPatch.value = gitAt(target, "diff", "--cached", "--binary");
  gitAt(target, "commit", "-qm", "base already contains patch");

  await expect(runFixture()).rejects.toMatchObject({
    application: { status: "failed", diagnostic: "empty_staged_diff" },
  });
  expect(sendPrompt).not.toHaveBeenCalled();
});

it("rejects the result if Git stages different paths from those admitted", async () => {
  workerPatch.value = ADD_PATCH;
  recordedState.paths = ["unexpected"];
  await expect(runFixture()).rejects.toMatchObject({
    application: { status: "failed", touchedPaths: ["unexpected"], diagnostic: "staged_paths_mismatch" },
  });
  expect(sendPrompt).not.toHaveBeenCalled();
});

it("fails closed when the lifecycle record disappears before application", async () => {
  workerPatch.value = ADD_PATCH;
  recordedState.unavailable = true;

  await expect(runFixture()).rejects.toMatchObject({
    application: { status: "failed", diagnostic: "missing_lifecycle_state" },
  });
  expect(gitAt(worktreePath.value, "diff", "--cached", "--name-only")).toBe("");
  expect(sendPrompt).not.toHaveBeenCalled();
});

it("guards the operator's staged changes even when base pinning could reset them", async () => {
  gitAt(repoPath, "update-ref", "refs/remotes/origin/main", "HEAD");
  fs.writeFileSync(path.join(repoPath, "f"), "operator staged edit\n");
  gitAt(repoPath, "add", "f");
  const indexBefore = fs.readFileSync(path.join(repoPath, ".git", "index"));
  worktreePath.value = repoPath;

  await expect(runFixture()).rejects.toMatchObject({
    application: { status: "failed", diagnostic: "integration_target_unavailable" },
  });
  expect(fs.readFileSync(path.join(repoPath, "f"), "utf8")).toBe("operator staged edit\n");
  expect(fs.readFileSync(path.join(repoPath, ".git", "index"))).toEqual(indexBefore);
  expect(sendPrompt).not.toHaveBeenCalled();
});

it("reports a bounded Git timeout on the same slice trace", async () => {
  const directory = makeHome();
  fs.writeFileSync(path.join(directory, "git"), [
    "#!/bin/sh",
    'if [ "$1" = "apply" ]; then exec sleep 20; fi',
    'PATH="$MARCH_TEST_REAL_GIT_PATH" exec git "$@"',
    "",
  ].join("\n"), { mode: 0o755 });
  vi.stubEnv("MARCH_TEST_REAL_GIT_PATH", process.env.PATH);
  vi.stubEnv("PATH", directory + path.delimiter + process.env.PATH);
  const spans = captureSpans();
  const sliceId = "apply-timeout-slice";
  workerPatch.value = ADD_PATCH;

  await expect(runHatcherySpawn({
    repoPath, branch, prompt: "do the thing", backend, homeDir: makeHome(), sliceId,
  })).rejects.toMatchObject({ application: { status: "failed", diagnostic: "timeout" } });
  const span = spans.find((candidate) => candidate.name === "steward.apply");
  expect(span?.status.code).toBe(2);
  expect(span?.spanContext().traceId).toBe(traceIdForDispatch(sliceId));
  expect(sendPrompt).not.toHaveBeenCalled();
}, 12_000);

it("expects only the destination of a copy to be staged", async () => {
  workerPatch.value = "diff --git a/f b/g\nsimilarity index 100%\ncopy from f\ncopy to g\n";

  const result = await runFixture();

  expect(result.application).toMatchObject({ status: "applied", touchedPaths: ["f", "g"] });
  expect(gitAt(worktreePath.value, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).toBe("g\n");
  expect(sendPrompt).toHaveBeenCalledTimes(1);
});

it("fails when the worktree leaves the integration branch while the patch is applied", async () => {
  const directory = makeHome();
  fs.writeFileSync(path.join(directory, "git"), [
    "#!/bin/sh",
    'PATH="$MARCH_TEST_REAL_GIT_PATH"',
    'if [ "$1" = "apply" ]; then git switch -q -c concurrent-switch >/dev/null 2>&1; fi',
    'exec git "$@"',
    "",
  ].join("\n"), { mode: 0o755 });
  vi.stubEnv("MARCH_TEST_REAL_GIT_PATH", process.env.PATH);
  vi.stubEnv("PATH", directory + path.delimiter + process.env.PATH);
  workerPatch.value = ADD_PATCH;

  await expect(runFixture()).rejects.toMatchObject({
    application: { status: "failed", diagnostic: "integration_target_unavailable" },
  });
  expect(sendPrompt).not.toHaveBeenCalled();
  // The switched checkout is no longer authorized: rollback must leave it alone.
  expect(vi.mocked(removeSpawnWorktree)).not.toHaveBeenCalled();
  expect(gitAt(worktreePath.value, "rev-parse", "--abbrev-ref", "HEAD")).toBe("concurrent-switch\n");
});

it("keeps a literal supplementary character beside an escape in a quoted path", async () => {
  // core.quotePath=false style: literal emoji, but the tab is still escaped.
  workerPatch.value =
    'diff --git "a/\u{1F600}\\t.txt" "b/\u{1F600}\\t.txt"\nnew file mode 100644\n' +
    'index 0000000..deadbee\n--- /dev/null\n+++ "b/\u{1F600}\\t.txt"\n@@ -0,0 +1 @@\n+hi\n';

  const result = await runFixture();

  expect(result.application).toMatchObject({ status: "applied", touchedPaths: ["\u{1F600}\t.txt"] });
  expect(sendPrompt).toHaveBeenCalledTimes(1);
});


function integrationFixture() {
  const request = { attemptId: "tracked-attempt", stewardDeadline: new Date(Date.now() + 60_000).toISOString() };
  vi.spyOn(BroodClient.prototype, "register").mockImplementation(async (session) => ({ ...session, status: session.status ?? "created", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  let state: IntegrationAttemptState = { ...request, spawnId: null, fenced: false, outcome: null };
  const bind = vi.spyOn(BroodClient.prototype, "registerIntegrationAttempt").mockImplementation(async (binding) => {
    state = { ...state, ...binding };
    return state;
  });
  const read = vi.spyOn(BroodClient.prototype, "readIntegrationAttempt").mockImplementation(async () => state);
  const lifecycle = vi.spyOn(BroodClient.prototype, "get").mockImplementation(async (id) =>
    ({ id, kind: "spawn", status: "created", backend: "codex", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  const write = vi.spyOn(BroodClient.prototype, "writeIntegrationOutcome").mockImplementation(async (_, outcome) => {
    state = { ...state, outcome };
    return outcome;
  });
  return { request, bind, read, lifecycle, write };
}

function runTracked(request: ReturnType<typeof integrationFixture>["request"]) {
  return runHatcherySpawn({
    ...request, repoPath, branch, prompt: "do the thing", backend, homeDir: makeHome(), sliceId: "tracked-slice",
  });
}

it.each([
  ["extraction_rejected", "extraction"],
  ["missing_lifecycle", "lifecycle"],
  ["patch_conflict", "patch"],
  ["commit_failed", "commit"],
  ["push_failed", "push"],
  ["pr_failed", "pr"],
  ["timeout", "timeout"],
] as const)("durably reports %s through the live handoff", async (failureReason, fault) => {
  const brood = integrationFixture();
  workerPatch.value = fault === "patch" ? CONFLICTING_PATCH : ADD_PATCH;
  if (fault === "extraction") workerPatch.value = "";
  if (fault === "lifecycle") brood.lifecycle.mockResolvedValue(undefined);
  if (fault === "commit") vi.spyOn(branchPublisher, "createIntegrationCommit").mockImplementation(() => {
    throw new Error("opaque credential from git");
  });
  if (fault === "push") gitAt(repoPath, "remote", "set-url", "origin", path.join(makeHome(), "missing.git"));
  if (fault === "timeout") brood.request.stewardDeadline = new Date(Date.now() - 1).toISOString();
  const spans = captureSpans();
  await expect(runTracked(brood.request)).rejects.toMatchObject({ outcome: { failureReason, status: "failed" } });
  const outcome = brood.write.mock.calls[0][1];
  expect(outcome).toMatchObject({ failureReason, spawnId: brood.bind.mock.calls[0][0].spawnId });
  expect(JSON.stringify(outcome)).not.toContain("opaque credential");
  expect(spans.find(({ name }) => name === "steward.integration.persist")?.status.code).toBe(2);
  if (fault === "push" || fault === "pr") expect(outcome.commit?.commitSha).toMatch(/^[a-f0-9]{40}$/);
  if (fault === "pr") expect(sendPrompt).toHaveBeenCalledTimes(1);
  else expect(sendPrompt).not.toHaveBeenCalled();
});

it("fails before extraction or publication when the Brood lookup cannot be confirmed", async () => {
  const brood = integrationFixture();
  brood.bind.mockRejectedValue(new Error("unavailable"));
  brood.read.mockRejectedValue(new Error("unavailable"));
  await expect(runTracked(brood.request)).rejects.toMatchObject({ outcome: { failureReason: "persistence" } });
  expect(brood.lifecycle).not.toHaveBeenCalled();
  expect(brood.write).not.toHaveBeenCalled();
  expect(sendPrompt).not.toHaveBeenCalled();
});

it("returns a typed persistence failure with the pushed artifact if Brood is unavailable", async () => {
  const brood = integrationFixture();
  workerPatch.value = ADD_PATCH;
  brood.write.mockRejectedValue(new Error("secret in failed write"));
  brood.read.mockRejectedValue(new Error("secret in failed read"));
  await expect(runTracked(brood.request)).rejects.toMatchObject({
    outcome: { failureReason: "persistence", commit: { commitSha: expect.any(String) }, diagnostic: expect.not.stringContaining("secret") },
  });
});

it("reads the committed outcome when Brood drops the write acknowledgement", async () => {
  const brood = integrationFixture();
  workerPatch.value = ADD_PATCH;
  const write = brood.write.getMockImplementation()!;
  brood.write.mockImplementation(async (...args) => {
    await write(...args);
    throw new Error("lost acknowledgement");
  });
  await expect(runTracked(brood.request)).rejects.toMatchObject({ outcome: { failureReason: "pr_failed" } });
  expect(brood.read).toHaveBeenCalledOnce();
  expect(brood.write).toHaveBeenCalledOnce();
});


it("binds resumed publication to the original artifact-producing spawn", async () => {
  workerPatch.value = ADD_PATCH;
  const remote = gitAt(repoPath, "remote", "get-url", "origin").trim();
  gitAt(repoPath, "remote", "set-url", "origin", path.join(makeHome(), "missing.git"));
  const homeDir = makeHome();
  const original = integrationFixture();
  const input = { repoPath, branch, prompt: "do the thing", backend, homeDir, sliceId: "tracked-resume" };
  await expect(runHatcherySpawn({ ...input, ...original.request })).rejects.toMatchObject({
    outcome: { failureReason: "push_failed" },
  });
  const prior = original.write.mock.calls[0][1];
  gitAt(repoPath, "remote", "set-url", "origin", remote);
  launchCollision.value = true;
  const resumed = integrationFixture();
  resumed.request.attemptId = "another-attempt";
  await expect(runHatcherySpawn({ ...input, ...resumed.request })).rejects.toMatchObject({
    outcome: { failureReason: "pr_failed", spawnId: prior.spawnId, commit: prior.commit },
  });
  expect(resumed.bind).toHaveBeenLastCalledWith({ ...resumed.request, spawnId: prior.spawnId });
  expect(gitAt(remote, "rev-parse", "refs/heads/feature/" + branch).trim()).toBe(prior.commit?.commitSha);
});
