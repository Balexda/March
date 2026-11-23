/**
 * @l0 @deterministic @ci
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchProbe,
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
  github: { ok: true, source: "fallback", reason: null },
  spawns: { recent: 3, failed: 0, consecutive_failures: 0, last_error: null, last_error_at: null, last_success_at: "T" },
  reasons: [],
};

/** A probe answering by path, with per-path overrides. */
function probeWith(over: Record<string, ProbeResult | Error> = {}): { probe: ProbeFn; urls: string[] } {
  const urls: string[] = [];
  const defaults: Record<string, ProbeResult> = {
    "castra/healthz": answered(200, { status: "ok" }),
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
  it("probes readyz for hatchery/brood, healthz for castra/herald, status for tessera", async () => {
    const { probe, urls } = probeWith();
    await probeServices({ env: { MARCH_HATCHERY_URL: "http://h:1/" }, probe, now: () => NOW });
    expect(urls.sort()).toEqual([
      "http://brood:9748/readyz",
      "http://castra:9264/healthz",
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

  it("an older hatchery/brood readyz without `state` falls back to `ready` and names false checks", async () => {
    const services = await run({ "brood/readyz": answered(503, { ready: false, docker: true, git: false, castra: true }) });
    expect(services.brood).toMatchObject({ state: "down", reasons: ["git check failed"] });
  });

  it("a service not answering is down with a start remedy; a throwing probe never rejects", async () => {
    const services = await run({
      "castra/healthz": { answered: false, error: "ECONNREFUSED" },
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

describe("castra answering slower than the probe timeout", () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it("reads down 'not answering: timeout' through the real fetch probe", async () => {
    // A live /healthz that answers only after 1.5s, against a 100ms probe timeout.
    server = createServer((_req, res) => {
      setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}'), 1_500).unref();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    expect(await fetchProbe(`http://127.0.0.1:${port}/healthz`, 100)).toEqual({ answered: false, error: "timeout" });

    const started = Date.now();
    const services = await probeServices({
      env: { CASTRA_URL: `http://127.0.0.1:${port}`, MARCH_HATCHERY_URL: "http://127.0.0.1:1", MARCH_BROOD_URL: "http://127.0.0.1:1", MARCH_HERALD_URL: "http://127.0.0.1:1", MARCH_TESSERA_URL: "http://127.0.0.1:1" },
      timeoutMs: 100,
      now: () => NOW,
    });
    expect(Date.now() - started).toBeLessThan(1_400);
    expect(services.castra).toMatchObject({ state: "down", reasons: ["not answering: timeout"], remedy: startRemedy("castra") });
  });
});

describe("serviceUrl", () => {
  it("uses the env override (trailing slash trimmed) else the compose default", () => {
    expect(serviceUrl("tessera", {})).toBe("http://tessera:9477");
    expect(serviceUrl("castra", { CASTRA_URL: "http://localhost:9300/" })).toBe("http://localhost:9300");
  });
});
