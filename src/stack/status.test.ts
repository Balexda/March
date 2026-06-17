/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { CASTRA_TOKEN_ENV } from "../castra/config.js";
import { MARCH_SERVICES, containerName } from "./services.js";
import {
  formatStatusTable,
  readSharedToken,
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
