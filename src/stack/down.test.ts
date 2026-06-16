/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import { MARCH_SERVICES } from "./services.js";
import { stackDown, type DrainResult } from "./down.js";

/** A locator that pretends every compose file is present at docker/<basename>. */
const locateAll = (b: string) => `/repo/docker/${b}`;

describe("stackDown — service ordering", () => {
  it("stops services in reverse dependency order (legate first, otel-lgtm last)", async () => {
    const calls: string[][] = [];
    const run = (file: string, args: string[]) => {
      calls.push([file, ...args]);
    };

    const result = await stackDown({ run, locate: locateAll });

    expect(result.services.map((s) => s.service)).toEqual([
      "legate",
      "herald",
      "brood",
      "hatchery",
      "castra",
      "otel-lgtm",
    ]);
    // The reverse of the canonical bring-up order.
    expect(result.services.map((s) => s.service)).toEqual(
      [...MARCH_SERVICES].reverse().map((s) => s.name),
    );
    expect(result.services.every((s) => s.outcome === "stopped")).toBe(true);
    // One `docker compose ... down` per service, no `--volumes` by default.
    expect(calls).toHaveLength(MARCH_SERVICES.length);
    expect(calls[0]).toEqual([
      "docker",
      "compose",
      "-f",
      "/repo/docker/legate.docker-compose.yml",
      "down",
    ]);
    expect(calls.every((c) => !c.includes("--volumes"))).toBe(true);
  });
});

describe("stackDown — volumes flag", () => {
  it("appends --volumes to every compose down when requested", async () => {
    const calls: string[][] = [];
    const run = (_file: string, args: string[]) => {
      calls.push(args);
    };

    await stackDown({ volumes: true, run, locate: locateAll });

    expect(calls.every((c) => c.includes("--volumes"))).toBe(true);
  });
});

describe("stackDown — best-effort behavior", () => {
  it("skips a service whose compose file is not found, without throwing", async () => {
    const run = vi.fn();
    const locate = (b: string) =>
      b === "herald.docker-compose.yml" ? null : `/repo/docker/${b}`;

    const result = await stackDown({ run, locate });

    const herald = result.services.find((s) => s.service === "herald");
    expect(herald?.outcome).toBe("skipped");
    // The missing file is never handed to docker.
    expect(run).toHaveBeenCalledTimes(MARCH_SERVICES.length - 1);
  });

  it("records a failed service but continues stopping the rest", async () => {
    const run = (_file: string, args: string[]) => {
      if (args.includes("/repo/docker/brood.docker-compose.yml")) {
        throw new Error("daemon down");
      }
    };

    const result = await stackDown({ run, locate: locateAll });

    const brood = result.services.find((s) => s.service === "brood");
    expect(brood?.outcome).toBe("failed");
    expect(brood?.detail).toContain("daemon down");
    // Every other service was still attempted.
    expect(result.services.filter((s) => s.outcome === "stopped")).toHaveLength(
      MARCH_SERVICES.length - 1,
    );
  });
});

describe("stackDown — drain", () => {
  it("does not drain by default", async () => {
    const drainSessions = vi.fn();
    const result = await stackDown({ run: () => {}, locate: locateAll, drainSessions });
    expect(drainSessions).not.toHaveBeenCalled();
    expect(result.drain).toBeUndefined();
  });

  it("drains in-flight sessions before stopping services when --drain is set", async () => {
    const order: string[] = [];
    const drain: DrainResult = { tornDown: ["spawn-1"], failures: [] };
    const drainSessions = vi.fn(async () => {
      order.push("drain");
      return drain;
    });
    const run = (_file: string, args: string[]) => {
      order.push(`down:${args[2]}`);
    };

    const result = await stackDown({
      drain: true,
      run,
      locate: locateAll,
      drainSessions,
    });

    expect(result.drain).toEqual(drain);
    // Drain runs first, while the services it talks to are still up.
    expect(order[0]).toBe("drain");
    expect(order.slice(1).every((o) => o.startsWith("down:"))).toBe(true);
  });
});
