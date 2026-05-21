import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HERALD_CURSOR_FILE, HERALD_DRAIN_PAGE_LIMIT, LegateHerald } from "./herald.js";
import type { HeraldClient } from "../../../herald/service/client.js";
import { emptySystemState, type HeraldEvent, type SystemState } from "../../../herald/events.js";

/** A stub of the methods LegateHerald uses on HeraldClient. */
function stubClient(over: Partial<{
  events: (q: { after?: number; limit?: number }) => Promise<{ events: HeraldEvent[]; lastSeq: number }>;
  state: (at?: number) => Promise<SystemState>;
  append: (body: unknown) => Promise<HeraldEvent>;
}> = {}): HeraldClient {
  return {
    events: over.events ?? (async () => ({ events: [], lastSeq: 0 })),
    state: over.state ?? (async () => emptySystemState()),
    append: over.append ?? (async (b) => ({ seq: 1, id: "id", ts: "t", source: "legate", ...(b as object) } as HeraldEvent)),
  } as unknown as HeraldClient;
}

function ev(seq: number, body: Partial<HeraldEvent> & { type: string }): HeraldEvent {
  return { seq, id: "e" + seq, ts: "2026-05-20T00:00:00Z", source: "legate", ...body } as HeraldEvent;
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
    const herald = new LegateHerald({ conductorDir: dir, client: stubClient() });
    expect(herald.lastCursor).toBe(0);
  });

  it("loads a persisted cursor on construction", () => {
    fs.writeFileSync(path.join(dir, HERALD_CURSOR_FILE), JSON.stringify({ seq: 12 }));
    const herald = new LegateHerald({ conductorDir: dir, client: stubClient() });
    expect(herald.lastCursor).toBe(12);
  });

  it("ignores an unreadable/garbage cursor file (starts at 0)", () => {
    fs.writeFileSync(path.join(dir, HERALD_CURSOR_FILE), "not json");
    const herald = new LegateHerald({ conductorDir: dir, client: stubClient() });
    expect(herald.lastCursor).toBe(0);
  });
});

