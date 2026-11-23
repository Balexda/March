/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  HATCHERY_CREDENTIAL_REMEDY,
  TESSERA_REMEDY,
  probeServices,
  serviceUrl,
  startRemedy,
  type ProbeFn,
  type ProbeResult,
} from "./service-health.js";

const NOW = new Date("2026-11-22T12:00:00.000Z");
const answered = (status: number, body: unknown): ProbeResult => ({ answered: true, status, body });
const tesseraStatus = (appState: string, lastError: string | null = null) => ({
  service: "march-tessera",
  uptime_s: 10,
  providers: [
    { provider: "github-app", state: appState, last_error: lastError },
    { provider: "github-user", state: "ok", last_error: null },
  ],
});
const okHatchery = {
  ready: true, state: "ok", docker: true, castra: true,
  github: { ok: true, source: "tessera", reason: null },
  spawns: { recent: 3, failed: 0, consecutive_failures: 0, last_error: null, last_error_at: null, last_success_at: "T" },
  reasons: [],
};

/** A probe answering by path, with per-path overrides. */
function probeWith(over: Record<string, ProbeResult | Error> = {}): { probe: ProbeFn; urls: string[] } {
  const urls: string[] = [];
  const defaults: Record<string, ProbeResult> = {
    "castra/readyz": answered(200, { ready: true, state: "ok", reasons: [], event_loop_lag_ms: 20, refused_sessions: [], recent_send_failures: 0 }),
    "herald/healthz": answered(200, { status: "ok" }),
    "hatchery/readyz": answered(200, okHatchery),
    "brood/readyz": answered(200, { ready: true, docker: true, git: true, castra: true }),
    "tessera/status": answered(200, tesseraStatus("ok")),
  };
  const probe: ProbeFn = async (url) => {
    urls.push(url);
    const key = Object.keys(defaults).find((k) => url.includes(k.split("/")[0]) && url.endsWith("/" + k.split("/")[1])) ?? "hatchery/readyz";
    const r = over[key] ?? defaults[key];
    if (r instanceof Error) throw r;
    return r;
  };
  return { probe, urls };
}

const run = (over: Record<string, ProbeResult | Error> = {}, env: NodeJS.ProcessEnv = { MARCH_TESSERA_URL: "http://tessera:9477" }) =>
  probeServices({ env, probe: probeWith(over).probe, now: () => NOW });

