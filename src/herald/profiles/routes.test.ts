/**
 * @l1 @deterministic @ci
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { sqliteAvailable } from "../service/sqlite.js";
import { registerProfileRoutes, validateRegisterProfile } from "./routes.js";
import { ProfileStore } from "./store.js";

async function buildApp(): Promise<{ app: FastifyInstance; store: ProfileStore }> {
  const store = new ProfileStore({ dbPath: ":memory:" });
  const app = Fastify();
  await registerProfileRoutes(app, { store });
  return { app, store };
}

const body = (over: Record<string, unknown> = {}) => ({
  profile: "march",
  repoName: "March",
  repoPath: "/home/u/Development/March",
  workerGroup: "march-workers",
  ...over,
});

describe("validateRegisterProfile", () => {
  it("requires profile/repoName/repoPath/workerGroup", () => {
    expect(validateRegisterProfile({})).toMatchObject({ ok: false });
    expect(validateRegisterProfile({ profile: "march" })).toMatchObject({ ok: false });
    expect(validateRegisterProfile(body())).toMatchObject({ ok: true });
  });
  it("rejects an invalid profile name", () => {
    expect(validateRegisterProfile(body({ profile: "-bad" }))).toMatchObject({ ok: false });
    expect(validateRegisterProfile(body({ profile: "a".repeat(65) }))).toMatchObject({ ok: false });
    expect(validateRegisterProfile(body({ profile: "ok.name-1" }))).toMatchObject({ ok: true });
  });
  it("accepts a valid merge policy and normalizes it onto the input", () => {
    const result = validateRegisterProfile(body({ mergePolicy: { byTaskType: { cut: { approval: false } } } }));
    expect(result).toMatchObject({ ok: true, input: { mergePolicy: { byTaskType: { cut: { approval: false } } } } });
  });
  it("rejects a malformed merge policy", () => {
    expect(validateRegisterProfile(body({ mergePolicy: { byTaskType: { cut: { checks: false } } } }))).toMatchObject({
      ok: false,
    });
    expect(validateRegisterProfile(body({ mergePolicy: 42 }))).toMatchObject({ ok: false });
  });
  it("accepts a valid toolchain and carries it onto the input", () => {
    expect(validateRegisterProfile(body({ toolchain: "jvm" }))).toMatchObject({
      ok: true,
      input: { toolchain: "jvm" },
    });
    expect(validateRegisterProfile(body({ toolchain: "auto" }))).toMatchObject({ ok: true });
  });
  it("rejects an unknown toolchain", () => {
    expect(validateRegisterProfile(body({ toolchain: "rust" }))).toMatchObject({ ok: false });
    expect(validateRegisterProfile(body({ toolchain: 7 }))).toMatchObject({ ok: false });
  });
  it("omits toolchain when not provided", () => {
    const result = validateRegisterProfile(body());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.toolchain).toBeUndefined();
  });
  it("accepts a valid priority (including 0) and carries it onto the input", () => {
    expect(validateRegisterProfile(body({ priority: 0 }))).toMatchObject({ ok: true, input: { priority: 0 } });
    expect(validateRegisterProfile(body({ priority: 2 }))).toMatchObject({ ok: true, input: { priority: 2 } });
  });
  it("rejects a non-integer / negative priority", () => {
    expect(validateRegisterProfile(body({ priority: -1 }))).toMatchObject({ ok: false });
    expect(validateRegisterProfile(body({ priority: 1.5 }))).toMatchObject({ ok: false });
    expect(validateRegisterProfile(body({ priority: "0" }))).toMatchObject({ ok: false });
  });
  it("omits priority when not provided", () => {
    const result = validateRegisterProfile(body());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.priority).toBeUndefined();
  });
});

describe.skipIf(!sqliteAvailable)("profile routes", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("POST /profiles registers, GET /profiles lists, GET /profiles/:p fetches", async () => {
    const { app, store } = await buildApp();
    close = async () => {
      await app.close();
      store.close();
    };
    const post = await app.inject({ method: "POST", url: "/profiles", payload: body() });
    expect(post.statusCode).toBe(201);
    expect(post.json()).toMatchObject({ profile: "march", status: "active" });

    const list = await app.inject({ method: "GET", url: "/profiles" });
    expect(list.json().profiles.map((p: { profile: string }) => p.profile)).toEqual(["march"]);

    const one = await app.inject({ method: "GET", url: "/profiles/march" });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ repoName: "March" });

    const missing = await app.inject({ method: "GET", url: "/profiles/ghost" });
    expect(missing.statusCode).toBe(404);
  });

  it("POST /profiles with a bad body returns 400", async () => {
    const { app, store } = await buildApp();
    close = async () => {
      await app.close();
      store.close();
    };
    const post = await app.inject({ method: "POST", url: "/profiles", payload: { profile: "march" } });
    expect(post.statusCode).toBe(400);
  });

  it("POST /profiles round-trips a merge policy; a malformed policy is 400", async () => {
    const { app, store } = await buildApp();
    close = async () => {
      await app.close();
      store.close();
    };
    const policy = {
      byTaskType: { forge: { botApprovers: ["CodeRabbitAI[BOT]"] } },
      reviewRequests: { byTaskType: { forge: { reviewers: [{ id: "coderabbit" }] } } },
      dependencyUpdates: { autoMerge: true },
      codeRabbit: { rereview: true, initialReview: true },
    };
    const normalized = {
      ...policy,
      byTaskType: { forge: { botApprovers: ["coderabbitai"] } },
      reviewRequests: { byTaskType: { forge: { reviewers: [{ id: "coderabbit", mode: "comment-trigger" }] } } },
    };
    const ok = await app.inject({ method: "POST", url: "/profiles", payload: body({ mergePolicy: policy }) });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().mergePolicy).toEqual(normalized);

    const fetched = await app.inject({ method: "GET", url: "/profiles/march" });
    expect(fetched.json().mergePolicy).toEqual(normalized);

    const bad = await app.inject({
      method: "POST",
      url: "/profiles",
      payload: body({ mergePolicy: { byTaskType: { cut: { checks: false } } } }),
    });
    expect(bad.statusCode).toBe(400);
    expect(store.get("march")?.mergePolicy).toEqual(normalized);
  });

  it("DELETE /profiles/:p soft-removes; ?all=1 still surfaces it", async () => {
    const { app, store } = await buildApp();
    close = async () => {
      await app.close();
      store.close();
    };
    await app.inject({ method: "POST", url: "/profiles", payload: body() });
    const del = await app.inject({ method: "DELETE", url: "/profiles/march" });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ status: "removed" });

    expect((await app.inject({ method: "GET", url: "/profiles" })).json().profiles).toEqual([]);
    const all = await app.inject({ method: "GET", url: "/profiles?all=1" });
    expect(all.json().profiles.map((p: { profile: string }) => p.profile)).toEqual(["march"]);

    const delMissing = await app.inject({ method: "DELETE", url: "/profiles/ghost" });
    expect(delMissing.statusCode).toBe(404);
  });
});

describe.skipIf(!sqliteAvailable)("POST /profiles merge-policy history (#593)", () => {
  it("appends an attributed profile.merge_policy.changed only when the policy actually changes", async () => {
    const { EventStore } = await import("../service/store.js");
    const store = new ProfileStore({ dbPath: ":memory:" });
    const events = new EventStore({ dbPath: ":memory:", defaultProfile: "march" });
    const app = Fastify();
    await registerProfileRoutes(app, { store, events });
    try {
      // Plain registration without a policy: no history row.
      expect((await app.inject({ method: "POST", url: "/profiles", payload: body() })).statusCode).toBe(201);
      expect(events.readAfter(0, 10)).toHaveLength(0);

      const policy = { byTaskType: { cut: { approval: false } } };
      await app.inject({
        method: "POST",
        url: "/profiles",
        payload: body({ mergePolicy: policy, attribution: { operator: "ana", note: "cut PRs stranded" } }),
      });
      const [changed] = events.readAfter(0, 10);
      expect(changed).toMatchObject({
        type: "profile.merge_policy.changed",
        profile: "march",
        source: "herald",
        previous: null,
        mergePolicy: policy,
        operator: "ana",
        note: "cut PRs stranded",
      });

      // Re-register with the same policy (or omitting it, which preserves it): no new row.
      await app.inject({ method: "POST", url: "/profiles", payload: body({ mergePolicy: policy }) });
      await app.inject({ method: "POST", url: "/profiles", payload: body() });
      expect(events.readAfter(0, 10)).toHaveLength(1);

      // Clearing it is a change.
      await app.inject({ method: "POST", url: "/profiles", payload: body({ mergePolicy: {} }) });
      const rows = events.readAfter(0, 10);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ previous: policy, mergePolicy: null });
      expect(rows[1].operator).toBeUndefined();
    } finally {
      await app.close();
      store.close();
      events.close();
    }
  });
});
