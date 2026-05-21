import { describe, expect, it, vi } from "vitest";
import { apply, assess } from "./cleanup.js";
import type { HandlerContext, LoopState } from "../state/types.js";
import type { BroodTeardownResult } from "../clients/brood.js";

function loopState(over: Partial<LoopState> = {}): LoopState {
  return {
    ts: "T",
    statePresent: true,
    stateError: null,
    raw: { slices: {}, archived_slices: {} },
    slices: {},
    archived: {},
    repoPath: "/repo",
    workerGroup: "legate-workers",
    sessions: [],
    sessionsById: new Map(),
    workers: { waiting: 0, running: 0, idle: 0, error: 0, stopped: 0, other: 0 },
    smithy: { ok: true, ready: [], queue: { dispatchable: 0, blocked: 0, total: 0 } },
    perSlice: {},
    ...over,
  };
}

function ctx(teardown: (id: string) => BroodTeardownResult): HandlerContext {
  return {
    meta: { processor_name: "loop", paired_legate: "legate" } as any,
    ts: "T",
    castra: {} as any,
    broodTeardown: vi.fn(async (id: string) => teardown(id)),
    persist: vi.fn(),
    emit: vi.fn(),
    log: vi.fn(),
  };
}

const ok = (): BroodTeardownResult => ({ ok: true, notTracked: false, detail: "" });
const notTracked = (): BroodTeardownResult => ({ ok: false, notTracked: true, detail: "not tracked by Brood" });

describe("cleanup handler", () => {
  function withTerminalSlice(prState: string): LoopState {
    return loopState({
      raw: { slices: { s: { worker_session_id: "sess" } }, archived_slices: {} },
      slices: { s: { worker_session_id: "sess" } },
      sessions: [{ id: "sess", group: "g" }],
      perSlice: { s: { pr: { number: 9, url: "u", state: prState } } },
    });
  }

  it("assess flags MERGED/CLOSED PRs on active slices, ignores OPEN + sessionless", async () => {
    expect(assess(withTerminalSlice("MERGED")).map((d) => d.sliceId)).toEqual(["s"]);
    expect(assess(withTerminalSlice("CLOSED")).map((d) => d.terminalState)).toEqual(["CLOSED"]);
    expect(assess(withTerminalSlice("OPEN"))).toEqual([]);
    // no live session → not assessed
    const noSession = withTerminalSlice("MERGED");
    noSession.sessions = [];
    expect(assess(noSession)).toEqual([]);
  });

  it("apply requests Brood teardown then archives the slice on success", async () => {
    const state = withTerminalSlice("MERGED");
    const c = ctx(ok);
    const res = await apply(assess(state), c, state);
    expect(c.broodTeardown).toHaveBeenCalledWith("sess", { reason: "pr-merged" });
    expect(res.actions).toHaveLength(1);
    expect(state.raw.archived_slices.s).toMatchObject({ terminal_state: "MERGED", pr_number: 9 });
    expect(state.raw.slices.s).toBeUndefined();
    expect(state.sessionsById.has("sess")).toBe(false);
    expect(c.persist).toHaveBeenCalled();
  });

  it("apply DEFERS (does not archive) when Brood can't confirm teardown", async () => {
    const state = withTerminalSlice("MERGED");
    const c = ctx(notTracked);
    const res = await apply(assess(state), c, state);
    expect(res.failures).toHaveLength(1);
    expect(res.actions).toHaveLength(0);
    // slice stays live for retry — NOT archived over an orphan
    expect(state.raw.slices.s).toBeTruthy();
    expect(state.raw.archived_slices.s).toBeUndefined();
  });
});
