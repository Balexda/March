import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for the container-launch module.
 *
 * The unit test surface uses `vi.mock` to stub `node:child_process` at the
 * `execFileSync` boundary so the docker run / docker rm helpers can be
 * asserted without requiring a running Docker daemon. Mirrors the testing
 * approach used by `snapshot-build.test.ts`.
 */

// `vi.mock` is hoisted, so the factory must close over a mutable handle
// the test bodies can reach in order to vary the spy behavior per test.
const childProcessMock = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: childProcessMock.execFileSync,
}));

// Import under test AFTER vi.mock so the mock is applied to its imports.
import {
  CONTAINER_PROMPT_PATH,
  LaunchError,
  launchSpawnContainer,
  removeSpawnContainer,
} from "./container-launch.js";
import { SPAWN_CONFIG } from "../hatchery/spawn-config.js";

const SPAWN_ID = "20260504-abc123";
const CONTAINER_NAME = `march-spawn-${SPAWN_ID}`;
const IMAGE_TAG = `march-spawn-${SPAWN_ID}`;

const EXPECTED_ENTRYPOINT = [
  "sh",
  "-c",
  `claude -p "$(cat ${CONTAINER_PROMPT_PATH})" --output-format json --dangerously-skip-permissions --bare --no-session-persistence`,
];

