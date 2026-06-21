/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import { CASTRA_TOKEN_ENV } from "../castra/config.js";
import { MARCH_SERVICES } from "./services.js";
import {
  ensureHostTmuxServer,
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
    const calls: { file: string; args: string[]; token?: string }[] = [];
    const run = (file: string, args: string[], env?: NodeJS.ProcessEnv) => {
      calls.push({ file, args, token: env?.[CASTRA_TOKEN_ENV] });
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
    const dockerCalls = calls.filter((c) => c.file === "docker");
    const tmuxCalls = calls.filter((c) => c.file === "tmux");
    // The shared token is injected into every compose call so the services
    // agree on the secret...
    expect(dockerCalls.every((c) => c.token === "tok-123")).toBe(true);
    // ...but never into the tmux anchor: tmux exports its environment into the
    // panes it spawns, so the bearer must not ride along into operator shells.
    expect(tmuxCalls.length).toBeGreaterThan(0);
    expect(tmuxCalls.every((c) => c.token === undefined)).toBe(true);
    // Every *compose* up carries the never-build guard (the tmux anchor is not a
    // compose call, so scope these assertions to docker invocations).
    expect(dockerCalls.every((c) => c.args.includes("--no-build"))).toBe(true);
    expect(
      dockerCalls.every((c) => c.args.includes("up") && c.args.includes("-d")),
    ).toBe(true);
  });

  it("claims the host tmux server before starting any service", async () => {
    const order: string[] = [];
    const run = (file: string, args: string[]) => {
      if (file === "tmux") order.push(`tmux:${args[0]}`);
      else order.push(`${file}:${args.find((a) => a.endsWith(".yml")) ?? ""}`);
    };

    await stackUp({
      run,
      locate: locateAll,
      imagePresent: allImagesPresent,
      resolveToken: () => stubToken,
    });

    // The tmux anchor must precede the first compose up (castra in particular).
    const firstTmux = order.findIndex((o) => o.startsWith("tmux:"));
    const firstDocker = order.findIndex((o) => o.startsWith("docker:"));
    expect(firstTmux).toBeGreaterThanOrEqual(0);
    expect(firstTmux).toBeLessThan(firstDocker);
  });
});

describe("stackUp — host tmux anchor", () => {
  it("reports the anchor present when a server + anchor already exist", async () => {
    // A no-op runner: `tmux has-session` 'succeeds', so nothing is created.
    const result = await stackUp({
      run: () => {},
      locate: locateAll,
      imagePresent: allImagesPresent,
      resolveToken: () => stubToken,
    });
    expect(result.tmuxAnchor).toEqual({ outcome: "present" });
  });

  it("creates the anchor when no server is running", async () => {
    const newSession = vi.fn();
    const run = (file: string, args: string[]) => {
      if (file === "tmux" && args[0] === "has-session") {
        throw new Error("no server running");
      }
      if (file === "tmux" && args[0] === "new-session") newSession(args);
    };

    const result = await stackUp({
      run,
      locate: locateAll,
      imagePresent: allImagesPresent,
      resolveToken: () => stubToken,
      readServerHost: () => null, // no server holds the socket yet
    });

    expect(result.tmuxAnchor).toEqual({ outcome: "created" });
    expect(newSession).toHaveBeenCalledOnce();
  });

  // Exercised against ensureHostTmuxServer directly so localHost is injected
  // (not os.hostname()) and the foreign-server check is deterministic.
  it("reports a failed anchor when a foreign server already owns the socket", () => {
    const newSession = vi.fn();
    const run = (file: string, args: string[]) => {
      if (file === "tmux" && args[0] === "has-session") {
        throw new Error("no anchor session");
      }
      if (file === "tmux" && args[0] === "new-session") newSession(args);
    };

    const result = ensureHostTmuxServer(
      run,
      {},
      {
        localHost: "host-machine",
        // A container id the host never matches: the castra container owns the
        // default tmux socket, so creating a session would just attach to it.
        readServerHost: () => "cd42c4740280",
      },
    );

    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("cd42c4740280");
    expect(result.detail).toContain("march down && march up");
    // We must NOT attach to the foreign server by creating a session on it.
    expect(newSession).not.toHaveBeenCalled();
  });

  it("records a failed anchor without aborting the stack (best-effort)", async () => {
    const run = (file: string) => {
      if (file === "tmux") throw new Error("tmux: command not found");
    };

    const result = await stackUp({
      run,
      locate: locateAll,
      imagePresent: allImagesPresent,
      resolveToken: () => stubToken,
      readServerHost: () => null, // no foreign server — exercise the exec failure
    });

    expect(result.tmuxAnchor?.outcome).toBe("failed");
    expect(result.tmuxAnchor?.detail).toContain("not found");
    // The stack still came up — a missing tmux must not block bring-up.
    expect(result.services.every((s) => s.outcome === "started")).toBe(true);
  });

  it("does not anchor when the image pre-flight aborts the run", async () => {
    const run = vi.fn();
    const result = await stackUp({
      run,
      locate: locateAll,
      imagePresent: (image: string) => image !== "march-castra:latest",
      resolveToken: () => stubToken,
    });
    expect(result.tmuxAnchor).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
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
