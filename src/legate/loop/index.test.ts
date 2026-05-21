import { describe, expect, it } from "vitest";
import { reconcileBroodEnv, reconcileOtelEnv } from "./index.js";
import type { LoopMeta } from "./meta.js";

const meta = (over: Record<string, unknown> = {}): LoopMeta =>
  ({
    otel: { enabled: true, endpoint: "http://otel-lgtm:4318" },
    brood_endpoint: "http://brood:9748",
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
