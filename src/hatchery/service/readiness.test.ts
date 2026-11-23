/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  deriveReadiness,
  FALLBACK_UNSUPPORTED_REASON,
  GitHubCredentialChecker,
  SpawnWindow,
  SPAWN_WINDOW_SIZE,
  type GitHubCredentialCheck,
} from "./readiness.js";
import { dispatchReasonCode } from "../dispatch-reason.js";
import { HatcheryGitHubError } from "../github-read.js";

const OK_GITHUB: GitHubCredentialCheck = { ok: true, source: "tessera", reason: null };
const emptyWindow = () => new SpawnWindow().snapshot();

const TESSERA_ENV = { MARCH_TESSERA_URL: "http://tessera:9477", MARCH_TESSERA_CLIENT_KEY: "k" };
const statusBody = (appState: string) => ({
  service: "march-tessera", uptime_s: 1, soonest_expiry: null, cache: { entries: 0 },
  providers: [
    { provider: "github-app", state: appState, login: null, credential_expires_at: null, expiry_warning: false, last_error: null },
    { provider: "github-user", state: "ok", login: null, credential_expires_at: null, expiry_warning: false, last_error: null },
  ],
});
const fetchReturning = (impl: () => Promise<Response>) => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => { calls.push(String(url)); return impl(); }) as unknown as typeof fetch;
  return { fetchImpl, calls };
};

