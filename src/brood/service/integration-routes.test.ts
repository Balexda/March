/**
 * @l1 @deterministic @ci
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { BroodClient } from "./client.js";
import { registerRoutes } from "./routes.js";
import { getDatabaseSync, sqliteAvailable } from "./sqlite.js";
import { SessionStore } from "./store.js";
import type { PrIntegrationFailure, PrIntegrationResult } from "./types.js";

const spawnId = "spawn-1";
const completedAt = "2020-09-10T10:00:00.000Z";
const missing: PrIntegrationFailure = {
  spawnId,
  completedAt,
  status: "failed",
  failureReason: "missing_lifecycle",
  diagnostic: `Missing lifecycle for token="secret key". ${"x".repeat(800)}`,
  worktreePath: "/repo/worktree",
};

describe.skipIf(!sqliteAvailable)("terminal integration registry", () => {
  it("migrates legacy sessions and keeps a terminal failure without a session across restart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "brood-integration-"));
    const dbPath = path.join(directory, "registry.db");
    const deadline = new Date(Date.now() + 60_000).toISOString();
    let store = new SessionStore({ dbPath });
    const legacy = store.register({ id: "old-spawn", kind: "spawn" });
    store.close();
    const DatabaseSync = getDatabaseSync();
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec("DROP TABLE integration_attempts");
    legacyDb.close();

    store = new SessionStore({ dbPath });
    const app = Fastify();
    try {
      await registerRoutes(app, { store });
      const brood = new BroodClient({
        fetchImpl: async (input, init) => {
          const result = await app.inject({
            url: new URL(String(input)).pathname,
            method: init?.method as "GET" | "POST" | "PUT",
            headers: Object.fromEntries(new Headers(init?.headers)),
            payload: typeof init?.body === "string" ? init.body : undefined,
          });
          return new Response(result.body, { status: result.statusCode });
        },
      });
      expect(await brood.get("old-spawn")).toEqual(legacy);
      expect(await brood.readIntegrationOutcome("old-spawn")).toBeNull();
      const binding = { attemptId: "dispatch/1", spawnId, stewardDeadline: deadline };
      const pending = await brood.registerIntegrationAttempt(binding);
      expect(pending).toEqual({ ...binding, fenced: false, outcome: null });
      expect(await brood.registerIntegrationAttempt(binding)).toEqual(pending);
      const persisted = await brood.writeIntegrationOutcome(binding.attemptId, missing);
      expect(persisted.status).toBe("failed");
      if (persisted.status !== "failed") throw new Error("Expected terminal failure");
      expect(persisted.diagnostic).toContain("[redacted]");
      expect(persisted.diagnostic).not.toContain("secret key");
      expect(persisted.diagnostic).toHaveLength(500);
      expect(await brood.writeIntegrationOutcome(binding.attemptId, missing)).toEqual(persisted);
      expect(await brood.confirmIntegrationFailure(binding.attemptId)).toEqual({ ...pending, outcome: persisted });
      expect(await brood.readIntegrationOutcome(spawnId)).toEqual(persisted);
      expect(await brood.get(spawnId)).toBeUndefined();

      store.close();
      store = new SessionStore({ dbPath });
      expect(store.integration.readIntegrationAttempt(binding.attemptId).outcome).toEqual(persisted);
      expect(store.integration.readIntegrationOutcome(spawnId)).toEqual(persisted);
      expect(store.list()).toEqual([legacy]);
    } finally {
      await app.close();
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fences late completion, delayed registration, and writes from superseded attempts", () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    const registry = store.integration;
    const stewardDeadline = new Date(Date.now() + 60_000).toISOString();
    try {
      expect(registry.confirmIntegrationFailure("delayed")).toEqual({
        attemptId: "delayed", fenced: true, outcome: null, spawnId: null, stewardDeadline: null,
      });
      expect(() => registry.registerIntegrationAttempt({ attemptId: "delayed", spawnId, stewardDeadline })).toThrow("fenced");
      const first = { attemptId: "first", spawnId, stewardDeadline };
      registry.registerIntegrationAttempt(first);
      registry.registerIntegrationAttempt({ ...first, attemptId: "successor" });
      expect(registry.readIntegrationOutcome(spawnId)).toBeNull();
      expect(() => registry.registerIntegrationAttempt(first)).toThrow("fenced");
      expect(() => registry.writeIntegrationOutcome(first.attemptId, missing)).toThrow("fenced");

      expect(registry.confirmIntegrationFailure("successor")).toMatchObject({ fenced: true, outcome: null });
      expect(() => registry.writeIntegrationOutcome("successor", missing)).toThrow("fenced");
      registry.registerIntegrationAttempt({ ...first, attemptId: "expired", stewardDeadline: completedAt });
      expect(() => registry.writeIntegrationOutcome("expired", missing)).toThrow("exceeded");
      const timeout = { ...missing, failureReason: "timeout", diagnostic: "Steward deadline exceeded" } as const;
      expect(registry.writeIntegrationOutcome("expired", timeout)).toEqual(timeout);
    } finally {
      store.close();
    }
  });

  it("retains the winning outcome and preserves its exact application, branch, commit and PR", () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    const registry = store.integration;
    const stewardDeadline = new Date(Date.now() + 60_000).toISOString();
    const first = { attemptId: "exact", spawnId, stewardDeadline };
    const branch = "march/steward/exact";
    const success: PrIntegrationResult = {
      spawnId, completedAt, status: "succeeded",
      application: { spawnId, status: "applied", touchedPaths: ["src/hello.ts"], appliedAt: completedAt },
      commit: { spawnId, branch, commitSha: "f".repeat(40), patchSha256: "e".repeat(64), committedAt: completedAt },
      pullRequest: {
        provider: "github", repository: "owner/repo", number: 1, url: "https://github.com/owner/repo/pull/1",
        headBranch: branch, baseBranch: "main", state: "open", observedAt: completedAt,
      },
    };
    try {
      registry.registerIntegrationAttempt(first);
      expect(() => registry.writeIntegrationOutcome(first.attemptId, success)).toThrow("registered spawn");
      store.register({ id: spawnId, kind: "spawn" });
      expect(registry.writeIntegrationOutcome(first.attemptId, success)).toEqual(success);
      expect(registry.confirmIntegrationFailure(first.attemptId).outcome).toEqual(success);
      expect(() => registry.writeIntegrationOutcome(first.attemptId, missing)).toThrow("already has a terminal outcome");
      registry.registerIntegrationAttempt({ ...first, attemptId: "next" });
      expect(registry.readIntegrationOutcome(spawnId)).toBeNull();
      expect(registry.readIntegrationAttempt(first.attemptId).outcome).toEqual(success);
      expect(registry.readIntegrationAttempt("next").outcome).toBeNull();
    } finally {
      store.close();
    }
  });
});
