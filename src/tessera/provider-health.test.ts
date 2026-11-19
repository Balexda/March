/** @l1 @deterministic @ci */
import { PassThrough } from "node:stream";
import type { BatchObservableCallback } from "@opentelemetry/api";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import * as otel from "../observability/otel.js";
import type { CredentialProvider, ProviderStatus } from "./models.js";
import { buildTesseraServer } from "./server.js";

function fakeProvider(identity: CredentialProvider["identity"], status: () => ProviderStatus, entries = 0): CredentialProvider {
  return { identity, id: `github-${identity}`, status, start: async () => {}, issue: vi.fn(), cacheSize: () => entries };
}

it("checks expiry without traffic and reports only safe provider status and bounded measurements", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-11-19T00:00:00Z"));
  const meterProvider = new MeterProvider();
  const meter = meterProvider.getMeter("test");
  vi.spyOn(otel, "getActiveOtel").mockReturnValue({ ...otel.getActiveOtel(), enabled: true, getMeter: () => meter });
  const register = vi.spyOn(meter, "addBatchObservableCallback");
  const unregister = vi.spyOn(meter, "removeBatchObservableCallback");
  const gauges = vi.spyOn(meter, "createObservableGauge");
  const stream = new PassThrough();
  const warnings: unknown[] = [];
  stream.on("data", chunk => warnings.push(JSON.parse(chunk.toString())));
  const userStatus: ProviderStatus = {
    provider: "SECRET_PROVIDER", state: "ok", login: "octocat",
    credential_expires_at: "2026-12-03T00:01:00Z", expiry_warning: false,
    last_error: "raw SECRET_UPSTREAM response", credentialRevision: { secret: "SECRET_REVISION" },
  };
  const appProvider = fakeProvider("app", () => ({
    provider: "github-app", state: "degraded", login: "march-bot[bot]",
    credential_expires_at: null, expiry_warning: false, last_error: "provider_unavailable",
  }), 3);
  const userProvider = fakeProvider("user", () => userStatus);
  const app = buildTesseraServer({ providers: [appProvider, userProvider], logger: pino({}, stream) });
  try {
    await app.ready();
    const measure = () => {
      const observe = vi.fn();
      const callback: BatchObservableCallback = register.mock.calls[0]![0];
      callback({ observe });
      return observe.mock.calls;
    };
    const remaining = gauges.mock.results[0]!.value;
    const warning = gauges.mock.results[1]!.value;
    const labels = { provider: "github-user" };

    expect(warnings).toHaveLength(0);
    expect(measure()).toEqual([[remaining, 14 * 86_400 + 60, labels], [warning, 0, labels]]);
    vi.advanceTimersByTime(60_000);
    expect(warnings).toHaveLength(1);
    expect(measure()).toEqual([[remaining, 14 * 86_400, labels], [warning, 1, labels]]);
    expect((await app.inject("/healthz")).json()).toEqual({ status: "ok" });
    const status = (await app.inject("/status")).json();
    expect(status).toMatchObject({
      providers: [
        { provider: "github-app", state: "degraded", credential_expires_at: null, expiry_warning: false, last_error: "provider_unavailable" },
        { provider: "github-user", login: "octocat", expiry_warning: true, last_error: null },
      ],
      soonest_expiry: "2026-12-03T00:01:00.000Z",
      cache: { entries: 3 },
    });
    expect(JSON.stringify(status)).not.toContain("SECRET");

    vi.advanceTimersByTime(86_400_000 - 60_000);
    expect(warnings).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(warnings).toHaveLength(2);

    userStatus.credentialRevision = {};
    vi.advanceTimersByTime(60_000);
    expect(warnings).toHaveLength(3);
    vi.setSystemTime(new Date(userStatus.credential_expires_at!));
    expect(measure()).toEqual([[remaining, 0, labels], [warning, 1, labels]]);

    userStatus.credential_expires_at = null;
    vi.advanceTimersByTime(60_000);
    expect(measure()).toEqual([]);
    expect((await app.inject("/status")).json()).toMatchObject({
      providers: [{ expiry_warning: false }, { credential_expires_at: null, expiry_warning: false }],
      soonest_expiry: null,
    });
    expect(warnings).toHaveLength(3);
    expect(JSON.stringify(warnings)).not.toContain("SECRET");
    expect(appProvider.issue).not.toHaveBeenCalled();
    expect(userProvider.issue).not.toHaveBeenCalled();
  } finally {
    await app.close();
    expect(unregister).toHaveBeenCalledWith(...register.mock.calls[0]!);
    vi.restoreAllMocks();
    vi.useRealTimers();
    await meterProvider.shutdown();
  }
});

it("re-arms the expiry warning when an unrevisioned credential changes, even between warnings", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-11-19T00:00:00Z"));
  const stream = new PassThrough();
  const warnings: Array<{ credential_expires_at: string }> = [];
  stream.on("data", chunk => warnings.push(JSON.parse(chunk.toString())));
  const userStatus: ProviderStatus = {
    provider: "github-user", state: "ok", login: "octocat",
    credential_expires_at: "2026-11-29T00:00:00Z", expiry_warning: false, last_error: null,
  };
  const app = buildTesseraServer({
    providers: [fakeProvider("user", () => userStatus)],
    logger: pino({}, stream),
  });
  try {
    await app.ready();
    expect(warnings).toHaveLength(1);

    userStatus.credential_expires_at = "2026-12-19T00:00:00Z";
    vi.advanceTimersByTime(60_000);
    expect(warnings).toHaveLength(1);

    userStatus.credential_expires_at = "2026-11-29T00:00:00Z";
    vi.advanceTimersByTime(60_000);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]!.credential_expires_at).toBe("2026-11-29T00:00:00.000Z");

    vi.advanceTimersByTime(60_000);
    expect(warnings).toHaveLength(2);
  } finally {
    await app.close();
    vi.useRealTimers();
  }
});
