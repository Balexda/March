import { describe, expect, it, vi } from "vitest";
import { senseState, type SenseDeps } from "./sense.js";
import type { LoopMeta } from "../meta.js";

const meta = { worker_group: "legate-workers", repo: { path: "/repo" } } as unknown as LoopMeta;

function deps(over: Partial<SenseDeps> = {}): SenseDeps {
  return {
    meta,
    now: () => "2026-05-20T00:00:00Z",
    readStateJson: () => ({
      repo: { path: "/repo", default_branch: "main" },
      slices: {},
      archived_slices: {},
    }),
    listSessions: async () => [],
    syncDefaultBranch: async () => {},
    readSmithyStatus: async () => ({ records: [], graph: {} }),
    queryPr: async () => ({}),
    sessionOutput: async () => ({ output: "" }),
    ...over,
  };
}

describe("senseState (Stage 1)", () => {
  it("assembles a snapshot with workers + smithy queue", async () => {
    const state = await senseState(
      deps({
        listSessions: async () => [{ id: "s1", group: "legate-workers", status: "running" }],
        readSmithyStatus: async () => ({
          records: [
            { path: "a", next_action: { command: "smithy.forge" } },
            { path: "b", next_action: { command: "smithy.cut" } },
          ],
          graph: {},
        }),
      }),
    );
    expect(state.statePresent).toBe(true);
    expect(state.workers).toMatchObject({ running: 1 });
    expect(state.smithy.ok).toBe(true);
    // both records are ready (no layer constraint) → 2 dispatchable
    expect(state.smithy.queue).toEqual({ dispatchable: 2, blocked: 0, total: 2 });
    expect(state.sessionsById.get("s1")).toBeTruthy();
  });

  it("captures state-read errors without throwing", async () => {
    const state = await senseState(
      deps({
        readStateJson: () => {
          throw new Error("corrupt");
        },
      }),
    );
    expect(state.statePresent).toBe(false);
    expect(state.stateError).toBe("corrupt");
  });

  it("surfaces a smithy read failure as smithy.ok=false (non-fatal)", async () => {
    const state = await senseState(
      deps({
        readSmithyStatus: async () => {
          throw new Error("smithy down");
        },
      }),
    );
    expect(state.smithy.ok).toBe(false);
    expect(state.smithy.error).toBe("smithy down");
  });

  it("fetches per-slice PR + output only for active slices with a live session", async () => {
    const queryPr = vi.fn(async () => ({ number: 7, state: "OPEN" }));
    const sessionOutput = vi.fn(async () => ({ output: "log" }));
    const state = await senseState(
      deps({
        readStateJson: () => ({
          repo: { path: "/repo" },
          slices: {
            active: { worker_session_id: "s1", stage: "pr-open" },
            terminal: { worker_session_id: "s2", stage: "merged" }, // skipped (terminal)
            noSession: { stage: "implementing" }, // skipped (no session)
            noLiveSession: { worker_session_id: "s9", stage: "implementing" }, // skipped (session absent)
          },
          archived_slices: {},
        }),
        listSessions: async () => [
          { id: "s1", group: "legate-workers", status: "idle" },
          { id: "s2", group: "legate-workers", status: "idle" },
        ],
        queryPr,
        sessionOutput,
      }),
    );
    expect(Object.keys(state.perSlice)).toEqual(["active"]);
    expect(state.perSlice.active!.pr).toMatchObject({ number: 7 });
    expect(queryPr).toHaveBeenCalledTimes(1);
    expect(sessionOutput).toHaveBeenCalledWith("s1");
  });

  it("discovers a PR for an implementing slice when queryPr skips", async () => {
    const discoverPr = vi.fn(async () => ({ number: 42, state: "OPEN" }));
    const state = await senseState(
      deps({
        readStateJson: () => ({
          repo: { path: "/repo" },
          slices: { impl: { worker_session_id: "s1", stage: "implementing" } },
          archived_slices: {},
        }),
        listSessions: async () => [{ id: "s1", group: "legate-workers", status: "idle" }],
        queryPr: async () => ({ skipped: true }),
        discoverPr,
        sessionOutput: async () => ({ output: "" }),
      }),
    );
    expect(discoverPr).toHaveBeenCalledWith(expect.anything(), expect.anything(), "/repo", "s1");
    expect(state.perSlice.impl!.pr).toMatchObject({ number: 42 });
  });

  it("emits a sync warning but still reads smithy when sync throws", async () => {
    const warn = vi.fn();
    const state = await senseState(
      deps({
        syncDefaultBranch: async () => {
          throw new Error("no remote");
        },
        warn,
      }),
    );
    expect(warn).toHaveBeenCalled();
    expect(state.smithy.ok).toBe(true);
  });
});
