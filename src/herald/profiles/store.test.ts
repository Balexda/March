import { describe, expect, it } from "vitest";
import { sqliteAvailable } from "../service/sqlite.js";
import { ProfileStore } from "./store.js";
import type { RegisterProfileInput } from "./types.js";

function makeStore(): ProfileStore {
  return new ProfileStore({ dbPath: ":memory:" });
}

const input = (over: Partial<RegisterProfileInput> = {}): RegisterProfileInput => ({
  profile: "march",
  repoName: "March",
  repoPath: "/home/u/Development/March",
  workerGroup: "march-workers",
  ...over,
});

describe.skipIf(!sqliteAvailable)("ProfileStore", () => {
  it("registers a profile and reads it back", () => {
    const store = makeStore();
    const rec = store.register(input({ conductorName: "march-legate-agent" }));
    expect(rec.profile).toBe("march");
    expect(rec.status).toBe("active");
    expect(rec.conductorName).toBe("march-legate-agent");
    expect(rec.createdAt).toBeTruthy();
    expect(store.get("march")).toMatchObject({ profile: "march", repoName: "March" });
    store.close();
  });

  it("upsert is idempotent and preserves createdAt while merging new fields", () => {
    const store = makeStore();
    const first = store.register(input());
    const second = store.register(input({ workerGroup: "renamed", broodEndpoint: "http://brood:9748" }));
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.workerGroup).toBe("renamed");
    expect(second.broodEndpoint).toBe("http://brood:9748");
    expect(store.count()).toBe(1);
    store.close();
  });

  it("list returns active profiles only by default; ?includeRemoved surfaces removed", () => {
    const store = makeStore();
    store.register(input({ profile: "a", repoName: "A", repoPath: "/a" }));
    store.register(input({ profile: "b", repoName: "B", repoPath: "/b" }));
    expect(store.list().map((p) => p.profile)).toEqual(["a", "b"]);
    store.remove("a");
    expect(store.list().map((p) => p.profile)).toEqual(["b"]);
    expect(store.list({ includeRemoved: true }).map((p) => p.profile)).toEqual(["a", "b"]);
    store.close();
  });

  it("remove soft-deletes; get hides it unless includeRemoved", () => {
    const store = makeStore();
    store.register(input({ profile: "a" }));
    const removed = store.remove("a");
    expect(removed?.status).toBe("removed");
    expect(store.get("a")).toBeUndefined();
    expect(store.get("a", { includeRemoved: true })?.status).toBe("removed");
    store.close();
  });

  it("re-registering a removed profile reactivates it and keeps the original createdAt", () => {
    const store = makeStore();
    const first = store.register(input({ profile: "a" }));
    store.remove("a");
    const back = store.register(input({ profile: "a" }));
    expect(back.status).toBe("active");
    expect(back.createdAt).toBe(first.createdAt);
    store.close();
  });

  it("remove on an unknown profile returns undefined", () => {
    const store = makeStore();
    expect(store.remove("ghost")).toBeUndefined();
    store.close();
  });
});
