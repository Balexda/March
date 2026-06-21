/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import { CASTRA_TOKEN_ENV } from "../castra/config.js";
import { MARCH_SERVICES } from "./services.js";
import { stackUpgrade } from "./upgrade.js";
import type { ResolvedToken } from "./up.js";

const locateAll = (b: string) => `/repo/docker/${b}`;
const stubToken: ResolvedToken = { token: "tok-123", source: "file" };

/** Record every docker invocation so order + flags can be asserted. */
function recorder() {
  const calls: { args: string[]; token?: string }[] = [];
  const run = (_file: string, args: string[], env?: NodeJS.ProcessEnv) => {
    calls.push({ args, token: env?.[CASTRA_TOKEN_ENV] });
  };
  return { calls, run };
}

describe("stackUpgrade — recreate", () => {
  it("force-recreates every service in dependency order, never building", async () => {
    const { calls, run } = recorder();

    const result = await stackUpgrade({
      run,
      locate: locateAll,
      resolveToken: () => stubToken,
    });

    expect(result.services.map((s) => s.service)).toEqual(
      MARCH_SERVICES.map((s) => s.name),
    );
    expect(result.services.every((s) => s.outcome === "upgraded")).toBe(true);

    // Every call is a force-recreate that never builds; nothing is a `docker build`.
    expect(calls.every((c) => c.args[0] === "compose")).toBe(true);
    expect(calls.some((c) => c.args.includes("build"))).toBe(false);
    expect(calls.every((c) => c.args.includes("--force-recreate"))).toBe(true);
    expect(calls.every((c) => c.args.includes("--no-build"))).toBe(true);

    // One recreate per service, walked in declared (dependency) order, each
    // carrying the shared token.
    expect(calls).toHaveLength(MARCH_SERVICES.length);
    const order = calls.map(
      (c) => c.args[c.args.indexOf("-f") + 1].match(/docker\/(.+)\.docker-compose/)![1],
    );
    expect(order).toEqual(MARCH_SERVICES.map((s) => s.name));
    expect(calls.every((c) => c.token === "tok-123")).toBe(true);
  });
});

describe("stackUpgrade — --service", () => {
  it("upgrades only the named service", async () => {
    const { calls, run } = recorder();
    const result = await stackUpgrade({
      service: "herald",
      run,
      locate: locateAll,
      resolveToken: () => stubToken,
    });
    expect(result.services.map((s) => s.service)).toEqual(["herald"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.join(" ")).toContain("herald");
  });

  it("reports an unknown service without touching anything or resolving a token", async () => {
    const run = vi.fn();
    const resolveToken = vi.fn(() => stubToken);
    const result = await stackUpgrade({
      service: "nope",
      run,
      locate: locateAll,
      resolveToken,
    });
    expect(result.unknownService).toBe("nope");
    expect(result.services).toEqual([]);
    expect(result.token).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    // Unknown service is rejected before the token is resolved/persisted.
    expect(resolveToken).not.toHaveBeenCalled();
  });

  it("refuses a single-service upgrade when only a freshly generated token exists", async () => {
    const run = vi.fn();
    const result = await stackUpgrade({
      service: "castra",
      run,
      locate: locateAll,
      // No shared token to reuse — resolver had to mint one.
      resolveToken: () => ({ token: "fresh", source: "generated" }),
    });
    expect(result.partialUpgradeTokenError).toContain("castra");
    expect(result.partialUpgradeTokenError).toContain(CASTRA_TOKEN_ENV);
    expect(result.services).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("allows a single-service upgrade when a shared token already exists", async () => {
    const { calls, run } = recorder();
    const result = await stackUpgrade({
      service: "castra",
      run,
      locate: locateAll,
      // source "file"/"env" means a shared token is already in play.
      resolveToken: () => stubToken,
    });
    expect(result.partialUpgradeTokenError).toBeUndefined();
    expect(result.services.map((s) => s.service)).toEqual(["castra"]);
    expect(calls.every((c) => c.token === "tok-123")).toBe(true);
  });
});

describe("stackUpgrade — failure handling", () => {
  it("reports a recreate failure and keeps going", async () => {
    const run = (_file: string, args: string[]) => {
      if (
        args.includes("/repo/docker/brood.docker-compose.yml") &&
        args.includes("--force-recreate")
      ) {
        throw new Error("port in use");
      }
    };

    const result = await stackUpgrade({
      run,
      locate: locateAll,
      resolveToken: () => stubToken,
    });

    const brood = result.services.find((s) => s.service === "brood");
    expect(brood?.outcome).toBe("failed");
    expect(brood?.detail).toContain("port in use");
    // The other services still upgraded.
    expect(
      result.services.filter((s) => s.outcome === "upgraded"),
    ).toHaveLength(MARCH_SERVICES.length - 1);
  });

  it("fails a service whose compose file cannot be located", async () => {
    const { run } = recorder();
    const result = await stackUpgrade({
      run,
      locate: () => null,
      resolveToken: () => stubToken,
    });
    expect(result.services.every((s) => s.outcome === "failed")).toBe(true);
    expect(result.services[1].detail).toContain("could not locate");
  });
});
