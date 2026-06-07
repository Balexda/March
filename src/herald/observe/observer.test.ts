import { describe, expect, it } from "vitest";
import { describeChangeSpan, runObservation, type ObserveStore } from "./observer.js";
import { emptySystemState, foldEvents, reduce, type AppendEventInput, type EventBody, type HeraldEvent, type SystemState } from "../events.js";
import type { SenseDeps } from "../../legate/loop/state/sense.js";
import type { LoopMeta } from "../../legate/loop/meta.js";

const meta = { worker_group: "legate-workers", repo: { path: "/repo" } } as unknown as LoopMeta;

const PROFILE = "p";

/** An in-memory store double that folds appended events into a hot projection. */
function fakeStore(): ObserveStore & { events: HeraldEvent[]; projection(): SystemState } {
  const events: HeraldEvent[] = [];
  const hot = emptySystemState();
  let seq = 0;
  return {
    events,
    projection: () => structuredClone(hot),
    // Single-profile double: every profile resolves to the one hot projection.
    projectionFor: () => structuredClone(hot),
    append(input: AppendEventInput): HeraldEvent {
      seq += 1;
      const ev = { ...input, seq, id: `e${seq}`, ts: input.ts ?? "t", profile: input.profile ?? PROFILE } as HeraldEvent;
      events.push(ev);
      reduce(hot, ev);
      return ev;
    },
  };
}

function senseDeps(over: Partial<SenseDeps> = {}): SenseDeps {
  return {
    meta,
    now: () => "2026-05-20T00:00:00Z",
    listSessions: async () => [],
    syncDefaultBranch: async () => {},
    readSmithyStatus: async () => ({ records: [], graph: {} }),
    queryPr: async () => ({}),
    sessionOutput: async () => ({ output: "" }),
    ...over,
  };
}

describe("runObservation", () => {
  it("appends change events for an observed delta and advances the projection", async () => {
    const store = fakeStore();
    const result = await runObservation({
      store,
      profile: PROFILE,
      senseDeps: senseDeps({
        listSessions: async () => [{ id: "w1", group: "legate-workers", status: "running" }],
        readSmithyStatus: async () => ({
          records: [
            { path: "a", next_action: { command: "smithy.forge" } },
            { path: "b", next_action: { command: "smithy.cut" } },
          ],
          graph: {},
        }),
      }),
    });
    const types = result.appended.map((e) => e.type);
    expect(types).toContain("workers.changed");
    expect(types).toContain("smithy.queue.changed");
    expect(result.observedAt).toBe("2026-05-20T00:00:00Z");
    expect(store.projection().workers).toMatchObject({ running: 1 });
  });

  it("is idempotent: a second identical observation appends nothing", async () => {
    const store = fakeStore();
    const deps = senseDeps({
      listSessions: async () => [{ id: "w1", group: "legate-workers", status: "running" }],
    });
    const first = await runObservation({ store, profile: PROFILE, senseDeps: deps });
    expect(first.appended.length).toBeGreaterThan(0);
    const second = await runObservation({ store, profile: PROFILE, senseDeps: deps });
    expect(second.appended).toEqual([]);
  });

  it("observes the PR/output of a slice it learned from its own projection", async () => {
    const store = fakeStore();
    // The legate's slice.dispatched transition seeds Herald's projection with the
    // slice→branch/session mapping — no state.json read.
    store.append({ source: "legate", type: "slice.dispatched", sliceId: "x", branch: "smithy/forge/x", sessionId: "w1" } as AppendEventInput);
    const result = await runObservation({
      store,
      profile: PROFILE,
      senseDeps: senseDeps({
        listSessions: async () => [{ id: "w1", group: "legate-workers", status: "idle" }],
        queryPr: async () => ({ number: 12, state: "OPEN" }),
        sessionOutput: async () => ({ output: "building" }),
      }),
    });
    const types = result.appended.map((e) => e.type);
    expect(types).toContain("slice.pr.changed");
    expect(types).toContain("slice.output.changed");
    expect(store.projection().slices.x!.pr).toMatchObject({ number: 12 });
  });

  it("emits the terminal MERGED for a tracked PR whose branch is gone (#288)", async () => {
    const store = fakeStore();
    store.append({ source: "legate", type: "slice.dispatched", sliceId: "x", branch: "smithy/forge/x", sessionId: "w1" } as AppendEventInput);
    const deps = (pr: unknown) =>
      senseDeps({
        listSessions: async () => [{ id: "w1", group: "legate-workers", status: "idle" }],
        queryPr: async () => pr as any,
        sessionOutput: async () => ({ output: "building" }),
      });
    // Tick 1: the PR is OPEN, tracked by number.
    await runObservation({ store, profile: PROFILE, senseDeps: deps({ number: 276, state: "OPEN" }) });
    expect(store.projection().slices.x!.pr).toMatchObject({ number: 276, state: "OPEN" });
    // Tick 2: the PR merged. Its branch/steward are gone, but the number still
    // resolves to MERGED — that terminal fact must reach the log so the legate archives.
    const merged = await runObservation({ store, profile: PROFILE, senseDeps: deps({ number: 276, state: "MERGED" }) });
    expect(merged.appended.map((e) => e.type)).toContain("slice.pr.changed");
    expect(store.projection().slices.x!.pr).toMatchObject({ number: 276, state: "MERGED" });
  });

  it("suppresses a None blip that would null a tracked PR number (#288)", async () => {
    const store = fakeStore();
    store.append({ source: "legate", type: "slice.dispatched", sliceId: "x", branch: "smithy/forge/x", sessionId: "w1" } as AppendEventInput);
    const deps = (pr: unknown) =>
      senseDeps({
        listSessions: async () => [{ id: "w1", group: "legate-workers", status: "idle" }],
        queryPr: async () => pr as any,
        sessionOutput: async () => ({ output: "building" }),
      });
    // Tick 1: PR tracked by number.
    await runObservation({ store, profile: PROFILE, senseDeps: deps({ number: 276, state: "OPEN" }) });
    // Tick 2: a transient numberless None observation (e.g. the branch was deleted
    // and rediscovery came back empty) must NOT null the tracked PR — no event, and
    // the projection keeps the number so the next by-number query can still see MERGED.
    const blip = await runObservation({
      store,
      profile: PROFILE,
      senseDeps: deps({ skipped: true, reason: "missing_pr_number" }),
    });
    expect(blip.appended.map((e) => e.type)).not.toContain("slice.pr.changed");
    expect(store.projection().slices.x!.pr).toMatchObject({ number: 276, state: "OPEN" });
  });

  it("surfaces a query error on a tracked PR without losing the number (#292 review)", async () => {
    const store = fakeStore();
    store.append({ source: "legate", type: "slice.dispatched", sliceId: "x", branch: "smithy/forge/x", sessionId: "w1" } as AppendEventInput);
    const deps = (queryPr: SenseDeps["queryPr"]) =>
      senseDeps({
        listSessions: async () => [{ id: "w1", group: "legate-workers", status: "idle" }],
        queryPr,
        sessionOutput: async () => ({ output: "" }),
      });
    await runObservation({ store, profile: PROFILE, senseDeps: deps(async () => ({ number: 276, state: "OPEN" })) });
    // The next by-number query fails (auth/rate/network). senseObserved records
    // `{error}`; the fold must surface it (so the legate's babysit acts) yet keep
    // the number so the slice stays queryable.
    const errored = await runObservation({
      store,
      profile: PROFILE,
      senseDeps: deps(async () => {
        throw new Error("gh: rate limited");
      }),
    });
    expect(errored.appended.map((e) => e.type)).toContain("slice.pr.changed");
    expect(store.projection().slices.x!.pr).toMatchObject({ number: 276, state: "OPEN", error: "gh: rate limited" });
  });

  it("does not throw while emitting change spans (no-op when telemetry off)", async () => {
    const store = fakeStore();
    store.append({ source: "legate", type: "slice.dispatched", sliceId: "x", branch: "smithy/forge/x", sessionId: "w1" } as AppendEventInput);
    await expect(
      runObservation({
        store,
        profile: PROFILE,
        senseDeps: senseDeps({
          listSessions: async () => [{ id: "w1", group: "legate-workers", status: "idle" }],
          queryPr: async () => ({ number: 7, state: "OPEN" }),
        }),
      }),
    ).resolves.toBeDefined();
  });

  it("stamps appended events with the observation ts", async () => {
    const store = fakeStore();
    const result = await runObservation({
      store,
      profile: PROFILE,
      senseDeps: senseDeps({ now: () => "2026-05-20T09:09:09Z" }),
    });
    for (const e of result.appended) expect(e.ts).toBe("2026-05-20T09:09:09Z");
    // sanity: the events fold back to the same projection the store holds
    expect(foldEvents(store.events).seq).toBe(store.projection().seq);
  });
});

