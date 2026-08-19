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
