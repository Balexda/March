/**
 * @l1 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const syncDefaultBranch = vi.fn(async () => ({ default_branch: "main", synced: true, head: "abc" }));
const toSenseDeps = vi.fn(() => ({ marker: "senseDeps" }));
vi.mock("../../observe/sense-io.js", () => ({
  createSenseIo: vi.fn(() => ({ syncDefaultBranch, toSenseDeps })),
}));

const { buildObserveDeps } = await import("./server.js");

describe("buildObserveDeps (production observe wiring, #601)", () => {
  const app = { log: { warn: vi.fn() } } as unknown as FastifyInstance;
  const meta = { profile: "p", repo: { name: "r", path: "/repo" }, worker_group: "g" } as never;

  it("always attaches the default-branch sync, with no flag set", async () => {
    const prev = process.env.MARCH_HERALD_SYNC;
    delete process.env.MARCH_HERALD_SYNC;
    try {
      const deps = buildObserveDeps(meta, app, {} as never);
      expect(deps.senseDeps).toEqual({ marker: "senseDeps" });
      expect(typeof deps.syncDefaultBranch).toBe("function");
      await deps.syncDefaultBranch("/repo", "main");
      expect(syncDefaultBranch).toHaveBeenCalledWith({ repo: { path: "/repo", default_branch: "main" } });
    } finally {
      if (prev !== undefined) process.env.MARCH_HERALD_SYNC = prev;
    }
  });
});
