/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import { CASTRA_TOKEN_ENV } from "../castra/config.js";
import { MARCH_SERVICES } from "./services.js";
import {
  resolveCastraToken,
  stackUp,
  type ResolvedToken,
  type TokenIo,
} from "./up.js";

const locateAll = (b: string) => `/repo/docker/${b}`;
const allImagesPresent = () => true;
const stubToken: ResolvedToken = { token: "tok-123", source: "file" };

describe("resolveCastraToken", () => {
  const io: TokenIo = {
    path: "/home/u/.march/castra-token",
    read: () => null,
    write: () => {},
    generate: () => "generated-token",
  };

  it("prefers an operator-set CASTRA_API_TOKEN from the env", () => {
    const r = resolveCastraToken({ [CASTRA_TOKEN_ENV]: "from-env" }, io);
    expect(r).toEqual({ token: "from-env", source: "env" });
  });

  it("reuses a previously persisted token when the env is empty", () => {
    const fileIo: TokenIo = { ...io, read: () => "persisted-token\n" };
    const r = resolveCastraToken({}, fileIo);
    expect(r).toEqual({
      token: "persisted-token",
      source: "file",
      persistedPath: fileIo.path,
    });
  });

  it("generates and persists a fresh token when none exists", () => {
    const write = vi.fn();
    const r = resolveCastraToken({}, { ...io, read: () => null, write });
    expect(r.source).toBe("generated");
    expect(r.token).toBe("generated-token");
    expect(write).toHaveBeenCalledWith(io.path, "generated-token");
  });
});

describe("stackUp — ordering + token injection", () => {
  it("starts services in forward dependency order (otel-lgtm first, legate last)", async () => {
    const calls: { args: string[]; token?: string }[] = [];
    const run = (_file: string, args: string[], env?: NodeJS.ProcessEnv) => {
      calls.push({ args, token: env?.[CASTRA_TOKEN_ENV] });
    };

    const result = await stackUp({
      run,
      locate: locateAll,
      imagePresent: allImagesPresent,
      resolveToken: () => stubToken,
    });

    expect(result.services.map((s) => s.service)).toEqual(
      MARCH_SERVICES.map((s) => s.name),
    );
    expect(result.services[0].service).toBe("otel-lgtm");
    expect(result.services.at(-1)?.service).toBe("legate");
    expect(result.services.every((s) => s.outcome === "started")).toBe(true);
    // Every compose up carries the shared token + the never-build guard.
    expect(calls.every((c) => c.token === "tok-123")).toBe(true);
    expect(calls.every((c) => c.args.includes("--no-build"))).toBe(true);
    expect(calls.every((c) => c.args.includes("up") && c.args.includes("-d"))).toBe(true);
  });
});

describe("stackUp — image pre-flight", () => {
  it("aborts without starting anything when a built image is missing", async () => {
    const run = vi.fn();
    const imagePresent = (image: string) => image !== "march-herald:latest";

    const result = await stackUp({
      run,
      locate: locateAll,
      imagePresent,
      resolveToken: () => stubToken,
    });

    expect(result.missingImages).toEqual([
      { service: "herald", image: "march-herald:latest" },
    ]);
    expect(result.services).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("never image-checks otel-lgtm (it is pulled, not built)", async () => {
    const checked: string[] = [];
    const imagePresent = (image: string) => {
      checked.push(image);
      return true;
    };

    await stackUp({
      run: () => {},
      locate: locateAll,
      imagePresent,
      resolveToken: () => stubToken,
    });

    expect(checked).not.toContain("otel-lgtm");
    // One check per locally-built service (every service except otel-lgtm).
    expect(checked).toHaveLength(MARCH_SERVICES.length - 1);
  });
});

describe("stackUp — best-effort failure", () => {
  it("records a failed service and continues, exposing the error detail", async () => {
    const run = (_file: string, args: string[]) => {
      if (args.includes("/repo/docker/brood.docker-compose.yml")) {
        throw new Error("port in use");
      }
    };

    const result = await stackUp({
      run,
      locate: locateAll,
      imagePresent: allImagesPresent,
      resolveToken: () => stubToken,
    });

    const brood = result.services.find((s) => s.service === "brood");
    expect(brood?.outcome).toBe("failed");
    expect(brood?.detail).toContain("port in use");
    expect(result.services.filter((s) => s.outcome === "started")).toHaveLength(
      MARCH_SERVICES.length - 1,
    );
  });
});
