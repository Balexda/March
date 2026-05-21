import { describe, expect, it } from "vitest";
import { sqliteAvailable } from "./sqlite.js";
import { EventStore } from "./store.js";
import type { AppendEventInput, EventBody } from "../events.js";

function makeStore(snapshotEvery?: number): EventStore {
  return new EventStore({ dbPath: ":memory:", snapshotEvery });
}

const herald = (body: EventBody & { id?: string }): AppendEventInput => ({
  source: "herald",
  ...body,
} as AppendEventInput);

describe.skipIf(!sqliteAvailable)("EventStore", () => {
  it("append assigns a monotonic seq and fills id/ts", () => {
    const store = makeStore();
    const a = store.append(herald({ type: "smithy.queue.changed", dispatchable: 1, blocked: 0, total: 1 }));
    const b = store.append(herald({ type: "heartbeat" }));
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.id).toBeTruthy();
    expect(a.ts).toBeTruthy();
    expect(store.lastSeq()).toBe(2);
    expect(store.count()).toBe(2);
    store.close();
  });

  it("is idempotent on id (duplicate append does not advance seq)", () => {
    const store = makeStore();
    const first = store.append(herald({ id: "fixed", type: "heartbeat" }));
    const again = store.append(herald({ id: "fixed", type: "heartbeat" }));
    expect(again.seq).toBe(first.seq);
    expect(store.count()).toBe(1);
    store.close();
  });

  it("readAfter returns events strictly after the cursor, in order, capped by limit", () => {
    const store = makeStore();
    for (let i = 0; i < 5; i++) store.append(herald({ type: "heartbeat" }));
    const page = store.readAfter(2, 2);
    expect(page.map((e) => e.seq)).toEqual([3, 4]);
    expect(store.readAfter(5, 100)).toEqual([]);
    store.close();
  });

  it("range returns (from, to] events", () => {
    const store = makeStore();
    for (let i = 0; i < 5; i++) store.append(herald({ type: "heartbeat" }));
    expect(store.range(1, 3).map((e) => e.seq)).toEqual([2, 3]);
    store.close();
  });

  it("projection folds the appended events", () => {
    const store = makeStore();
    store.append(herald({ type: "smithy.queue.changed", dispatchable: 3, blocked: 2, total: 7 }));
    store.append(herald({ type: "slice.pr.changed", sliceId: "s1", pr: { number: 9, state: "OPEN" } }));
    const proj = store.projection();
    expect(proj.smithy).toEqual({ dispatchable: 3, blocked: 2, total: 7 });
    expect(proj.slices.s1.pr).toEqual({ number: 9, state: "OPEN" });
    expect(proj.seq).toBe(2);
    store.close();
  });

  it("projection() returns a defensive clone (mutating it does not corrupt the store)", () => {
    const store = makeStore();
    store.append(herald({ type: "slice.pr.changed", sliceId: "s1", pr: { state: "OPEN" } }));
    const proj = store.projection();
    (proj.slices.s1.pr as any).state = "MUTATED";
    expect((store.projection().slices.s1.pr as any).state).toBe("OPEN");
    store.close();
  });

  it("stateAt(seq) reconstructs the projection up to a point", () => {
    const store = makeStore();
    store.append(herald({ type: "smithy.queue.changed", dispatchable: 1, blocked: 0, total: 1 }));
    store.append(herald({ type: "smithy.queue.changed", dispatchable: 5, blocked: 0, total: 5 }));
    expect(store.stateAt(1).smithy.dispatchable).toBe(1);
    expect(store.stateAt(2).smithy.dispatchable).toBe(5);
    store.close();
  });

  it("snapshots let a fresh store rebuild the same projection (cold start)", () => {
    const dir = `/tmp/herald-store-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const dbPath = `${dir}/events.db`;
    const a = new EventStore({ dbPath, snapshotEvery: 2 });
    a.append(herald({ type: "smithy.queue.changed", dispatchable: 4, blocked: 1, total: 6 }));
    a.append(herald({ type: "slice.stage.changed", sliceId: "s1", stage: "pr-open" }));
    a.append(herald({ type: "slice.pr.changed", sliceId: "s1", pr: { state: "OPEN" } }));
    a.close();

    const b = new EventStore({ dbPath });
    const proj = b.projection();
    expect(proj.smithy.dispatchable).toBe(4);
    expect(proj.slices.s1.stage).toBe("pr-open");
    expect((proj.slices.s1.pr as any).state).toBe("OPEN");
    expect(proj.seq).toBe(3);
    b.close();
  });
});
