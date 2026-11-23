/**
 * @l1 @deterministic @ci
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BroodLogUnavailableError, readSessionLogs } from "./logs.js";
import type { SessionRecord } from "./types.js";

function session(
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id: "s1",
    kind: "spawn",
    status: "running",
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("readSessionLogs", () => {
  it("prefers live container logs for container-backed rows", async () => {
    const readContainerLogs = vi.fn(() => "live logs\n");
    const archiveExists = vi.fn(() => true);

    const result = await readSessionLogs(session({ containerId: "c1" }), {
      readContainerLogs,
      archiveExists,
      readArchive: () => "archive logs\n",
    });

    expect(result).toEqual({
      source: { kind: "live-container", containerId: "c1", available: true },
      content: "live logs\n",
    });
    expect(readContainerLogs).toHaveBeenCalledWith("c1");
    expect(archiveExists).not.toHaveBeenCalled();
  });

  it("falls back to archive when live container logs fail", async () => {
    const result = await readSessionLogs(session({ containerId: "gone" }), {
      readContainerLogs: () => {
        throw new Error("no such container");
      },
      archiveExists: (archivePath) => archivePath.endsWith("/s1/container.log"),
      readArchive: () => "archive logs\n",
      homeDir: "/home/test",
    });

    expect(result.source).toEqual({
      kind: "archive",
      archivePath: "/home/test/.march/brood/archive/s1/container.log",
      available: true,
    });
    expect(result.content).toBe("archive logs\n");
  });

  it("uses archive when a container-backed row has no live container id", async () => {
    const readContainerLogs = vi.fn();

    const result = await readSessionLogs(session(), {
      readContainerLogs,
      archiveExists: () => true,
      readArchive: () => "archive only\n",
      homeDir: "/home/test",
    });

    expect(result.source.kind).toBe("archive");
    expect(result.content).toBe("archive only\n");
    expect(readContainerLogs).not.toHaveBeenCalled();
  });

  it("reads a steward archive through its parent spawn id", async () => {
    // teardownSession archives a spawn<->steward group under the spawn id.
    const probed: string[] = [];

    const result = await readSessionLogs(
      session({ id: "steward-1", kind: "steward", parentId: "spawn-1" }),
      {
        archiveExists: (archivePath) => {
          probed.push(archivePath);
          return archivePath.includes("/archive/spawn-1/");
        },
        readArchive: () => "parent archive\n",
        homeDir: "/home/test",
      },
    );

    expect(result.source).toEqual({
      kind: "archive",
      archivePath: "/home/test/.march/brood/archive/spawn-1/container.log",
      available: true,
    });
    expect(result.content).toBe("parent archive\n");
    expect(probed).toEqual([
      "/home/test/.march/brood/archive/steward-1/container.log",
      "/home/test/.march/brood/archive/spawn-1/container.log",
    ]);
  });

  it("never probes an archive path that escapes the archive root", async () => {
    const archiveExists = vi.fn(() => true);
    const readArchive = vi.fn(() => "escaped\n");

    await expect(
      readSessionLogs(session({ id: "../../../../etc" }), {
        archiveExists,
        readArchive,
        homeDir: "/home/test",
      }),
    ).rejects.toBeInstanceOf(BroodLogUnavailableError);
    expect(archiveExists).not.toHaveBeenCalled();
    expect(readArchive).not.toHaveBeenCalled();
  });

  it("keeps the live failure when the archive exists but is unreadable", async () => {
    let thrown: unknown;
    try {
      await readSessionLogs(session({ containerId: "c1" }), {
        readContainerLogs: () => {
          throw new Error("docker down");
        },
        archiveExists: () => true,
        readArchive: () => {
          throw new Error("EACCES");
        },
        homeDir: "/home/test",
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(BroodLogUnavailableError);
    // The upstream live failure owns the outcome so the route still maps 502,
    // and both failure details survive for diagnostics.
    expect((thrown as BroodLogUnavailableError).reason).toBe(
      "live-source-failed",
    );
    expect((thrown as Error).message).toContain("docker down");
    expect((thrown as Error).message).toContain("EACCES");
  });

  it("reports an unreadable archive when no live source was tried", async () => {
    let thrown: unknown;
    try {
      await readSessionLogs(session(), {
        archiveExists: () => true,
        readArchive: () => {
          throw new Error("EACCES");
        },
        homeDir: "/home/test",
      });
    } catch (err) {
      thrown = err;
    }

    expect((thrown as BroodLogUnavailableError).reason).toBe(
      "archive-read-failed",
    );
  });

  it("reports unavailable logs without mutating dependencies", async () => {
    const readContainerLogs = vi.fn(() => {
      throw new Error("docker down");
    });
    const archiveExists = vi.fn(() => false);
    const readArchive = vi.fn();

    await expect(
      readSessionLogs(session({ containerId: "c1" }), {
        readContainerLogs,
        archiveExists,
        readArchive,
      }),
    ).rejects.toBeInstanceOf(BroodLogUnavailableError);
    expect(readContainerLogs).toHaveBeenCalledTimes(1);
    expect(archiveExists).toHaveBeenCalledTimes(1);
    expect(readArchive).not.toHaveBeenCalled();
  });

  it("returns stderr-only container output through the default docker reader", async () => {
    // No injected readContainerLogs: exercise the real default reader against
    // a fake `docker` on PATH that writes only a startup error to stderr.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brood-logs-default-"));
    fs.writeFileSync(
      path.join(dir, "docker"),
      '#!/bin/sh\nprintf "startup failed\\n" >&2\n',
      { mode: 0o755 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ""}`;
    const archiveExists = vi.fn(() => true);
    try {
      const result = await readSessionLogs(session({ containerId: "c1" }), {
        archiveExists,
        readArchive: () => "archive logs\n",
        homeDir: "/home/test",
      });

      expect(result).toEqual({
        source: { kind: "live-container", containerId: "c1", available: true },
        content: "startup failed\n",
      });
      expect(archiveExists).not.toHaveBeenCalled();
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to archive when the default docker reader exits non-zero", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brood-logs-default-"));
    fs.writeFileSync(
      path.join(dir, "docker"),
      '#!/bin/sh\nprintf "No such container\\n" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ""}`;
    try {
      const result = await readSessionLogs(session({ containerId: "gone" }), {
        archiveExists: () => true,
        readArchive: () => "archive logs\n",
        homeDir: "/home/test",
      });

      expect(result.source.kind).toBe("archive");
      expect(result.content).toBe("archive logs\n");
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
