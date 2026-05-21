import { describe, expect, it } from "vitest";
import { reconcileBroodEnv, reconcileHeraldEnv, reconcileOtelEnv } from "./index.js";
import type { LoopMeta } from "./meta.js";

const meta = (over: Record<string, unknown> = {}): LoopMeta =>
  ({
    otel: { enabled: true, endpoint: "http://otel-lgtm:4318" },
    brood_endpoint: "http://brood:9748",
    herald_endpoint: "http://herald:8818",
    ...over,
  }) as unknown as LoopMeta;

describe("reconcileOtelEnv", () => {
  it("falls back to meta.otel when env is unset, but lets env win", () => {
    const fresh: NodeJS.ProcessEnv = {};
    reconcileOtelEnv(meta(), fresh);
    expect(fresh.MARCH_OTEL).toBe("1");
    expect(fresh.MARCH_OTEL_ENDPOINT).toBe("http://otel-lgtm:4318");

    const explicit: NodeJS.ProcessEnv = { MARCH_OTEL_ENDPOINT: "http://host:4318" };
    reconcileOtelEnv(meta(), explicit);
    expect(explicit.MARCH_OTEL_ENDPOINT).toBe("http://host:4318");
  });

  it("defaults the service name to march-legate (dashboard contract), env wins", () => {
    const fresh: NodeJS.ProcessEnv = {};
    reconcileOtelEnv(meta(), fresh);
    expect(fresh.MARCH_OTEL_SERVICE_NAME).toBe("march-legate");

    const explicit: NodeJS.ProcessEnv = { MARCH_OTEL_SERVICE_NAME: "custom" };
    reconcileOtelEnv(meta(), explicit);
    expect(explicit.MARCH_OTEL_SERVICE_NAME).toBe("custom");
  });
});

describe("reconcileBroodEnv", () => {
  it("sets MARCH_BROOD_URL from meta.brood_endpoint when unset", () => {
    const env: NodeJS.ProcessEnv = {};
    reconcileBroodEnv(meta(), env);
    expect(env.MARCH_BROOD_URL).toBe("http://brood:9748");
  });

  it("lets an explicit MARCH_BROOD_URL win", () => {
    const env: NodeJS.ProcessEnv = { MARCH_BROOD_URL: "http://localhost:9748" };
    reconcileBroodEnv(meta(), env);
    expect(env.MARCH_BROOD_URL).toBe("http://localhost:9748");
  });

  it("no-ops when meta has no brood endpoint", () => {
    const env: NodeJS.ProcessEnv = {};
    reconcileBroodEnv(meta({ brood_endpoint: null }), env);
    expect(env.MARCH_BROOD_URL).toBeUndefined();
  });
});

describe("reconcileHeraldEnv", () => {
  it("sets MARCH_HERALD_URL from meta.herald_endpoint when unset", () => {
    const env: NodeJS.ProcessEnv = {};
    reconcileHeraldEnv(meta(), env);
    expect(env.MARCH_HERALD_URL).toBe("http://herald:8818");
  });

  it("lets an explicit MARCH_HERALD_URL win", () => {
    const env: NodeJS.ProcessEnv = { MARCH_HERALD_URL: "http://localhost:8818" };
    reconcileHeraldEnv(meta(), env);
    expect(env.MARCH_HERALD_URL).toBe("http://localhost:8818");
  });

  it("no-ops when meta has no herald endpoint (deployment stays on the legacy path)", () => {
    const env: NodeJS.ProcessEnv = {};
    reconcileHeraldEnv(meta({ herald_endpoint: null }), env);
    expect(env.MARCH_HERALD_URL).toBeUndefined();
  });
});
