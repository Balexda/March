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

// Issue #244 acceptance: a steward.apply failure must produce a span carrying the
// slice/spawn/worktree/patch diagnostics AND a trace-correlated log. This drives
// runHatcherySpawn to a REAL git-apply conflict (a new-file patch the worktree
// base already contains with different content — neither --index nor --3way can
// resolve it) with telemetry on, then inspects the steward.apply span + the
// emitted log record.

const { worktreePath, sendPrompt, workerPatch, recordedState } = vi.hoisted(() => ({
  worktreePath: { value: "" },
  sendPrompt: vi.fn(async () => {}),
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
      async (req: { title: string; group?: string; branch: string }) => ({
        sessionId: "ad-xyz",
        title: req.title,
        group: req.group ?? "g",
        branch: req.branch,
        worktreePath: worktreePath.value,
      }),
    ),
    removeSession: vi.fn(async () => ({ removed: true })),
    sendPrompt,
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
  execFileSync("git", ["remote", "add", "origin", "git@github.com:team/repo.git"], {
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
  expect(gitAt(worktreePath.value, "diff", "--cached", "--name-only")).toBe("new file.txt\n");
  expect(fs.readFileSync(path.join(repoPath, "f"), "utf8")).toBe("operator staged edit\n");
  expect(fs.readFileSync(path.join(repoPath, ".git", "index"))).toEqual(indexBefore);
  expect(fs.existsSync(path.join(repoPath, "new file.txt"))).toBe(false);
  expect(sendPrompt).toHaveBeenCalledTimes(1);
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
