/**
 * @l1 @deterministic @ci
 */
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
  it("prefers live container logs for container-backed rows", () => {
    const readContainerLogs = vi.fn(() => "live logs\n");
    const archiveExists = vi.fn(() => true);

    const result = readSessionLogs(session({ containerId: "c1" }), {
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

  it("falls back to archive when live container logs fail", () => {
    const result = readSessionLogs(session({ containerId: "gone" }), {
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

  it("uses archive when a container-backed row has no live container id", () => {
    const readContainerLogs = vi.fn();

    const result = readSessionLogs(session(), {
      readContainerLogs,
      archiveExists: () => true,
      readArchive: () => "archive only\n",
      homeDir: "/home/test",
    });

    expect(result.source.kind).toBe("archive");
    expect(result.content).toBe("archive only\n");
    expect(readContainerLogs).not.toHaveBeenCalled();
  });

  it("reads a steward archive through its parent spawn id", () => {
    // teardownSession archives a spawn<->steward group under the spawn id.
    const probed: string[] = [];

    const result = readSessionLogs(
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

  it("never probes an archive path that escapes the archive root", () => {
    const archiveExists = vi.fn(() => true);
    const readArchive = vi.fn(() => "escaped\n");

    expect(() =>
      readSessionLogs(session({ id: "../../../../etc" }), {
        archiveExists,
        readArchive,
        homeDir: "/home/test",
      }),
    ).toThrow(BroodLogUnavailableError);
    expect(archiveExists).not.toHaveBeenCalled();
    expect(readArchive).not.toHaveBeenCalled();
  });

  it("keeps the live failure when the archive exists but is unreadable", () => {
    let thrown: unknown;
    try {
      readSessionLogs(session({ containerId: "c1" }), {
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

  it("reports an unreadable archive when no live source was tried", () => {
    let thrown: unknown;
    try {
      readSessionLogs(session(), {
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

  it("reports unavailable logs without mutating dependencies", () => {
    const readContainerLogs = vi.fn(() => {
      throw new Error("docker down");
    });
    const archiveExists = vi.fn(() => false);
    const readArchive = vi.fn();

    expect(() =>
      readSessionLogs(session({ containerId: "c1" }), {
        readContainerLogs,
        archiveExists,
        readArchive,
      }),
    ).toThrow(BroodLogUnavailableError);
    expect(readContainerLogs).toHaveBeenCalledTimes(1);
    expect(archiveExists).toHaveBeenCalledTimes(1);
    expect(readArchive).not.toHaveBeenCalled();
  });
});
