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

describe("stackUpgrade — build + recreate", () => {
  it("rebuilds every built image then force-recreates in dependency order", async () => {
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

    // otel-lgtm is pulled (recreate only); the other five are rebuilt.
    const built = result.services.filter((s) => s.built).map((s) => s.service);
    expect(built).toEqual(
      MARCH_SERVICES.filter((s) => s.dockerfile).map((s) => s.name),
    );
    expect(result.services.find((s) => s.service === "otel-lgtm")?.built).toBe(false);

    // Each built service does a `docker build` immediately before its recreate.
    const castraBuildIdx = calls.findIndex(
      (c) => c.args[0] === "build" && c.args.includes("march-castra:latest"),
    );
    const castraRecreateIdx = calls.findIndex(
      (c) =>
        c.args.includes("/repo/docker/castra.docker-compose.yml") &&
        c.args.includes("--force-recreate"),
    );
    expect(castraBuildIdx).toBeGreaterThanOrEqual(0);
    expect(castraRecreateIdx).toBeGreaterThan(castraBuildIdx);

    // Every recreate forces recreation, never builds (we built explicitly), and
    // carries the shared token.
    const recreates = calls.filter((c) => c.args.includes("--force-recreate"));
    expect(recreates).toHaveLength(MARCH_SERVICES.length);
    expect(recreates.every((c) => c.args.includes("--no-build"))).toBe(true);
    expect(recreates.every((c) => c.token === "tok-123")).toBe(true);
  });

  it("does not build otel-lgtm (it is pulled, not built)", async () => {
    const { calls, run } = recorder();
    await stackUpgrade({ run, locate: locateAll, resolveToken: () => stubToken });
    const builds = calls.filter((c) => c.args[0] === "build");
    expect(builds).toHaveLength(MARCH_SERVICES.filter((s) => s.dockerfile).length);
    expect(builds.some((c) => c.args.join(" ").includes("otel-lgtm"))).toBe(false);
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
    expect(calls.every((c) => c.args.join(" ").includes("herald"))).toBe(true);
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
  it("skips the recreate when the build fails and keeps going", async () => {
    const run = (_file: string, args: string[]) => {
      // Fail the herald image build only.
      if (args[0] === "build" && args.includes("march-herald:latest")) {
        throw new Error("build blew up");
      }
    };

    const result = await stackUpgrade({
      run,
      locate: locateAll,
      resolveToken: () => stubToken,
    });

    const herald = result.services.find((s) => s.service === "herald");
    expect(herald?.outcome).toBe("failed");
    expect(herald?.built).toBe(false);
    expect(herald?.detail).toContain("build blew up");
    // The other services still upgraded.
    expect(
      result.services.filter((s) => s.outcome === "upgraded"),
    ).toHaveLength(MARCH_SERVICES.length - 1);
  });

  it("reports a recreate failure after a successful build", async () => {
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
    expect(brood?.built).toBe(true);
    expect(brood?.detail).toContain("port in use");
  });

  it("fails a service whose compose/Dockerfile cannot be located", async () => {
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