describe("container-launch", () => {
  beforeEach(() => {
    childProcessMock.execFileSync.mockReset();
  });

  describe("CONTAINER_PROMPT_PATH", () => {
    it("documents the in-container prompt path Story 6 must populate", () => {
      expect(CONTAINER_PROMPT_PATH).toBe("/march/prompt.txt");
    });
  });

  describe("launchSpawnContainer", () => {
    it("invokes `docker run -d` with all required flags in the contract's order", () => {
      childProcessMock.execFileSync.mockReturnValueOnce(
        Buffer.from("abc123def456789\n"),
      );

      launchSpawnContainer({ spawnId: SPAWN_ID });

      expect(childProcessMock.execFileSync).toHaveBeenCalledTimes(1);
      const [bin, args] = childProcessMock.execFileSync.mock.calls[0];
      expect(bin).toBe("docker");

      const expectedCapDropFlags = SPAWN_CONFIG.capDrop.map(
        (cap) => `--cap-drop=${cap}`,
      );

      const expectedEnvFlags: string[] = [];
      for (const envVar of SPAWN_CONFIG.envWhitelist) {
        // Passthrough form: two adjacent argv entries `-e` then `VAR`,
        // never `-e VAR=<value>` — Docker reads the value from the
        // operator's environment per SD-001.
        expectedEnvFlags.push("-e", envVar);
      }

      expect(args).toEqual([
        "run",
        "-d",
        "--name",
        CONTAINER_NAME,
        ...expectedCapDropFlags,
        "--user",
        SPAWN_CONFIG.user,
        "--memory",
        SPAWN_CONFIG.memoryLimit,
        "--cpus",
        SPAWN_CONFIG.cpuLimit,
        "--network",
        SPAWN_CONFIG.networkMode,
        ...expectedEnvFlags,
        IMAGE_TAG,
        ...EXPECTED_ENTRYPOINT,
      ]);
    });

    it("derives every `--cap-drop=<cap>` flag from SPAWN_CONFIG.capDrop", () => {
      childProcessMock.execFileSync.mockReturnValueOnce(Buffer.from("id\n"));

      launchSpawnContainer({ spawnId: SPAWN_ID });

      const [, args] = childProcessMock.execFileSync.mock.calls[0];
      const argList = args as string[];
      const capDropArgs = argList.filter((a) => a.startsWith("--cap-drop"));
      // One combined-form `--cap-drop=<cap>` entry per SPAWN_CONFIG entry,
      // and nothing else. Locks the derivation so a future cap addition
      // in SPAWN_CONFIG.capDrop is automatically surfaced to docker run.
      expect(capDropArgs).toEqual(
        SPAWN_CONFIG.capDrop.map((cap) => `--cap-drop=${cap}`),
      );
    });

    it("passes env-vars in passthrough form (`-e VAR`, no `=value`)", () => {
      childProcessMock.execFileSync.mockReturnValueOnce(Buffer.from("id\n"));

      launchSpawnContainer({ spawnId: SPAWN_ID });

      const [, args] = childProcessMock.execFileSync.mock.calls[0];
      const argList = args as string[];
      // Find `-e` flags and confirm the next argv entry is the bare var name.
      for (let i = 0; i < argList.length; i++) {
        if (argList[i] === "-e") {
          const next = argList[i + 1];
          expect(next).toBeDefined();
          expect(next).not.toContain("=");
          expect(SPAWN_CONFIG.envWhitelist).toContain(next);
        }
        // No combined `-e VAR=value` form anywhere in the argv.
        expect(argList[i]).not.toMatch(/^-e=/);
      }
    });

    it("returns the trimmed container ID from `docker run -d` stdout", () => {
      const fakeId = "abc123def456789012345678";
      childProcessMock.execFileSync.mockReturnValueOnce(
        Buffer.from(`${fakeId}\n`),
      );

      const got = launchSpawnContainer({ spawnId: SPAWN_ID });
      expect(got).toBe(fakeId);
    });

    it("emits the Claude Code entrypoint verbatim from the contracts", () => {
      childProcessMock.execFileSync.mockReturnValueOnce(Buffer.from("id\n"));

      launchSpawnContainer({ spawnId: SPAWN_ID });

      const [, args] = childProcessMock.execFileSync.mock.calls[0];
      const argList = args as string[];

      // The image tag immediately precedes the entrypoint argv. Use
      // `lastIndexOf` because the container name (`--name march-spawn-<id>`)
      // and image tag share the same string by design — both come from
      // `march-spawn-<id>` for naming parity, so the rightmost occurrence
      // is the image positional arg.
      const imageIdx = argList.lastIndexOf(IMAGE_TAG);
      expect(imageIdx).toBeGreaterThan(-1);
      const entrypoint = argList.slice(imageIdx + 1);

      expect(entrypoint).toEqual(EXPECTED_ENTRYPOINT);
      const shellCmd = entrypoint[2];
      expect(shellCmd).toContain("$(cat /march/prompt.txt)");
      expect(shellCmd).toMatch(
        /--output-format json --dangerously-skip-permissions --bare --no-session-persistence$/,
      );
    });

    it("throws LaunchError surfacing the docker stderr tail on launch failure", () => {
      const stderrText =
        "docker: Error response from daemon: simulated launch failure: bind mount source path does not exist\n";
      const err = Object.assign(new Error("Command failed"), {
        stderr: Buffer.from(stderrText),
        status: 1,
      });
      // First call: docker run fails. Second call: cleanup `docker rm -f`
      // succeeds (no-op).
      childProcessMock.execFileSync
        .mockImplementationOnce(() => {
          throw err;
        })
        .mockReturnValueOnce(Buffer.from(""));

      let caught: unknown;
      try {
        launchSpawnContainer({ spawnId: SPAWN_ID });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(LaunchError);
      const message = (caught as LaunchError).message;
      expect(message).toContain("simulated launch failure");
    });

    it("invokes `removeSpawnContainer` as part of the failure path", () => {
      const err = Object.assign(new Error("boom"), {
        stderr: Buffer.from("ERROR: explosion\n"),
        status: 1,
      });
      childProcessMock.execFileSync
        .mockImplementationOnce(() => {
          throw err;
        })
        // Second call: cleanup `docker rm -f` succeeds.
        .mockReturnValueOnce(Buffer.from(""));

      try {
        launchSpawnContainer({ spawnId: SPAWN_ID });
      } catch {
        // expected
      }

      expect(childProcessMock.execFileSync).toHaveBeenCalledTimes(2);
      const [bin2, args2] = childProcessMock.execFileSync.mock.calls[1];
      expect(bin2).toBe("docker");
      expect(args2).toEqual(["rm", "-f", CONTAINER_NAME]);
    });

    it("does not swallow the original LaunchError if the cleanup `docker rm -f` also fails", () => {
      const launchErr = Object.assign(new Error("launch failed"), {
        stderr: Buffer.from("launch stderr\n"),
        status: 1,
      });
      const rmErr = Object.assign(new Error("rm failed"), {
        stderr: Buffer.from("No such container\n"),
        status: 1,
      });
      childProcessMock.execFileSync
        .mockImplementationOnce(() => {
          throw launchErr;
        })
        .mockImplementationOnce(() => {
          throw rmErr;
        });

      let caught: unknown;
      try {
        launchSpawnContainer({ spawnId: SPAWN_ID });
      } catch (e) {
        caught = e;
      }
      // Original launch error must still surface; the rm failure is best-effort.
      expect(caught).toBeInstanceOf(LaunchError);
      expect((caught as LaunchError).message).toContain("launch stderr");
    });
  });

  describe("removeSpawnContainer", () => {
    it("invokes `docker rm -f march-spawn-<id>` for the spawn ID", () => {
      childProcessMock.execFileSync.mockReturnValueOnce(Buffer.from(""));
      removeSpawnContainer(SPAWN_ID);

      expect(childProcessMock.execFileSync).toHaveBeenCalledTimes(1);
      const [bin, args] = childProcessMock.execFileSync.mock.calls[0];
      expect(bin).toBe("docker");
      expect(args).toEqual(["rm", "-f", CONTAINER_NAME]);
    });

    it("does not throw if the container does not exist", () => {
      const err = Object.assign(new Error("no such container"), {
        stderr: Buffer.from(
          `Error response from daemon: No such container: ${CONTAINER_NAME}\n`,
        ),
        status: 1,
      });
      childProcessMock.execFileSync.mockImplementationOnce(() => {
        throw err;
      });
      expect(() => removeSpawnContainer(SPAWN_ID)).not.toThrow();
    });

    it("is idempotent under repeated invocation", () => {
      childProcessMock.execFileSync
        .mockReturnValueOnce(Buffer.from(""))
        .mockImplementationOnce(() => {
          // Second call: container already gone — must not throw.
          throw Object.assign(new Error("no such container"), {
            stderr: Buffer.from("No such container\n"),
            status: 1,
          });
        });
      expect(() => removeSpawnContainer(SPAWN_ID)).not.toThrow();
      expect(() => removeSpawnContainer(SPAWN_ID)).not.toThrow();
    });
  });
});
