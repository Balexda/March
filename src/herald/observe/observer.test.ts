import { describe, expect, it } from "vitest";
import { runObservation, type ObserveStore } from "./observer.js";
import { emptySystemState, foldEvents, reduce, type AppendEventInput, type HeraldEvent, type SystemState } from "../events.js";
import type { SenseDeps } from "../../legate/loop/state/sense.js";
import type { LoopMeta } from "../../legate/loop/meta.js";

const meta = { worker_group: "legate-workers", repo: { path: "/repo" } } as unknown as LoopMeta;

/** An in-memory store double that folds appended events into a hot projection. */
function fakeStore(): ObserveStore & { events: HeraldEvent[]; projection(): SystemState } {
  const events: HeraldEvent[] = [];
  const hot = emptySystemState();
  let seq = 0;
  return {
    events,
    projection: () => structuredClone(hot),
    append(input: AppendEventInput): HeraldEvent {
      seq += 1;
      const ev = { ...input, seq, id: `e${seq}`, ts: input.ts ?? "t" } as HeraldEvent;
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
    readStateJson: () => ({ repo: { path: "/repo", default_branch: "main" }, slices: {}, archived_slices: {} }),
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
    const first = await runObservation({ store, senseDeps: deps });
    expect(first.appended.length).toBeGreaterThan(0);
    const second = await runObservation({ store, senseDeps: deps });
    expect(second.appended).toEqual([]);
  });

  it("stamps appended events with the observation ts", async () => {
    const store = fakeStore();
    const result = await runObservation({
      store,
      senseDeps: senseDeps({ now: () => "2026-05-20T09:09:09Z" }),
    });
    for (const e of result.appended) expect(e.ts).toBe("2026-05-20T09:09:09Z");
    // sanity: the events fold back to the same projection the store holds
    expect(foldEvents(store.events).seq).toBe(store.projection().seq);
  });
});
