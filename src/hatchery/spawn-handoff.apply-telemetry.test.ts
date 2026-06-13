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

// Issue #244 acceptance: a steward.apply failure must produce a span carrying the
// slice/spawn/worktree/patch diagnostics AND a trace-correlated log. This drives
// runHatcherySpawn to a REAL git-apply conflict (a new-file patch the worktree
// base already contains with different content — neither --index nor --3way can
// resolve it) with telemetry on, then inspects the steward.apply span + the
// emitted log record.

const { worktreePath } = vi.hoisted(() => ({
  worktreePath: { value: "" },
}));

// We exercise the steward.apply telemetry, not the #211 rollback — stub the
// exact-path removal so the real one doesn't warn about the temp worktree.
vi.mock("../brood/worktree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../brood/worktree.js")>();
  return { ...actual, removeSpawnWorktree: vi.fn() };
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
    sendPrompt: vi.fn(async () => {}),
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
const SPAWN_LOG = `__MARCH_PATCH_B64__:${Buffer.from(CONFLICTING_PATCH, "utf-8").toString("base64")}`;

vi.mock("../spawn/container-launch.js", () => {
  class LaunchError extends Error {}
  return {
    LaunchError,
    createSpawnContainer: vi.fn(() => "container-id"),
    copyPromptToContainer: vi.fn(),
    copyOtelEmitterToContainer: vi.fn(),
    startSpawnContainer: vi.fn(),
    waitForSpawnContainer: vi.fn(() => ({ exitCode: 0 })),
    readSpawnContainerLogs: vi.fn(() => SPAWN_LOG),
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
  return dir;
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
  vi.stubEnv("MARCH_BROOD_URL", "");
  vi.stubEnv("MARCH_HERALD_URL", "");
  initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
        repoPath: "/repo",
        prompt: "do the thing",
        backend,
        agentDeckProfile: "march",
        branch: "smithy/cut/01-spawn",
        sliceId: "my-slice-id",
        homeDir: home,
      }),
    ).rejects.toThrow(/git apply failed/);

    const span = created.find((s) => s.name === "steward.apply")!;
    expect(span).toBeDefined();
    expect(span.attributes).toMatchObject({
      "march.slice_id": "my-slice-id",
      "march.spawn_id": expect.stringMatching(/^\d{8}-[0-9a-f]{6}$/),
      "march.worktree": worktreePath.value,
      "march.patch.files": 1,
      "march.patch.first_path": "f",
      // Failure-only attrs: the parsed reject + offending path.
      "march.patch.offending_path": "f",
    });
    expect(span.attributes["march.patch.bytes"]).toBeGreaterThan(0);
    expect(String(span.attributes["march.patch.reject"])).toContain("already exists in index");

    // A trace-correlated log line for the failure.
    const logCall = emit.mock.calls.find(
      (c) => (c[0].attributes as Record<string, unknown>)?.event_kind === "steward_apply_failed",
    );
    expect(logCall).toBeDefined();
    expect(logCall![0].attributes).toMatchObject({
      "march.slice_id": "my-slice-id",
      "march.patch.offending_path": "f",
    });
  });
});