describe("LegateHerald.consume", () => {
  it("seeds an empty fold on a fresh deployment, then drains + folds the inbox", async () => {
    const state = vi.fn(async () => emptySystemState());
    const events = vi.fn(async () => ({
      events: [
        ev(1, { type: "workers.changed", workers: { waiting: 0, running: 2, idle: 0, error: 0, stopped: 0, other: 0 } } as any),
        ev(2, { type: "slice.dispatched", sliceId: "s1", branch: "smithy/x" } as any),
      ],
      lastSeq: 2,
    }));
    const herald = new LegateHerald({ conductorDir: dir, client: stubClient({ state, events }) });

    const sys = await herald.consume();
    // cursor=0 => no seed from /state; folds the whole inbox.
    expect(state).not.toHaveBeenCalled();
    expect(events).toHaveBeenCalledWith({ after: 0, limit: HERALD_DRAIN_PAGE_LIMIT });
    expect(sys.workers).toMatchObject({ running: 2 });
    expect(sys.slices.s1).toMatchObject({ branch: "smithy/x" });
    expect(herald.lastCursor).toBe(2);
    // cursor is persisted to disk.
    expect(JSON.parse(fs.readFileSync(path.join(dir, HERALD_CURSOR_FILE), "utf-8"))).toEqual({ seq: 2 });
  });

  it("advances the cursor across consecutive consumes (incremental drain)", async () => {
    const events = vi
      .fn()
      .mockResolvedValueOnce({ events: [ev(1, { type: "heartbeat" } as any)], lastSeq: 1 })
      .mockResolvedValueOnce({ events: [ev(2, { type: "slice.archived", sliceId: "s1" } as any)], lastSeq: 2 });
    const herald = new LegateHerald({ conductorDir: dir, client: stubClient({ events: events as any }) });

    await herald.consume();
    expect(events).toHaveBeenLastCalledWith({ after: 0, limit: HERALD_DRAIN_PAGE_LIMIT });
    const sys = await herald.consume();
    expect(events).toHaveBeenLastCalledWith({ after: 1, limit: HERALD_DRAIN_PAGE_LIMIT });
    expect(sys.slices.s1).toMatchObject({ archived: true });
    expect(herald.lastCursor).toBe(2);
  });

  it("seeds the fold from GET /state?at=<cursor> when resuming a persisted cursor", async () => {
    fs.writeFileSync(path.join(dir, HERALD_CURSOR_FILE), JSON.stringify({ seq: 5 }));
    const seeded = { ...emptySystemState(), seq: 5, slices: { old: { sliceId: "old", stage: "pr-open" } } };
    const state = vi.fn(async () => seeded as SystemState);
    const events = vi.fn(async () => ({ events: [ev(6, { type: "slice.archived", sliceId: "old" } as any)], lastSeq: 6 }));
    const herald = new LegateHerald({ conductorDir: dir, client: stubClient({ state, events }) });

    const sys = await herald.consume();
    expect(state).toHaveBeenCalledWith(5);
    expect(events).toHaveBeenCalledWith({ after: 5, limit: HERALD_DRAIN_PAGE_LIMIT });
    expect(sys.slices.old).toMatchObject({ archived: true });
    expect(herald.lastCursor).toBe(6);
  });

  it("pages until caught up when the inbox backlog exceeds one page", async () => {
    // pageLimit=2: a full page (2 events) means "maybe more"; a short page ends it.
    const events = vi
      .fn()
      .mockResolvedValueOnce({ events: [ev(1, { type: "heartbeat" } as any), ev(2, { type: "heartbeat" } as any)], lastSeq: 2 })
      .mockResolvedValueOnce({ events: [ev(3, { type: "heartbeat" } as any), ev(4, { type: "heartbeat" } as any)], lastSeq: 4 })
      .mockResolvedValueOnce({ events: [ev(5, { type: "slice.archived", sliceId: "s1" } as any)], lastSeq: 5 });
    const herald = new LegateHerald({ conductorDir: dir, client: stubClient({ events: events as any }), pageLimit: 2 });

    const sys = await herald.consume();
    expect(events).toHaveBeenCalledTimes(3);
    expect(events).toHaveBeenNthCalledWith(1, { after: 0, limit: 2 });
    expect(events).toHaveBeenNthCalledWith(2, { after: 2, limit: 2 });
    expect(events).toHaveBeenNthCalledWith(3, { after: 4, limit: 2 });
    expect(sys.slices.s1).toMatchObject({ archived: true });
    expect(herald.lastCursor).toBe(5);
  });

  it("clamps a stale/too-high persisted cursor down to the seeded state's seq", async () => {
    // Corrupt cursor file points past the log; GET /state returns a lower seq.
    fs.writeFileSync(path.join(dir, HERALD_CURSOR_FILE), JSON.stringify({ seq: 99 }));
    const state = vi.fn(async () => ({ ...emptySystemState(), seq: 3 }) as SystemState);
    const events = vi.fn(async () => ({ events: [], lastSeq: 3 }));
    const herald = new LegateHerald({ conductorDir: dir, client: stubClient({ state, events }) });

    await herald.consume();
    // Cursor clamps to 3 (not stuck at 99), so future reads can make progress.
    expect(state).toHaveBeenCalledWith(99);
    expect(events).toHaveBeenCalledWith({ after: 3, limit: HERALD_DRAIN_PAGE_LIMIT });
    expect(herald.lastCursor).toBe(3);
    expect(JSON.parse(fs.readFileSync(path.join(dir, HERALD_CURSOR_FILE), "utf-8"))).toEqual({ seq: 3 });
  });

  it("does not rewrite the cursor when the inbox is empty", async () => {
    const herald = new LegateHerald({ conductorDir: dir, client: stubClient({ events: async () => ({ events: [], lastSeq: 0 }) }) });
    await herald.consume();
    expect(herald.lastCursor).toBe(0);
    expect(fs.existsSync(path.join(dir, HERALD_CURSOR_FILE))).toBe(false);
  });
});

describe("LegateHerald.append", () => {
  it("delegates a transition event to the client write-path", async () => {
    const append = vi.fn(async (b: unknown) => ev(9, b as any));
    const herald = new LegateHerald({ conductorDir: dir, client: stubClient({ append }) });
    const stored = await herald.append({ type: "slice.archived", sliceId: "s1" });
    expect(append).toHaveBeenCalledWith({ type: "slice.archived", sliceId: "s1" });
    expect(stored.seq).toBe(9);
  });
});