describe("describeChangeSpan", () => {
  const base = emptySystemState();

  it("names a PR opened/merged/closed from the new state, defaulting to changed", () => {
    const opened = describeChangeSpan(base, { type: "slice.pr.changed", sliceId: "s1", pr: { number: 3, state: "OPEN" } });
    expect(opened?.name).toBe("herald.pr.opened");
    expect(opened?.dispatchKey).toBe("s1");
    expect(opened?.attributes).toMatchObject({ "march.slice_id": "s1", "march.pr_number": 3, "march.pr_state": "OPEN" });

    expect(describeChangeSpan(base, { type: "slice.pr.changed", sliceId: "s1", pr: { state: "MERGED" } })?.name).toBe("herald.pr.merged");
    expect(describeChangeSpan(base, { type: "slice.pr.changed", sliceId: "s1", pr: { state: "CLOSED" } })?.name).toBe("herald.pr.closed");
  });

  it("treats a PR already-open in the prior projection as a generic change, not a re-open", () => {
    const prev: SystemState = { ...emptySystemState(), slices: { s1: { sliceId: "s1", pr: { state: "OPEN" } } } };
    expect(describeChangeSpan(prev, { type: "slice.pr.changed", sliceId: "s1", pr: { number: 3, state: "OPEN" } })?.name).toBe("herald.pr.changed");
  });

  it("nests slice-scoped changes (dispatchKey set) and leaves system changes standalone", () => {
    expect(describeChangeSpan(base, { type: "slice.output.changed", sliceId: "s1", recentOutput: { output: "x" } })?.dispatchKey).toBe("s1");
    expect(describeChangeSpan(base, { type: "workers.changed", workers: { waiting: 0, running: 1, idle: 0, error: 0, stopped: 0, other: 0 } })?.dispatchKey).toBeUndefined();
    expect(describeChangeSpan(base, { type: "smithy.queue.changed", dispatchable: 1, blocked: 0, total: 2 })?.name).toBe("herald.queue.changed");
  });

  it("flags output that carries an error", () => {
    const span = describeChangeSpan(base, { type: "slice.output.changed", sliceId: "s1", recentOutput: { output: "boom", error: "login required" } });
    expect(span?.attributes).toMatchObject({ "march.output_error": true });
  });

  it("returns undefined for non-observed event types", () => {
    expect(describeChangeSpan(base, { type: "heartbeat" } as EventBody)).toBeUndefined();
  });
});
