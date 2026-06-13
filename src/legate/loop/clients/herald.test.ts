/**
 * @l0 @deterministic @ci
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HERALD_CURSOR_FILE, HERALD_DRAIN_PAGE_LIMIT, LegateHerald } from "./herald.js";
import type { HeraldClient } from "../../../herald/service/client.js";
import {
  emptyMultiProfileState,
  emptySystemState,
  type HeraldEvent,
  type MultiProfileState,
} from "../../../herald/events.js";

/** A stub of the methods LegateHerald uses on HeraldClient. */
function stubClient(over: Partial<{
  events: (q: { after?: number; limit?: number }) => Promise<{ events: HeraldEvent[]; lastSeq: number }>;
  stateAll: (at?: number) => Promise<MultiProfileState>;
  append: (body: unknown) => Promise<HeraldEvent>;
}> = {}): HeraldClient {
  return {
    events: over.events ?? (async () => ({ events: [], lastSeq: 0 })),
    stateAll: over.stateAll ?? (async () => emptyMultiProfileState()),
    append: over.append ?? (async (b) => ({ seq: 1, id: "id", ts: "t", source: "legate", ...(b as object) } as HeraldEvent)),
  } as unknown as HeraldClient;
}

/** Build an event; defaults to profile "p" unless the body overrides it. */
function ev(seq: number, body: Partial<HeraldEvent> & { type: string }): HeraldEvent {
  return { seq, id: "e" + seq, ts: "2026-05-20T00:00:00Z", source: "legate", profile: "p", ...body } as HeraldEvent;
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "legate-herald-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("LegateHerald cursor", () => {
  it("starts at 0 with no cursor file", () => {
    const herald = new LegateHerald({ stateDir: dir, client: stubClient() });
    expect(herald.lastCursor).toBe(0);
  });

  it("loads a persisted cursor on construction", () => {
    fs.writeFileSync(path.join(dir, HERALD_CURSOR_FILE), JSON.stringify({ seq: 12 }));
    const herald = new LegateHerald({ stateDir: dir, client: stubClient() });
    expect(herald.lastCursor).toBe(12);
  });

  it("ignores an unreadable/garbage cursor file (starts at 0)", () => {
    fs.writeFileSync(path.join(dir, HERALD_CURSOR_FILE), "not json");
    const herald = new LegateHerald({ stateDir: dir, client: stubClient() });
    expect(herald.lastCursor).toBe(0);
  });
});

