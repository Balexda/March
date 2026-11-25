/**
 * @l1 @deterministic @ci
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { removeSpawnWorktreeExactAsync } from "../worktree.js";
import { hostTeardownSubstrate } from "./substrate.js";

const { docker } = vi.hoisted(() => ({ docker: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: Object.assign(() => {}, { [Symbol.for("nodejs.util.promisify.custom")]: docker }),
}));

const id = "a".repeat(64);
const target = { sessionId: "legate.test", kind: "legate", containerName: "march-legate-legate.test" };
const found = { stdout: `${id} ${target.containerName}\n` };
const absent = { stdout: "" };

describe("hostTeardownSubstrate", () => {
  beforeEach(() => docker.mockReset());

  it("sends only SIGTERM, waits and verifies the stopped container under one deadline", async () => {
    docker.mockResolvedValueOnce(found)
      .mockResolvedValueOnce({ stdout: "running\n" })
      .mockResolvedValueOnce(absent)
      .mockResolvedValueOnce({ stdout: "143\n" })
      .mockResolvedValueOnce({ stdout: "exited\n" });
    await expect(hostTeardownSubstrate.stopCompute!(target)).resolves.toEqual({
      outcome: "stopped", containerId: id,
    });
    const options = { timeout: 10_000, killSignal: "SIGKILL", signal: expect.any(AbortSignal) };
    const inspect = ["container", "inspect", "--format", "{{.State.Status}}", "--", id];
    expect(docker.mock.calls.slice(1)).toEqual([
      ["docker", inspect, options],
      ["docker", ["container", "kill", "--signal", "SIGTERM", "--", id], options],
      ["docker", ["container", "wait", "--", id], options],
      ["docker", inspect, options],
    ]);
    expect(new Set(docker.mock.calls.map((call) => call[2].signal)).size).toBe(1);
  });

  it("skips signaling an already stopped container", async () => {
    docker.mockResolvedValueOnce(found).mockResolvedValueOnce({ stdout: "exited\n" });
    await expect(hostTeardownSubstrate.stopCompute!(target)).resolves.toEqual({
      outcome: "already-stopped", containerId: id,
    });
    expect(docker).toHaveBeenCalledTimes(2);
  });

  it("refuses to report an escalated kill as graceful", async () => {
    docker.mockResolvedValueOnce(found)
      .mockResolvedValueOnce({ stdout: "running" })
      .mockResolvedValueOnce(absent)
      .mockResolvedValueOnce({ stdout: "137" });
    await expect(hostTeardownSubstrate.stopCompute!(target)).rejects.toThrow("verified graceful stop");
    expect(docker).toHaveBeenCalledTimes(4);
  });

  it("removes verified stopped compute by ID without force and rejects replacements", async () => {
    const stopped = { outcome: "stopped", containerId: id } as const;
    docker.mockResolvedValueOnce(found).mockResolvedValueOnce(absent).mockResolvedValueOnce(absent);
    await hostTeardownSubstrate.removeCompute(target, stopped);
    expect(docker.mock.calls[1]?.[1]).toEqual(["container", "rm", "--", id]);
    docker.mockClear().mockResolvedValueOnce({ stdout: `${"b".repeat(64)} ${target.containerName}` });
    await expect(hostTeardownSubstrate.removeCompute(target, stopped)).rejects.toThrow("changed after");
    expect(docker).toHaveBeenCalledTimes(1);
  });

  it("removes only the exact matching immutable ID and verifies name absence", async () => {
    docker.mockResolvedValueOnce(found).mockResolvedValueOnce(absent).mockResolvedValueOnce(absent);
    await hostTeardownSubstrate.removeCompute(target);
    const lookup = [
      "container", "ls", "--all", "--no-trunc",
      "--filter", "name=^/march-legate-legate\\.test$",
      "--format", '{{.ID}} {{.Names}} {{.Label "com.docker.compose.project"}}',
    ];
    const deadline = { timeout: 10_000, killSignal: "SIGKILL", signal: expect.any(AbortSignal) };
    expect(docker.mock.calls).toEqual([
      ["docker", lookup, deadline],
      ["docker", ["container", "rm", "--force", "--", id], deadline],
      ["docker", lookup, deadline],
    ]);
    expect(new Set(docker.mock.calls.map((call) => call[2].signal)).size).toBe(1);
  });

  it("succeeds when the container is already absent", async () => {
    docker.mockResolvedValueOnce(absent);
    await expect(hostTeardownSubstrate.removeCompute(target)).resolves.toBeUndefined();
    expect(docker).toHaveBeenCalledTimes(1);
  });

  it("verifies absence after a missing-container race", async () => {
    docker.mockResolvedValueOnce(found)
      .mockRejectedValueOnce({ code: 1, stderr: `Error response from daemon: No such container: ${id}\n` })
      .mockResolvedValueOnce(absent);
    await expect(hostTeardownSubstrate.removeCompute(target)).resolves.toBeUndefined();
    expect(docker).toHaveBeenCalledTimes(3);
  });

  it.each([
    { code: 1, stderr: "permission denied" },
    { signal: "SIGKILL", killed: true },
  ])("surfaces removal failure %j", async (error) => {
    docker.mockResolvedValueOnce(found).mockRejectedValueOnce(error);
    await expect(hostTeardownSubstrate.removeCompute(target)).rejects.toEqual(error);
  });

  it("fails when the name is still present after removal", async () => {
    docker.mockResolvedValueOnce(found).mockResolvedValueOnce(absent).mockResolvedValueOnce(found);
    await expect(hostTeardownSubstrate.removeCompute(target)).rejects.toThrow("still exists");
  });

  it.each([
    `${id} ${target.containerName}-adjacent\n`,
    `${id} ${target.containerName} march-legate\n`,
  ])("leaves adjacent and compose containers intact", async (stdout) => {
    docker.mockResolvedValueOnce({ stdout });
    await expect(hostTeardownSubstrate.removeCompute(target)).rejects.toThrow("not a verified ephemeral session target");
    expect(docker).toHaveBeenCalledTimes(1);
  });

  it("delegates workspace reclamation to the cancellable exact Git helper", () => {
    expect(hostTeardownSubstrate.removeWorkspace).toBe(removeSpawnWorktreeExactAsync);
  });
});
