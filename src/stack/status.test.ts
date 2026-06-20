/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { CASTRA_TOKEN_ENV } from "../castra/config.js";
import { MARCH_SERVICES, containerName } from "./services.js";
import {
  formatStatusTable,
  readSharedToken,
  resolveServicePort,
  stackStatus,
  type ContainerState,
  type HttpProbeResult,
  type StatusOptions,
} from "./status.js";

/** All six services running, reachable, image present, token accepted. */
function healthyOptions(over: Partial<StatusOptions> = {}): StatusOptions {
  return {
    containerState: () => "running",
    imagePresent: () => true,
    readToken: () => "tok-123",
    probeHttp: async (url, token) => {
      if (url.includes("/v1/")) {
        // Token gate: accept the correct token.
        return token === "tok-123"
          ? { reachable: true, status: 200 }
          : { reachable: true, status: 401 };
      }
      return { reachable: true, status: 200 };
    },
    ...over,
  };
}

describe("stackStatus — healthy stack", () => {
  it("reports every service healthy and the stack healthy", async () => {
    const status = await stackStatus(healthyOptions());
    expect(status.healthy).toBe(true);
    expect(status.services).toHaveLength(MARCH_SERVICES.length);
    for (const s of status.services) {
      expect(s.healthy).toBe(true);
      expect(s.container).toBe("running");
      expect(s.reachable).toBe("ok");
      expect(s.issues).toEqual([]);
    }
  });

  it("marks the token-gated service ok and the rest n/a", async () => {
    const status = await stackStatus(healthyOptions());
    const castra = status.services.find((s) => s.service === "castra");
    expect(castra?.token).toBe("ok");
    const hatchery = status.services.find((s) => s.service === "hatchery");
    expect(hatchery?.token).toBe("n/a");
  });

  // Regression: the default container probe shells out synchronously
  // (`execFileSync "docker inspect"`). When that ran interleaved with the
  // concurrent HTTP probes it blocked the event loop and starved the per-probe
  // abort timers, spuriously failing the first services against a live stack.
  // All synchronous inspection must therefore complete BEFORE any HTTP probe is
  // started.
  it("inspects every container before starting any HTTP probe", async () => {
    const order: string[] = [];
    await stackStatus(
      healthyOptions({
        containerState: (name) => {
          order.push(`inspect:${name}`);
          return "running";
        },
        probeHttp: async (url) => {
          order.push(`probe:${url}`);
          return { reachable: true, status: 200 };
        },
      }),
    );
    const firstProbe = order.findIndex((e) => e.startsWith("probe:"));
    const inspections = order.filter((e) => e.startsWith("inspect:"));
    expect(inspections).toHaveLength(MARCH_SERVICES.length);
    // Every inspection appears before the first probe.
    expect(order.slice(0, firstProbe).every((e) => e.startsWith("inspect:"))).toBe(
      true,
    );
  });
});

describe("stackStatus — container state", () => {
  it("flags a stopped container as unhealthy with an issue", async () => {
    const status = await stackStatus(
      healthyOptions({
        containerState: (name): ContainerState =>
          name === containerName("brood") ? "stopped" : "running",
      }),
    );
    expect(status.healthy).toBe(false);
    const brood = status.services.find((s) => s.service === "brood");
    expect(brood?.container).toBe("stopped");
    expect(brood?.healthy).toBe(false);
    expect(brood?.issues).toContain("container is stopped");
  });

  it("reports an absent container", async () => {
    const status = await stackStatus(
      healthyOptions({
        containerState: (name): ContainerState =>
          name === containerName("legate") ? "absent" : "running",
      }),
    );
    const legate = status.services.find((s) => s.service === "legate");
    expect(legate?.container).toBe("absent");
    expect(legate?.issues).toContain("container is absent");
  });
});

describe("stackStatus — reachability", () => {
  it("flags an unreachable service", async () => {
    const status = await stackStatus(
      healthyOptions({
        probeHttp: async (url): Promise<HttpProbeResult> => {
          if (url.includes(":8818")) return { reachable: false };
          return { reachable: true, status: 200 };
        },
      }),
    );
    const herald = status.services.find((s) => s.service === "herald");
    expect(herald?.reachable).toBe("unreachable");
    expect(herald?.healthy).toBe(false);
    expect(herald?.issues.some((i) => i.includes("not reachable"))).toBe(true);
  });

  it("treats a 5xx health response as an error", async () => {
    const status = await stackStatus(
      healthyOptions({
        probeHttp: async (url): Promise<HttpProbeResult> => {
          if (url.includes(":8080")) return { reachable: true, status: 503 };
          return { reachable: true, status: 200 };
        },
      }),
    );
    const hatchery = status.services.find((s) => s.service === "hatchery");
    expect(hatchery?.reachable).toBe("error");
    expect(hatchery?.healthy).toBe(false);
  });

  // Regression: a non-hatchery process squatting on the loopback port answers
  // 404 (or the container failed to publish its port). Found against the live
  // stack — a foreign HTTP/1.0 server on :8080 must NOT be reported "ok".
  it("treats a non-2xx (e.g. 404 from a foreign server) as an error, not ok", async () => {
    const status = await stackStatus(
      healthyOptions({
        probeHttp: async (url): Promise<HttpProbeResult> => {
          if (url.includes(":8080")) return { reachable: true, status: 404 };
          return { reachable: true, status: 200 };
        },
      }),
    );
    const hatchery = status.services.find((s) => s.service === "hatchery");
    expect(hatchery?.reachable).toBe("error");
    expect(hatchery?.healthy).toBe(false);
    expect(hatchery?.issues.some((i) => i.includes("404"))).toBe(true);
    expect(status.healthy).toBe(false);
  });
});