describe("LegateHerald.consume", () => {
  it("seeds an empty fold on a fresh deployment, then drains + folds the inbox per profile", async () => {
    const stateAll = vi.fn(async () => emptyMultiProfileState());
    const events = vi.fn(async () => ({
      events: [
        ev(1, { profile: "p", type: "workers.changed", workers: { waiting: 0, running: 2, idle: 0, error: 0, stopped: 0, other: 0 } } as any),
        ev(2, { profile: "p", type: "slice.dispatched", sliceId: "s1", branch: "smithy/x" } as any),
      ],
      lastSeq: 2,
    }));
    const herald = new LegateHerald({ stateDir: dir, client: stubClient({ stateAll, events }) });

    const multi = await herald.consume();
    // cursor=0 => no seed from /state?all; folds the whole inbox.
    expect(stateAll).not.toHaveBeenCalled();
    expect(events).toHaveBeenCalledWith({ after: 0, limit: HERALD_DRAIN_PAGE_LIMIT });
    expect(multi.byProfile.p.workers).toMatchObject({ running: 2 });
    expect(herald.snapshotFor("p").slices.s1).toMatchObject({ branch: "smithy/x" });
    expect(herald.lastCursor).toBe(2);
    expect(JSON.parse(fs.readFileSync(path.join(dir, HERALD_CURSOR_FILE), "utf-8"))).toEqual({ seq: 2 });
  });

  it("folds different profiles into disjoint buckets (a shared sliceId never collides)", async () => {
    const events = vi.fn(async () => ({
      events: [
        ev(1, { profile: "a", type: "slice.dispatched", sliceId: "s1", branch: "a/s1" } as any),
        ev(2, { profile: "b", type: "slice.dispatched", sliceId: "s1", branch: "b/s1" } as any),
      ],
      lastSeq: 2,
    }));
    const herald = new LegateHerald({ stateDir: dir, client: stubClient({ events }) });
    await herald.consume();
    expect(herald.snapshotFor("a").slices.s1).toMatchObject({ branch: "a/s1" });
    expect(herald.snapshotFor("b").slices.s1).toMatchObject({ branch: "b/s1" });
  });

  it("advances the cursor across consecutive consumes (incremental drain)", async () => {
    const events = vi
      .fn()
      .mockResolvedValueOnce({ events: [ev(1, { type: "heartbeat" } as any)], lastSeq: 1 })
      .mockResolvedValueOnce({ events: [ev(2, { type: "slice.archived", sliceId: "s1" } as any)], lastSeq: 2 });
    const herald = new LegateHerald({ stateDir: dir, client: stubClient({ events: events as any }) });

    await herald.consume();
    expect(events).toHaveBeenLastCalledWith({ after: 0, limit: HERALD_DRAIN_PAGE_LIMIT });
    await herald.consume();
    expect(events).toHaveBeenLastCalledWith({ after: 1, limit: HERALD_DRAIN_PAGE_LIMIT });
    expect(herald.snapshotFor("p").slices.s1).toMatchObject({ archived: true });
    expect(herald.lastCursor).toBe(2);
  });

  it("seeds the fold from GET /state?all&at=<cursor> when resuming a persisted cursor", async () => {
    fs.writeFileSync(path.join(dir, HERALD_CURSOR_FILE), JSON.stringify({ seq: 5 }));
    const seeded: MultiProfileState = {
      seq: 5,
      ts: "t",
      byProfile: { p: { ...emptySystemState(), seq: 5, slices: { old: { sliceId: "old", stage: "pr-open" } } } },
    };
    const stateAll = vi.fn(async () => seeded);
    const events = vi.fn(async () => ({ events: [ev(6, { type: "slice.archived", sliceId: "old" } as any)], lastSeq: 6 }));
    const herald = new LegateHerald({ stateDir: dir, client: stubClient({ stateAll, events }) });

    await herald.consume();
    expect(stateAll).toHaveBeenCalledWith(5);
    expect(events).toHaveBeenCalledWith({ after: 5, limit: HERALD_DRAIN_PAGE_LIMIT });
    expect(herald.snapshotFor("p").slices.old).toMatchObject({ archived: true });
    expect(herald.lastCursor).toBe(6);
  });

  it("pages until caught up when the inbox backlog exceeds one page", async () => {
    const events = vi
      .fn()
      .mockResolvedValueOnce({ events: [ev(1, { type: "heartbeat" } as any), ev(2, { type: "heartbeat" } as any)], lastSeq: 2 })
      .mockResolvedValueOnce({ events: [ev(3, { type: "heartbeat" } as any), ev(4, { type: "heartbeat" } as any)], lastSeq: 4 })
      .mockResolvedValueOnce({ events: [ev(5, { type: "slice.archived", sliceId: "s1" } as any)], lastSeq: 5 });
    const herald = new LegateHerald({ stateDir: dir, client: stubClient({ events: events as any }), pageLimit: 2 });

    await herald.consume();
    expect(events).toHaveBeenCalledTimes(3);
    expect(events).toHaveBeenNthCalledWith(1, { after: 0, limit: 2 });
    expect(events).toHaveBeenNthCalledWith(2, { after: 2, limit: 2 });
    expect(events).toHaveBeenNthCalledWith(3, { after: 4, limit: 2 });
    expect(herald.snapshotFor("p").slices.s1).toMatchObject({ archived: true });
    expect(herald.lastCursor).toBe(5);
  });

  it("clamps a stale/too-high persisted cursor down to the seeded state's seq", async () => {
    fs.writeFileSync(path.join(dir, HERALD_CURSOR_FILE), JSON.stringify({ seq: 99 }));
    const stateAll = vi.fn(async () => ({ ...emptyMultiProfileState(), seq: 3 }));
    const events = vi.fn(async () => ({ events: [], lastSeq: 3 }));
    const herald = new LegateHerald({ stateDir: dir, client: stubClient({ stateAll, events }) });

    await herald.consume();
    expect(stateAll).toHaveBeenCalledWith(99);
    expect(events).toHaveBeenCalledWith({ after: 3, limit: HERALD_DRAIN_PAGE_LIMIT });
    expect(herald.lastCursor).toBe(3);
    expect(JSON.parse(fs.readFileSync(path.join(dir, HERALD_CURSOR_FILE), "utf-8"))).toEqual({ seq: 3 });
  });

  it("does not rewrite the cursor when the inbox is empty", async () => {
    const herald = new LegateHerald({ stateDir: dir, client: stubClient({ events: async () => ({ events: [], lastSeq: 0 }) }) });
    await herald.consume();
    expect(herald.lastCursor).toBe(0);
    expect(fs.existsSync(path.join(dir, HERALD_CURSOR_FILE))).toBe(false);
  });
});

