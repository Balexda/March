import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Tests for the prompt-handoff module (Stage 5 of the Spawn Dispatch
 * pipeline).
 *
 * The unit test surface uses `vi.mock` to stub `node:child_process` at
 * the `execFileSync` boundary so the docker cp helper can be asserted
 * without requiring a running Docker daemon. Mirrors the testing
 * approach used by `snapshot-build.test.ts` and `container-launch.test.ts`.
 *
 * A gated integration test at the bottom of this file round-trips the
 * prompt through a real container started for the test — skipped when
 * docker is not available. Per the slice 1 acceptance criteria the
 * integration test must mirror US4's docker-stub-vs-real-daemon pattern.
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
import { HandoffError, handoffPromptToContainer } from "./prompt-handoff.js";
import { PROMPT_PATH } from "./spawn-config.js";

const CONTAINER_ID = "abc123def456789012345678";
const FINALIZED_PROMPT =
  "Spawn ID: 20260411-a1b2c3\n" +
  "Working Directory: /march/workspace\n" +
  "\n" +
  "Hello, world!";

describe("prompt-handoff", () => {
  describe("PROMPT_PATH constant", () => {
    it("is /march/prompt.txt (matches the entrypoint's $(cat ...) target)", () => {
      // Locks the value the helper writes to by default. Mirrors the
      // assertion in container-launch.test.ts to keep the two sides
      // anchored to the same path.
      expect(PROMPT_PATH).toBe("/march/prompt.txt");
    });
  });

  describe("handoffPromptToContainer", () => {
    beforeEach(() => {
      childProcessMock.execFileSync.mockReset();
    });

    it("invokes `docker cp <hostTempFile> <containerId>:/march/prompt.txt`", () => {
      childProcessMock.execFileSync.mockReturnValueOnce(Buffer.from(""));

      handoffPromptToContainer({
        containerId: CONTAINER_ID,
        finalizedPrompt: FINALIZED_PROMPT,
      });

      expect(childProcessMock.execFileSync).toHaveBeenCalledTimes(1);
      const [bin, args] = childProcessMock.execFileSync.mock.calls[0];
      expect(bin).toBe("docker");
      const argList = args as string[];
      expect(argList[0]).toBe("cp");
      // argList[1] is the host-side temp file path — its parent dir lives
      // under os.tmpdir() and the basename is "prompt.txt".
      expect(typeof argList[1]).toBe("string");
      expect(path.basename(argList[1])).toBe("prompt.txt");
      expect(argList[1].startsWith(os.tmpdir())).toBe(true);
      // argList[2] is `<containerId>:<targetPath>`.
      expect(argList[2]).toBe(`${CONTAINER_ID}:${PROMPT_PATH}`);
    });

    it("writes the finalized prompt verbatim to the host temp file", () => {
      // Capture the host temp file path the helper passes to docker cp,
      // read its contents inside the stub before the helper cleans up the
      // temp dir, and assert the file content matches the input prompt.
      let observedContent: string | undefined;
      childProcessMock.execFileSync.mockImplementationOnce((_bin, args) => {
        const argList = args as string[];
        const hostFile = argList[1];
        observedContent = fs.readFileSync(hostFile, "utf-8");
        return Buffer.from("");
      });

      handoffPromptToContainer({
        containerId: CONTAINER_ID,
        finalizedPrompt: FINALIZED_PROMPT,
      });

      expect(observedContent).toBe(FINALIZED_PROMPT);
    });

    it("uses the override `containerPromptPath` when one is supplied", () => {
      childProcessMock.execFileSync.mockReturnValueOnce(Buffer.from(""));

      handoffPromptToContainer({
        containerId: CONTAINER_ID,
        finalizedPrompt: FINALIZED_PROMPT,
        containerPromptPath: "/elsewhere/prompt.txt",
      });

      const [, args] = childProcessMock.execFileSync.mock.calls[0];
      const argList = args as string[];
      expect(argList[2]).toBe(`${CONTAINER_ID}:/elsewhere/prompt.txt`);
    });

    it("throws HandoffError surfacing the docker stderr tail on docker cp failure", () => {
      const stderrText =
        "Error: No such container: " + CONTAINER_ID + "\n" +
        "simulated cp failure\n";
      const err = Object.assign(new Error("Command failed"), {
        stderr: Buffer.from(stderrText),
        status: 1,
      });
      childProcessMock.execFileSync.mockImplementationOnce(() => {
        throw err;
      });

      let caught: unknown;
      try {
        handoffPromptToContainer({
          containerId: CONTAINER_ID,
          finalizedPrompt: FINALIZED_PROMPT,
        });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(HandoffError);
      const message = (caught as HandoffError).message;
      expect(message).toContain("simulated cp failure");
      expect(message).toContain(CONTAINER_ID);
    });

    it("throws HandoffError when the host temp file cannot be created", () => {
      // Force mkdtempSync to fail by pointing TMPDIR at a path that
      // cannot host a directory. `/dev/null/nope` ensures mkdtempSync
      // returns ENOTDIR (or similar) before any docker invocation runs.
      const savedTmpDir = process.env.TMPDIR;
      process.env.TMPDIR = "/dev/null/nope";
      try {
        let caught: unknown;
        try {
          handoffPromptToContainer({
            containerId: CONTAINER_ID,
            finalizedPrompt: FINALIZED_PROMPT,
          });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(HandoffError);
        // docker cp must NOT have been called when the temp file step fails.
        expect(childProcessMock.execFileSync).not.toHaveBeenCalled();
      } finally {
        if (savedTmpDir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = savedTmpDir;
      }
    });

    it("cleans up the host temp directory after a successful handoff", () => {
      let observedHostFile: string | undefined;
      childProcessMock.execFileSync.mockImplementationOnce((_bin, args) => {
        const argList = args as string[];
        observedHostFile = argList[1];
        return Buffer.from("");
      });

      handoffPromptToContainer({
        containerId: CONTAINER_ID,
        finalizedPrompt: FINALIZED_PROMPT,
      });

      expect(observedHostFile).toBeDefined();
      // Both the temp file and its parent temp directory should be gone.
      expect(fs.existsSync(observedHostFile as string)).toBe(false);
      expect(fs.existsSync(path.dirname(observedHostFile as string))).toBe(
        false,
      );
    });

    it("cleans up the host temp directory after a docker cp failure", () => {
      let observedHostFile: string | undefined;
      const err = Object.assign(new Error("boom"), {
        stderr: Buffer.from("ERROR: explosion\n"),
        status: 1,
      });
      childProcessMock.execFileSync.mockImplementationOnce((_bin, args) => {
        const argList = args as string[];
        observedHostFile = argList[1];
        throw err;
      });

      try {
        handoffPromptToContainer({
          containerId: CONTAINER_ID,
          finalizedPrompt: FINALIZED_PROMPT,
        });
      } catch {
        // expected
      }

      expect(observedHostFile).toBeDefined();
      expect(fs.existsSync(observedHostFile as string)).toBe(false);
      expect(fs.existsSync(path.dirname(observedHostFile as string))).toBe(
        false,
      );
    });
  });
});

/**
 * Integration test gated on docker availability. Mirrors the docker-stub-
 * vs-real-daemon pattern from US4: when docker is not present (or the
 * daemon is unreachable) the integration block is skipped; otherwise it
 * round-trips a finalized prompt through a real container and asserts
 * the file contents inside the container post-handoff.
 *
 * Uses the alpine image because it's tiny and ubiquitous; the in-
 * container destination is `/tmp/march-test-prompt.txt` so we don't
 * need the image to have `/march/` pre-created.
 *
 * IMPORTANT: this integration test must invoke the REAL `execFileSync`
 * (not the vi.mock above) for the docker subprocesses it manages —
 * `docker run`, `docker exec`, `docker rm`. We use `vi.importActual`
 * to grab the real `node:child_process` exports before mocking takes
 * effect for the test body's own docker calls. The handoff helper
 * under test still uses the mocked `execFileSync` via vi.mock above,
 * so we additionally wire the mock to delegate to the real function
 * for the duration of the integration block via `mockImplementation`
 * so the helper's `docker cp` actually executes.
 */
const realChildProcess = await vi.importActual<
  typeof import("node:child_process")
>("node:child_process");
const realExecFileSync = realChildProcess.execFileSync;

const DOCKER_AVAILABLE = (() => {
  try {
    realExecFileSync(
      "docker",
      ["version", "--format", "{{.Server.Version}}"],
      {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 5000,
      },
    );
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!DOCKER_AVAILABLE)(
  "prompt-handoff (integration: real docker daemon)",
  () => {
    let containerId: string | undefined;

    beforeEach(() => {
      // For the integration test we want the helper's docker cp call to
      // hit the real daemon. Wire the mock to delegate to the real
      // execFileSync for every call this test block makes.
      childProcessMock.execFileSync.mockReset();
      childProcessMock.execFileSync.mockImplementation((bin, args, opts) =>
        realExecFileSync(
          bin as string,
          args as readonly string[],
          opts as Parameters<typeof realExecFileSync>[2],
        ),
      );
    });

    afterEach(() => {
      if (containerId) {
        try {
          realExecFileSync("docker", ["rm", "-f", containerId], {
            stdio: ["ignore", "ignore", "ignore"],
            timeout: 10000,
          });
        } catch {
          // best-effort cleanup
        }
        containerId = undefined;
      }
    });

    it("writes the finalized prompt into a running container at the override path", () => {
      // Start a long-running alpine container; capture the full container
      // ID from `docker run -d` stdout. `--rm` keeps housekeeping cheap
      // even if the afterEach `docker rm -f` is somehow skipped.
      const runOutput = realExecFileSync(
        "docker",
        ["run", "-d", "--rm", "alpine", "sleep", "60"],
        { encoding: "utf-8", timeout: 30000 },
      );
      containerId = runOutput.trim();
      expect(containerId).toMatch(/^[0-9a-f]{12,}$/);

      // Hand the prompt off into the running container. Use a /tmp
      // destination so we don't need /march/ to exist in the alpine image.
      handoffPromptToContainer({
        containerId,
        finalizedPrompt: FINALIZED_PROMPT,
        containerPromptPath: "/tmp/march-test-prompt.txt",
      });

      // Read the file back from inside the container and assert it
      // matches the finalized prompt byte-for-byte.
      const readBack = realExecFileSync(
        "docker",
        ["exec", containerId, "cat", "/tmp/march-test-prompt.txt"],
        { encoding: "utf-8", timeout: 10000 },
      );
      expect(readBack).toBe(FINALIZED_PROMPT);
    });
  },
);