describe("stackStatus — token drift", () => {
  it("names token drift when the gate returns 401", async () => {
    const status = await stackStatus(
      healthyOptions({
        readToken: () => "wrong-token",
        // The healthy probe returns 401 for the wrong token.
      }),
    );
    const castra = status.services.find((s) => s.service === "castra");
    expect(castra?.token).toBe("drift");
    expect(castra?.healthy).toBe(false);
    expect(castra?.issues.some((i) => i.includes("token drift"))).toBe(true);
    expect(status.healthy).toBe(false);
  });

  it("reports unknown token wiring when no shared token is configured", async () => {
    const status = await stackStatus(healthyOptions({ readToken: () => null }));
    const castra = status.services.find((s) => s.service === "castra");
    expect(castra?.token).toBe("unknown");
    expect(castra?.healthy).toBe(false);
  });

  it("cannot probe the token when castra is unreachable", async () => {
    const status = await stackStatus(
      healthyOptions({
        probeHttp: async (url): Promise<HttpProbeResult> => {
          if (url.includes(":9264")) return { reachable: false };
          return { reachable: true, status: 200 };
        },
      }),
    );
    const castra = status.services.find((s) => s.service === "castra");
    expect(castra?.token).toBe("unknown");
  });
});

describe("stackStatus — image presence", () => {
  it("flags a service whose local image is absent", async () => {
    const status = await stackStatus(
      healthyOptions({
        imagePresent: (image) => image !== "march-castra:latest",
      }),
    );
    const castra = status.services.find((s) => s.service === "castra");
    expect(castra?.imagePresent).toBe(false);
    expect(castra?.healthy).toBe(false);
    expect(castra?.issues.some((i) => i.includes("not built"))).toBe(true);
  });
});

describe("stackStatus — dependency surfacing", () => {
  it("explains a degraded dependency on the dependent service", async () => {
    const status = await stackStatus(
      healthyOptions({
        containerState: (name): ContainerState =>
          name === containerName("castra") ? "stopped" : "running",
      }),
    );
    const legate = status.services.find((s) => s.service === "legate");
    expect(
      legate?.issues.some((i) => i.includes("depends on castra")),
    ).toBe(true);
    const hatchery = status.services.find((s) => s.service === "hatchery");
    expect(
      hatchery?.issues.some((i) => i.includes("depends on castra")),
    ).toBe(true);
  });
});

describe("readSharedToken", () => {
  it("prefers the env token over a persisted file", () => {
    expect(readSharedToken({ [CASTRA_TOKEN_ENV]: "from-env" })).toBe("from-env");
  });

  it("trims whitespace from the env token", () => {
    expect(readSharedToken({ [CASTRA_TOKEN_ENV]: "  spaced  " })).toBe("spaced");
  });
});

describe("resolveServicePort", () => {
  // MarchService keys on `.name` (ServiceStatus keys on `.service`).
  const castraSvc = MARCH_SERVICES.find((s) => s.name === "castra")!;
  const heraldSvc = MARCH_SERVICES.find((s) => s.name === "herald")!;

  it("returns the default port when no portEnv override is set", () => {
    expect(resolveServicePort(castraSvc, {})).toBe(9264);
  });

  it("honors CASTRA_PORT when set to a valid port", () => {
    expect(resolveServicePort(castraSvc, { CASTRA_PORT: "9999" })).toBe(9999);
  });

  it("falls back to the default for a non-numeric or non-positive override", () => {
    expect(resolveServicePort(castraSvc, { CASTRA_PORT: "abc" })).toBe(9264);
    expect(resolveServicePort(castraSvc, { CASTRA_PORT: "0" })).toBe(9264);
    expect(resolveServicePort(castraSvc, { CASTRA_PORT: "  " })).toBe(9264);
  });

  it("ignores env for a service without a portEnv (hard-coded host port)", () => {
    expect(resolveServicePort(heraldSvc, { CASTRA_PORT: "9999" })).toBe(8818);
  });
});

describe("stackStatus — CASTRA_PORT override", () => {
  it("probes the operator-set CASTRA_PORT instead of the 9264 default", async () => {
    const probed: string[] = [];
    const status = await stackStatus(
      healthyOptions({
        env: { CASTRA_PORT: "9300" } as NodeJS.ProcessEnv,
        // Override readToken because healthyOptions does; env-derived token read
        // would otherwise touch the real file. Keep the happy-path token.
        readToken: () => "tok-123",
        probeHttp: async (url, token) => {
          probed.push(url);
          if (url.includes("/v1/")) {
            return token === "tok-123"
              ? { reachable: true, status: 200 }
              : { reachable: true, status: 401 };
          }
          return { reachable: true, status: 200 };
        },
      }),
    );
    const castra = status.services.find((s) => s.service === "castra");
    expect(castra?.port).toBe(9300);
    expect(castra?.healthy).toBe(true);
    expect(probed.some((u) => u.includes(":9300/healthz"))).toBe(true);
    expect(probed.some((u) => u.includes(":9300/v1/sessions"))).toBe(true);
    expect(probed.some((u) => u.includes(":9264"))).toBe(false);
  });
});

describe("formatStatusTable", () => {
  it("renders a HEALTHY summary for a healthy stack", async () => {
    const status = await stackStatus(healthyOptions());
    const out = formatStatusTable(status);
    expect(out).toContain("SERVICE");
    expect(out).toContain("Stack: HEALTHY");
  });

  it("renders an UNHEALTHY summary and the issues for a degraded stack", async () => {
    const status = await stackStatus(
      healthyOptions({ containerState: () => "absent" }),
    );
    const out = formatStatusTable(status);
    expect(out).toContain("Stack: UNHEALTHY");
    expect(out).toContain("container is absent");
  });
});