describe("probeServices", () => {
  it("probes readyz for hatchery/brood/castra, healthz for herald, status for tessera", async () => {
    const { probe, urls } = probeWith();
    await probeServices({ env: { MARCH_HATCHERY_URL: "http://h:1/" }, probe, now: () => NOW });
    expect(urls.sort()).toEqual([
      "http://brood:9748/readyz",
      "http://castra:9264/readyz",
      "http://h:1/readyz",
      "http://herald:8818/healthz",
      "http://tessera:9477/status",
    ]);
  });

  it("everything ok → every service ok with no remedy", async () => {
    const services = await run();
    for (const name of ["castra", "hatchery", "brood", "herald", "tessera"] as const) {
      expect(services[name]).toMatchObject({ state: "ok", reasons: [], remedy: null, checked_at: NOW.toISOString() });
    }
    expect(services.hatchery?.detail).toEqual(okHatchery);
  });

  it("hatchery down on no GitHub credential → credential remedy + readyz reasons", async () => {
    const body = {
      ...okHatchery, ready: false, state: "down",
      github: { ok: false, source: "none", reason: "tessera:unconfigured" },
      reasons: ["no GitHub credential (tessera:unconfigured)"],
    };
    const services = await run({ "hatchery/readyz": answered(503, body) });
    expect(services.hatchery).toMatchObject({
      state: "down", reasons: ["no GitHub credential (tessera:unconfigured)"], remedy: HATCHERY_CREDENTIAL_REMEDY, detail: body,
    });
  });

  it("hatchery degraded on consecutive failures → names the last error", async () => {
    const body = {
      ...okHatchery, state: "degraded",
      spawns: { ...okHatchery.spawns, consecutive_failures: 3, last_error: "worker_exit" },
      reasons: ["the last 3 spawns failed (worker_exit)"],
    };
    const services = await run({ "hatchery/readyz": answered(200, body) });
    expect(services.hatchery?.state).toBe("degraded");
    expect(services.hatchery?.remedy).toBe("Every recent spawn failed (worker_exit); see `march logs hatchery`.");
  });

  it("castra with a stalled event loop is down, and sessions refusing input degrade it, each with a remedy", async () => {
    const stalled = await run({ "castra/readyz": answered(503, {
      ready: false, state: "down", reasons: ["event loop lag p99 3400ms over the last minute"],
      event_loop_lag_ms: 3400, refused_sessions: [], recent_send_failures: 0,
    }) });
    expect(stalled.castra).toMatchObject({
      state: "down", reasons: ["event loop lag p99 3400ms over the last minute"],
      remedy: "Castra's event loop is stalled, so every session call waits; see `march logs castra`.",
    });
    const refusing = await run({ "castra/readyz": answered(200, {
      ready: true, state: "degraded", reasons: ["1 session refusing input"],
      event_loop_lag_ms: 20, refused_sessions: ["bc0d6044-1787157628"], recent_send_failures: 1,
    }) });
    expect(refusing.castra).toMatchObject({
      state: "degraded",
      remedy: "Steward session bc0d6044-1787157628 refuses input; run `march castra recover`, then check the pane.",
    });
  });

  it("an older hatchery/brood readyz without `state` falls back to `ready` and names false checks", async () => {
    const services = await run({ "brood/readyz": answered(503, { ready: false, docker: true, git: false, castra: true }) });
    expect(services.brood).toMatchObject({ state: "down", reasons: ["git check failed"] });
  });

  it("a service not answering is down with a start remedy; a throwing probe never rejects", async () => {
    const services = await run({
      "castra/readyz": { answered: false, error: "ECONNREFUSED" },
      "herald/healthz": new Error("boom"),
    });
    expect(services.castra).toMatchObject({ state: "down", reasons: ["not answering: ECONNREFUSED"], remedy: startRemedy("castra") });
    expect(services.herald).toMatchObject({ state: "down", reasons: ["not answering: error"] });
    expect(services.hatchery?.state).toBe("ok");
  });

  it("healthz answering non-2xx is down", async () => {
    const services = await run({ "herald/healthz": answered(500, null) });
    expect(services.herald).toMatchObject({ state: "down", reasons: ["healthz answered HTTP 500"] });
  });

  describe("tessera (the only GitHub credential source — no 'absent' state)", () => {
    it("is down 'not running' when unreachable, even with MARCH_TESSERA_URL unset", async () => {
      const services = await run({ "tessera/status": { answered: false, error: "ECONNREFUSED" } }, {});
      expect(services.tessera).toMatchObject({ state: "down", reasons: ["not running"], remedy: TESSERA_REMEDY });
    });

    it("is down 'not running' when the host does not resolve (not deployed)", async () => {
      const services = await run({ "tessera/status": { answered: false, error: "ENOTFOUND" } });
      expect(services.tessera).toMatchObject({ state: "down", reasons: ["not running"], remedy: TESSERA_REMEDY });
    });

    it("is down with the not-answering code on a timeout", async () => {
      const services = await run({ "tessera/status": { answered: false, error: "timeout" } });
      expect(services.tessera).toMatchObject({ state: "down", reasons: ["not answering: timeout"] });
    });

    it("is down when running but the github-app provider is unconfigured/degraded/invalid", async () => {
      for (const state of ["unconfigured", "degraded", "invalid"]) {
        const services = await run({ "tessera/status": answered(200, tesseraStatus(state)) });
        expect(services.tessera).toMatchObject({
          state: "down",
          reasons: [`Tessera is running but cannot vend GitHub credentials: github-app provider ${state}`],
          remedy: TESSERA_REMEDY,
        });
      }
      const withError = await run({ "tessera/status": answered(200, tesseraStatus("degraded", "mint failed")) });
      expect(withError.tessera?.reasons[0]).toContain("github-app provider degraded (mint failed)");
    });

    it("never reports a state outside ok|degraded|down", async () => {
      const services = await run({ "tessera/status": { answered: false, error: "ENOTFOUND" } }, {});
      for (const h of Object.values(services)) expect(["ok", "degraded", "down"]).toContain(h!.state);
    });
  });
});

describe("serviceUrl", () => {
  it("uses the env override (trailing slash trimmed) else the compose default", () => {
    expect(serviceUrl("tessera", {})).toBe("http://tessera:9477");
    expect(serviceUrl("castra", { CASTRA_URL: "http://localhost:9300/" })).toBe("http://localhost:9300");
  });
});
