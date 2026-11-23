/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  deriveReadiness,
  githubCredentialCheck,
  SpawnWindow,
  SPAWN_WINDOW_SIZE,
  type GitHubCredentialCheck,
} from "./readiness.js";
import { dispatchReasonCode } from "../dispatch-reason.js";
import { HatcheryGitHubError } from "../github-read.js";

const OK_GITHUB: GitHubCredentialCheck = { ok: true, source: "tessera", reason: null };
const emptyWindow = () => new SpawnWindow().snapshot();

describe("githubCredentialCheck", () => {
  it("is tessera when the Tessera URL + client key are configured", () => {
    expect(githubCredentialCheck({ MARCH_TESSERA_URL: "http://tessera:9477", MARCH_TESSERA_CLIENT_KEY: "k" }))
      .toEqual({ ok: true, source: "tessera", reason: null });
  });

  it("is fallback (still ok) with the explicit fallback flag and an ambient token", () => {
    expect(githubCredentialCheck({ MARCH_TESSERA_URL: "http://tessera:9477", MARCH_TESSERA_GH_TOKEN_FALLBACK: "1", GH_TOKEN: "t" }))
      .toEqual({ ok: true, source: "fallback", reason: null });
    expect(githubCredentialCheck({ MARCH_TESSERA_GH_TOKEN_FALLBACK: "1", GH_TOKEN: " ", GITHUB_TOKEN: "t2" }).source)
      .toBe("fallback");
  });

  it("is none / fallback:no_token when the flag is on but no token is forwarded", () => {
    expect(githubCredentialCheck({ MARCH_TESSERA_GH_TOKEN_FALLBACK: "1", GH_TOKEN: "" }))
      .toEqual({ ok: false, source: "none", reason: "fallback:no_token" });
  });

  it("is none / tessera:unconfigured — the 2026-11-22 incident config", () => {
    // URL defaulted but no client key, fallback empty: every spawn failed.
    expect(githubCredentialCheck({ MARCH_TESSERA_URL: "http://tessera:9477", MARCH_TESSERA_GH_TOKEN_FALLBACK: "", GH_TOKEN: "t" }))
      .toEqual({ ok: false, source: "none", reason: "tessera:unconfigured" });
    expect(githubCredentialCheck({})).toEqual({ ok: false, source: "none", reason: "tessera:unconfigured" });
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

  it("fallback credential is reported but NOT degraded", () => {
    const r = deriveReadiness({ docker: true, castra: true, github: { ok: true, source: "fallback", reason: null }, spawns: emptyWindow() });
    expect(r.state).toBe("ok");
    expect(r.github.source).toBe("fallback");
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