describe("GitHubCredentialChecker (Tessera is the only credential source)", () => {
  it("is ok only when Tessera is configured, reachable, and its github-app provider is ok", async () => {
    const { fetchImpl, calls } = fetchReturning(async () => Response.json(statusBody("ok")));
    const r = await new GitHubCredentialChecker({ env: TESSERA_ENV, fetchImpl }).check();
    expect(r).toEqual({ ok: true, source: "tessera", reason: null });
    expect(calls).toEqual(["http://tessera:9477/status"]);
  });

  it("is down tessera:provider_<state> when the github-app provider cannot vend", async () => {
    const { fetchImpl } = fetchReturning(async () => Response.json(statusBody("unconfigured")));
    expect(await new GitHubCredentialChecker({ env: TESSERA_ENV, fetchImpl }).check())
      .toEqual({ ok: false, source: "tessera", reason: "tessera:provider_unconfigured" });
  });

  it("is down tessera:unreachable when Tessera does not answer (or answers non-200)", async () => {
    const refused = fetchReturning(async () => { throw new TypeError("fetch failed"); });
    expect((await new GitHubCredentialChecker({ env: TESSERA_ENV, fetchImpl: refused.fetchImpl }).check()).reason)
      .toBe("tessera:unreachable");
    const erroring = fetchReturning(async () => new Response("x", { status: 500 }));
    expect((await new GitHubCredentialChecker({ env: TESSERA_ENV, fetchImpl: erroring.fetchImpl }).check()).reason)
      .toBe("tessera:unreachable");
  });

  it("times out a hanging Tessera instead of hanging /readyz", async () => {
    const fetchImpl = ((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
    const started = Date.now();
    const r = await new GitHubCredentialChecker({ env: TESSERA_ENV, fetchImpl, timeoutMs: 50 }).check();
    expect(r.reason).toBe("tessera:unreachable");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("caches the /status answer for the TTL", async () => {
    let t = 0;
    const { fetchImpl, calls } = fetchReturning(async () => Response.json(statusBody("ok")));
    const checker = new GitHubCredentialChecker({ env: TESSERA_ENV, fetchImpl, ttlMs: 5_000, now: () => t });
    await checker.check();
    t = 4_000;
    await checker.check();
    expect(calls).toHaveLength(1);
    t = 6_000;
    await checker.check();
    expect(calls).toHaveLength(2);
    expect(checker.latest?.ok).toBe(true);
  });

  it("the ambient-token fallback is reported but NOT ok (not a supported credential path)", async () => {
    const { fetchImpl, calls } = fetchReturning(async () => Response.json(statusBody("ok")));
    const r = await new GitHubCredentialChecker({
      env: { MARCH_TESSERA_URL: "http://tessera:9477", MARCH_TESSERA_GH_TOKEN_FALLBACK: "1", GH_TOKEN: "t" }, fetchImpl,
    }).check();
    expect(r).toEqual({ ok: false, source: "fallback", reason: FALLBACK_UNSUPPORTED_REASON });
    expect(calls).toEqual([]); // no client key: Tessera isn't configured for Hatchery, nothing to probe
  });

  it("is none / tessera:unconfigured — the 2026-11-22 incident config", async () => {
    // URL defaulted but no client key, fallback empty: every spawn failed.
    expect(await new GitHubCredentialChecker({ env: { MARCH_TESSERA_URL: "http://tessera:9477", GH_TOKEN: "t" } }).check())
      .toEqual({ ok: false, source: "none", reason: "tessera:unconfigured" });
    expect(await new GitHubCredentialChecker({ env: { MARCH_TESSERA_GH_TOKEN_FALLBACK: "1" } }).check())
      .toEqual({ ok: false, source: "none", reason: "tessera:unconfigured" });
  });
});

describe("SpawnWindow", () => {
  it("keeps only the last N outcomes and tracks consecutive failures", () => {
    const w = new SpawnWindow();
    for (let i = 0; i < SPAWN_WINDOW_SIZE + 5; i++) w.record(false, "tessera:unconfigured", `2026-11-22T00:00:${String(i).padStart(2, "0")}.000Z`);
    const snap = w.snapshot();
    expect(snap.recent).toBe(SPAWN_WINDOW_SIZE);
    expect(snap.failed).toBe(SPAWN_WINDOW_SIZE);
    expect(snap.consecutive_failures).toBe(SPAWN_WINDOW_SIZE + 5);
    expect(snap.last_error).toBe("tessera:unconfigured");
    expect(snap.last_error_at).toBe("2026-11-22T00:00:24.000Z");
    expect(snap.last_success_at).toBeNull();
  });

  it("a success resets the consecutive count but keeps the last error", () => {
    const w = new SpawnWindow(3);
    w.record(false, "worker_exit", "A");
    w.record(false, "worker_exit", "B");
    w.record(true, null, "C");
    expect(w.snapshot()).toEqual({
      recent: 3, failed: 2, consecutive_failures: 0,
      last_error: "worker_exit", last_error_at: "B", last_success_at: "C",
    });
    w.record(true, null, "D");
    expect(w.snapshot().failed).toBe(1); // "A" rolled out of the window
  });
});

describe("deriveReadiness", () => {
  it("is ok with every check passing and no reasons", () => {
    const r = deriveReadiness({ docker: true, castra: true, github: OK_GITHUB, spawns: emptyWindow() });
    expect(r).toMatchObject({ ready: true, state: "ok", reasons: [] });
  });

  it("a fallback-only credential is down", () => {
    const r = deriveReadiness({
      docker: true, castra: true, github: { ok: false, source: "fallback", reason: FALLBACK_UNSUPPORTED_REASON }, spawns: emptyWindow(),
    });
    expect(r.state).toBe("down");
    expect(r.reasons).toEqual(["no GitHub credential: " + FALLBACK_UNSUPPORTED_REASON]);
  });

  it("names an unreachable Tessera and a provider that cannot vend", () => {
    const at = (reason: string) => deriveReadiness({
      docker: true, castra: true, github: { ok: false, source: "tessera", reason }, spawns: emptyWindow(),
    });
    expect(at("tessera:unreachable").reasons[0]).toContain("Tessera is not reachable");
    expect(at("tessera:provider_degraded").reasons[0]).toContain("github-app provider is degraded");
  });

  it("is down with no GitHub credential, naming the code", () => {
    const r = deriveReadiness({
      docker: true, castra: true, github: { ok: false, source: "none", reason: "tessera:unconfigured" }, spawns: emptyWindow(),
    });
    expect(r).toMatchObject({ ready: false, state: "down" });
    expect(r.reasons.join(" ")).toContain("tessera:unconfigured");
  });

  it("is down when docker or castra is unavailable", () => {
    expect(deriveReadiness({ docker: false, castra: true, github: OK_GITHUB, spawns: emptyWindow() }).state).toBe("down");
    expect(deriveReadiness({ docker: true, castra: false, github: OK_GITHUB, spawns: emptyWindow() }).state).toBe("down");
  });

  it("degrades at 2 consecutive spawn failures and goes down at 5", () => {
    const w = new SpawnWindow();
    const at = () => deriveReadiness({ docker: true, castra: true, github: OK_GITHUB, spawns: w.snapshot() });
    w.record(false, "worker_exit");
    expect(at().state).toBe("ok");
    w.record(false, "worker_exit");
    expect(at().state).toBe("degraded");
    expect(at().reasons).toEqual(["the last 2 spawns failed (worker_exit)"]);
    w.record(false, "worker_exit");
    w.record(false, "worker_exit");
    expect(at().state).toBe("degraded");
    w.record(false, "worker_exit");
    expect(at()).toMatchObject({ state: "down", ready: false });
    w.record(true, null);
    expect(at().state).toBe("ok");
  });
});

describe("dispatchReasonCode", () => {
  it("passes a HatcheryGitHubError code through", () => {
    expect(dispatchReasonCode(new HatcheryGitHubError("tessera:unconfigured"))).toBe("tessera:unconfigured");
  });

  it("recovers the GitHub code from a worker-thread error message", () => {
    expect(dispatchReasonCode(new Error("Hatchery GitHub read failed (tessera:unreachable)"))).toBe("tessera:unreachable");
  });

  it("maps known failure classes to fixed codes and the rest to other", () => {
    expect(dispatchReasonCode(new Error("spawn worker exited with code 1 before reporting a result"))).toBe("worker_exit");
    expect(dispatchReasonCode("error: contract.md: already exists in index")).toBe("patch_apply_failed");
    expect(dispatchReasonCode(new Error("some brand-new failure with id 1234"))).toBe("other");
    expect(dispatchReasonCode(undefined)).toBe("other");
  });
});
