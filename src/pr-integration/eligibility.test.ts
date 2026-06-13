import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SessionStore } from "../brood/service/store.js";
import { sqliteAvailable } from "../brood/service/sqlite.js";
import type {
  ExtractionResult,
  SessionRecord,
} from "../brood/service/types.js";
import {
  evaluateExtractionEligibility,
  integratePullRequest,
  prIntegrationRepositoryFromBrood,
  type EligiblePrExtraction,
} from "./eligibility.js";

const NOW = new Date("2026-06-13T00:00:00.000Z");

function patchText(): string {
  return [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
}

function patchSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function succeededExtraction(
  overrides: Partial<ExtractionResult> = {},
): ExtractionResult {
  const base = {
    spawnId: "spawn-1",
    backend: "codex" as const,
    status: "succeeded" as const,
    patch: {
      spawnId: "spawn-1",
      backend: "codex" as const,
      patchText: patchText(),
      touchedPaths: ["README.md"],
      sha256: patchSha256(patchText()),
    },
    extractedAt: "2026-06-13T00:00:00.000Z",
  };
  return { ...base, ...overrides } as ExtractionResult;
}

function failedExtraction(): ExtractionResult {
  return {
    spawnId: "spawn-1",
    backend: "codex",
    status: "failed",
    failureReason: "invalid-patch",
    diagnostic: "patch rejected; token secret:hunter2@example.invalid",
    extractedAt: "2026-06-13T00:00:00.000Z",
  };
}

function makeStore(extractionResult?: ExtractionResult): SessionStore {
  const store = new SessionStore({ dbPath: ":memory:" });
  store.register({
    id: "spawn-1",
    kind: "spawn",
    status: "stopped",
    backend: "codex",
    branch: "march/spawn/spawn-1",
    worktreePath: "/worktrees/spawn-1",
    extractionResult,
  });
  return store;
}

describe.skipIf(!sqliteAvailable)("PR integration eligibility", () => {
  it("admits a successful matching extraction and passes only validated metadata onward", () => {
    const store = makeStore(succeededExtraction());
    const nextStage = vi.fn((eligible: EligiblePrExtraction) => ({
      spawnId: eligible.spawnId,
      status: "succeeded" as const,
      completedAt: NOW.toISOString(),
    }));

    const result = integratePullRequest(
      { spawnId: "spawn-1", backend: "codex", traceKey: "slice-1" },
      {
        repository: prIntegrationRepositoryFromBrood(store),
        now: () => NOW,
        nextStage,
      },
    );

    expect(result.status).toBe("succeeded");
    expect(nextStage).toHaveBeenCalledWith({
      spawnId: "spawn-1",
      backend: "codex",
      patchText: patchText(),
      touchedPaths: ["README.md"],
      patchSha256: patchSha256(patchText()),
      extractedAt: "2026-06-13T00:00:00.000Z",
    });
    store.close();
  });

  it("rejects failed extraction without invoking downstream mutation behavior", () => {
    const store = makeStore(failedExtraction());
    const nextStage = vi.fn();

    const result = integratePullRequest(
      { spawnId: "spawn-1", backend: "codex" },
      {
        repository: prIntegrationRepositoryFromBrood(store),
        now: () => NOW,
        nextStage,
      },
    );

    expect(result).toMatchObject({
      status: "failed",
      failureReason: "extraction-failed",
      completedAt: NOW.toISOString(),
    });
    expect(result.diagnostic).toContain("[redacted]");
    expect(nextStage).not.toHaveBeenCalled();
    store.close();
  });

  it("fails fast when extraction state is missing", () => {
    const store = makeStore();
    const nextStage = vi.fn();

    const result = integratePullRequest(
      { spawnId: "spawn-1", backend: "codex" },
      {
        repository: prIntegrationRepositoryFromBrood(store),
        now: () => NOW,
        nextStage,
      },
    );

    expect(result.failureReason).toBe("missing-extraction");
    expect(result.diagnostic).toBe(
      "No persisted extraction result is available for this spawn.",
    );
    expect(nextStage).not.toHaveBeenCalled();
    store.close();
  });

  it("rejects spawn id or backend mismatches before downstream mutation behavior", () => {
    const store = makeStore(
      succeededExtraction({
        backend: "claude-code",
        patch: {
          spawnId: "spawn-1",
          backend: "claude-code",
          patchText: patchText(),
          touchedPaths: ["README.md"],
          sha256: patchSha256(patchText()),
        },
      }),
    );
    const nextStage = vi.fn();

    const result = integratePullRequest(
      { spawnId: "spawn-1", backend: "codex" },
      {
        repository: prIntegrationRepositoryFromBrood(store),
        now: () => NOW,
        nextStage,
      },
    );

    expect(result.failureReason).toBe("lifecycle-mismatch");
    expect(nextStage).not.toHaveBeenCalled();
    store.close();
  });

  it("rejects successful extraction metadata that does not match the patch text", () => {
    const store = makeStore(
      succeededExtraction({
        patch: {
          spawnId: "spawn-1",
          backend: "codex",
          patchText: patchText(),
          touchedPaths: ["src/other.ts"],
          sha256: patchSha256(patchText()),
        },
      }),
    );
    const nextStage = vi.fn();

    const result = integratePullRequest(
      { spawnId: "spawn-1", backend: "codex" },
      {
        repository: prIntegrationRepositoryFromBrood(store),
        now: () => NOW,
        nextStage,
      },
    );

    expect(result.failureReason).toBe("malformed-extraction");
    expect(nextStage).not.toHaveBeenCalled();
    store.close();
  });

  it("rejects empty, whitespace-only, or normalized no-op patches", () => {
    for (const patch of [
      "",
      " \n\t ",
      "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n",
    ]) {
      const store = makeStore(
        succeededExtraction({
          patch: {
            spawnId: "spawn-1",
            backend: "codex",
            patchText: patch,
            touchedPaths: ["README.md"],
            sha256: patchSha256(patch),
          },
        }),
      );
      const nextStage = vi.fn();

      const result = integratePullRequest(
        { spawnId: "spawn-1", backend: "codex" },
        {
          repository: prIntegrationRepositoryFromBrood(store),
          now: () => NOW,
          nextStage,
        },
      );

      expect(result.failureReason).toBe("noop-patch");
      expect(nextStage).not.toHaveBeenCalled();
      store.close();
    }
  });

  it("admits a mode-only diff as a real, reviewable change", () => {
    const modePatch = [
      "diff --git a/script.sh b/script.sh",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n");
    const store = makeStore(
      succeededExtraction({
        patch: {
          spawnId: "spawn-1",
          backend: "codex",
          patchText: modePatch,
          touchedPaths: ["script.sh"],
          sha256: patchSha256(modePatch),
        },
      }),
    );
    const nextStage = vi.fn((eligible: EligiblePrExtraction) => ({
      spawnId: eligible.spawnId,
      status: "succeeded" as const,
      completedAt: NOW.toISOString(),
    }));

    const result = integratePullRequest(
      { spawnId: "spawn-1", backend: "codex" },
      {
        repository: prIntegrationRepositoryFromBrood(store),
        now: () => NOW,
        nextStage,
      },
    );

    expect(result.status).toBe("succeeded");
    expect(nextStage).toHaveBeenCalledTimes(1);
    store.close();
  });
});

describe("evaluateExtractionEligibility patch-shape guard", () => {
  const lifecycle: SessionRecord = {
    id: "spawn-1",
    kind: "spawn",
    status: "stopped",
    backend: "codex",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };

  it("returns terminal malformed-extraction instead of throwing on a bad patch", () => {
    // A persisted "succeeded" result whose patch is not a valid object — the
    // dereference must not throw before the refusal path runs.
    const malformed = {
      spawnId: "spawn-1",
      backend: "codex",
      status: "succeeded",
      patch: null,
      extractedAt: NOW.toISOString(),
    } as unknown as ExtractionResult;

    const decision = evaluateExtractionEligibility(
      { spawnId: "spawn-1", backend: "codex" },
      lifecycle,
      malformed,
    );

    expect(decision.ok).toBe(false);
    expect(decision.ok ? undefined : decision.reason).toBe(
      "malformed-extraction",
    );
  });
});
