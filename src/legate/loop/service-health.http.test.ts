/**
 * @l1 @deterministic @ci
 *
 * The probe over real HTTP (a local listener): timeouts on headers and on a
 * stalled body. The injected-probe tests live in service-health.test.ts (L0).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchProbe, probeServices, readinessHealth, startRemedy } from "./service-health.js";

const NOW = new Date("2026-11-22T12:00:00.000Z");

describe("castra answering slower than the probe timeout", () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it("reads down 'not answering: timeout' through the real fetch probe", async () => {
    // A live /readyz that answers only after 1.5s, against a 100ms probe timeout.
    server = createServer((_req, res) => {
      setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end('{"ready":true,"state":"ok","reasons":[]}'), 1_500).unref();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    expect(await fetchProbe(`http://127.0.0.1:${port}/readyz`, 100)).toEqual({ answered: false, error: "timeout" });

    const started = Date.now();
    const services = await probeServices({
      env: { CASTRA_URL: `http://127.0.0.1:${port}`, MARCH_HATCHERY_URL: "http://127.0.0.1:1", MARCH_BROOD_URL: "http://127.0.0.1:1", MARCH_HERALD_URL: "http://127.0.0.1:1", MARCH_TESSERA_URL: "http://127.0.0.1:1" },
      timeoutMs: 100,
      now: () => NOW,
    });
    expect(Date.now() - started).toBeLessThan(1_400);
    expect(services.castra).toMatchObject({ state: "down", reasons: ["not answering: timeout"], remedy: startRemedy("castra") });
  });

  it("a 200 whose body stalls past the timeout is a timeout, not an ok probe", async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"ready":true,');
      setTimeout(() => res.end('"state":"ok","reasons":[]}'), 1_500).unref();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const probe = await fetchProbe(`http://127.0.0.1:${port}/readyz`, 100);
    expect(probe).toEqual({ answered: false, error: "timeout" });
    expect(readinessHealth("castra", probe, NOW.toISOString()).state).toBe("down");
  });
});