describe("LegateHerald.takeRecoveryRequests (#238)", () => {
  it("captures recovery-request slice ids per profile drained this consume, then clears them", async () => {
    const events = vi.fn(async () => ({
      events: [
        ev(1, { profile: "p", type: "slice.escalated", sliceId: "s1", reason: "hatchery_dispatch_failed" } as any),
        ev(2, { profile: "p", type: "slice.recovery.requested", sliceId: "s1" } as any),
      ],
      lastSeq: 2,
    }));
    const herald = new LegateHerald({ stateDir: dir, client: stubClient({ events }) });

    await herald.consume();
    expect(herald.takeRecoveryRequests("p")).toEqual(["s1"]);
    // "take" semantics: a second read after no new drain returns nothing.
    expect(herald.takeRecoveryRequests("p")).toEqual([]);
  });

  it("scopes recovery requests to the most recent consume (resets each drain)", async () => {
    const events = vi
      .fn()
      .mockResolvedValueOnce({ events: [ev(1, { type: "slice.recovery.requested", sliceId: "s1" } as any)], lastSeq: 1 })
      .mockResolvedValueOnce({ events: [ev(2, { type: "heartbeat" } as any)], lastSeq: 2 });
    const herald = new LegateHerald({ stateDir: dir, client: stubClient({ events: events as any }) });

    await herald.consume();
    await herald.consume();
    expect(herald.takeRecoveryRequests("p")).toEqual([]);
  });

  it("keys recovery requests by the event's profile", async () => {
    const events = vi.fn(async () => ({
      events: [
        ev(1, { profile: "a", type: "slice.recovery.requested", sliceId: "s1" } as any),
        ev(2, { profile: "b", type: "slice.recovery.requested", sliceId: "s2" } as any),
      ],
      lastSeq: 2,
    }));
    const herald = new LegateHerald({ stateDir: dir, client: stubClient({ events }) });
    await herald.consume();
    expect(herald.takeRecoveryRequests("a")).toEqual(["s1"]);
    expect(herald.takeRecoveryRequests("b")).toEqual(["s2"]);
  });
});

describe("LegateHerald.takeStewardAttachments (#213/#265)", () => {
  it("surfaces slice.steward.attached drained this consume per profile, then clears them", async () => {
    const events = vi.fn(async () => ({
      events: [
        ev(1, {
          profile: "p",
          type: "slice.steward.attached",
          sliceId: "s1",
          sessionId: "sess-9",
          branch: "smithy/cut/s1",
          worktreePath: "/wt/s1",
        } as any),
      ],
      lastSeq: 1,
    }));
    const herald = new LegateHerald({ stateDir: dir, client: stubClient({ events }) });

    await herald.consume();
    expect(herald.takeStewardAttachments("p")).toEqual([
      { sliceId: "s1", sessionId: "sess-9", branch: "smithy/cut/s1", worktreePath: "/wt/s1" },
    ]);
    // "take" semantics: a second read after no new drain returns nothing.
    expect(herald.takeStewardAttachments("p")).toEqual([]);
  });

  it("scopes attachments to the most recent consume and keys them by profile", async () => {
    const events = vi
      .fn()
      .mockResolvedValueOnce({
        events: [
          ev(1, { profile: "a", type: "slice.steward.attached", sliceId: "s1", sessionId: "x" } as any),
          ev(2, { profile: "b", type: "slice.steward.attached", sliceId: "s2", sessionId: "y" } as any),
        ],
        lastSeq: 2,
      })
      .mockResolvedValueOnce({ events: [ev(3, { type: "heartbeat" } as any)], lastSeq: 3 });
    const herald = new LegateHerald({ stateDir: dir, client: stubClient({ events: events as any }) });

    await herald.consume();
    expect(herald.takeStewardAttachments("a")).toEqual([{ sliceId: "s1", sessionId: "x", branch: undefined, worktreePath: undefined }]);
    expect(herald.takeStewardAttachments("b")).toEqual([{ sliceId: "s2", sessionId: "y", branch: undefined, worktreePath: undefined }]);
    // Next drain has no attachments — the side-channel resets.
    await herald.consume();
    expect(herald.takeStewardAttachments("a")).toEqual([]);
  });
});

describe("LegateHerald.append", () => {
  it("delegates a transition event to the client write-path, stamped with the profile", async () => {
    const append = vi.fn(async (b: unknown) => ev(9, b as any));
    const herald = new LegateHerald({ stateDir: dir, client: stubClient({ append }) });
    const stored = await herald.append("march", { type: "slice.archived", sliceId: "s1" });
    expect(append).toHaveBeenCalledWith({ type: "slice.archived", sliceId: "s1", profile: "march" });
    expect(stored.seq).toBe(9);
  });
});
