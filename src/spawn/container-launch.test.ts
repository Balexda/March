import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for the container-launch module.
 *
 * The unit test surface uses `vi.mock` to stub `node:child_process` at the
 * `execFileSync` boundary so the docker create / docker rm helpers can be
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
  copyPromptToContainer,
  createSpawnContainer,
  LaunchError,
  launchSpawnContainer,
  readSpawnContainerLogs,
  removeSpawnContainer,
  startSpawnContainer,
  waitForSpawnContainer,
} from "./container-launch.js";
import { claudeCodeBackend, codexBackend } from "./backends.js";
import { SPAWN_CONFIG } from "../hatchery/spawn-config.js";

const SPAWN_ID = "20260504-abc123";
const CONTAINER_NAME = `march-spawn-${SPAWN_ID}`;
const IMAGE_TAG = `march-spawn-${SPAWN_ID}`;

// The backend composes its agent command inside the deterministic git
// scaffold; container-launch must pass that argv through byte-for-byte (the
// scaffold's exact shape is covered in backends.test.ts).
const EXPECTED_ENTRYPOINT = claudeCodeBackend.buildEntrypoint(
  CONTAINER_PROMPT_PATH,
);

const CODEX_HOME = "/tmp/march-test-codex-home";

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
    it("invokes `docker create` with all required flags in the contract's order", () => {
      childProcessMock.execFileSync.mockReturnValueOnce(
        Buffer.from("abc123def456789\n"),
      );

      createSpawnContainer({ spawnId: SPAWN_ID, backend: claudeCodeBackend });

      expect(childProcessMock.execFileSync).toHaveBeenCalledTimes(1);
      const [bin, args] = childProcessMock.execFileSync.mock.calls[0];
      expect(bin).toBe("docker");

      const expectedCapDropFlags = SPAWN_CONFIG.capDrop.map(
        (cap) => `--cap-drop=${cap}`,
      );

      const expectedEnvFlags: string[] = [];
      for (const envVar of claudeCodeBackend.requiredEnvVars) {
        // Passthrough form: two adjacent argv entries `-e` then `VAR`,
        // never `-e VAR=<value>` — Docker reads the value from the
        // operator's environment per SD-001.
        expectedEnvFlags.push("-e", envVar);
      }

      expect(args).toEqual([
        "create",
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

      createSpawnContainer({ spawnId: SPAWN_ID, backend: claudeCodeBackend });

      const [, args] = childProcessMock.execFileSync.mock.calls[0];
      const argList = args as string[];
      const capDropArgs = argList.filter((a) => a.startsWith("--cap-drop"));
      // One combined-form `--cap-drop=<cap>` entry per SPAWN_CONFIG entry,
      // and nothing else. Locks the derivation so a future cap addition
      // in SPAWN_CONFIG.capDrop is automatically surfaced to docker create.
      expect(capDropArgs).toEqual(
        SPAWN_CONFIG.capDrop.map((cap) => `--cap-drop=${cap}`),
      );
    });

    it("passes env-vars in passthrough form (`-e VAR`, no `=value`)", () => {
      childProcessMock.execFileSync.mockReturnValueOnce(Buffer.from("id\n"));

      createSpawnContainer({ spawnId: SPAWN_ID, backend: claudeCodeBackend });

      const [, args] = childProcessMock.execFileSync.mock.calls[0];
      const argList = args as string[];
      // Find `-e` flags and confirm the next argv entry is the bare var name.
      for (let i = 0; i < argList.length; i++) {
        if (argList[i] === "-e") {
          const next = argList[i + 1];
          expect(next).toBeDefined();
          expect(next).not.toContain("=");
          expect(claudeCodeBackend.requiredEnvVars).toContain(next);
        }
        // No combined `-e VAR=value` form anywhere in the argv.
        expect(argList[i]).not.toMatch(/^-e=/);
      }
    });

    it("returns the trimmed container ID from `docker create` stdout", () => {
      const fakeId = "abc123def456789012345678";
      childProcessMock.execFileSync.mockReturnValueOnce(
        Buffer.from(`${fakeId}\n`),
      );

      const got = createSpawnContainer({
        spawnId: SPAWN_ID,
        backend: claudeCodeBackend,
      });
      expect(got).toBe(fakeId);
    });

    it("emits the Claude Code entrypoint verbatim from the contracts", () => {
      childProcessMock.execFileSync.mockReturnValueOnce(Buffer.from("id\n"));

      createSpawnContainer({ spawnId: SPAWN_ID, backend: claudeCodeBackend });

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
      expect(shellCmd).toContain(
        "--output-format json --dangerously-skip-permissions --bare --no-session-persistence",
      );
    });

    it("leaves argv byte-for-byte unchanged when no OTEL context is supplied", () => {
      childProcessMock.execFileSync.mockReturnValueOnce(Buffer.from("id\n"));
      createSpawnContainer({ spawnId: SPAWN_ID, backend: claudeCodeBackend });
      const [, args] = childProcessMock.execFileSync.mock.calls[0];
      const argList = args as string[];
      expect(argList).not.toContain("--add-host");
      expect(argList.join(" ")).not.toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
      expect(argList.join(" ")).not.toContain("TRACEPARENT=");
      const imageIdx = argList.lastIndexOf(IMAGE_TAG);
      expect(argList.slice(imageIdx + 1)).toEqual(EXPECTED_ENTRYPOINT);
    });

    it("injects host-gateway + OTLP env and wraps the entrypoint when OTEL is on", () => {
      childProcessMock.execFileSync.mockReturnValueOnce(Buffer.from("id\n"));
      const traceparent = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
      createSpawnContainer({
        spawnId: SPAWN_ID,
        backend: claudeCodeBackend,
        otel: {
          endpoint: "http://host.docker.internal:4318",
          traceparent,
          resourceAttributes: "service.name=march-spawn,march.task.type=forge",
        },
      });
      const [, args] = childProcessMock.execFileSync.mock.calls[0];
      const argList = args as string[];

      // Host-gateway route so the bridge-network container reaches the host.
      const hostIdx = argList.indexOf("--add-host");
      expect(hostIdx).toBeGreaterThan(-1);
      expect(argList[hostIdx + 1]).toBe("host.docker.internal:host-gateway");

      // OTLP env injected as -e KEY=VALUE pairs.
      expect(argList).toContain(
        "OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318",
      );
      expect(argList).toContain(`TRACEPARENT=${traceparent}`);
      expect(argList).toContain(
        "OTEL_RESOURCE_ATTRIBUTES=service.name=march-spawn,march.task.type=forge",
      );

      // Entrypoint wrapped to time the agent run and emit a span afterwards,
      // while preserving the original backend command and exit code.
      const imageIdx = argList.lastIndexOf(IMAGE_TAG);
      const entrypoint = argList.slice(imageIdx + 1);
      expect(entrypoint[0]).toBe("sh");
      expect(entrypoint[1]).toBe("-c");
      expect(entrypoint[2]).toContain('$(cat /march/prompt.txt)');
      expect(entrypoint[2]).toContain("/march/otel-emit.js");
      expect(entrypoint[2]).toContain("exit $__rc");
    });

    it("throws LaunchError surfacing the docker stderr tail on launch failure", () => {
      const stderrText =
        "docker: Error response from daemon: simulated launch failure: bind mount source path does not exist\n";
      const err = Object.assign(new Error("Command failed"), {
        stderr: Buffer.from(stderrText),
        status: 1,
      });
      // First call: docker create fails. Second call: cleanup `docker rm -f`
      // succeeds (no-op).
      childProcessMock.execFileSync
        .mockImplementationOnce(() => {
          throw err;
        })
        .mockReturnValueOnce(Buffer.from(""));

      let caught: unknown;
      try {
        createSpawnContainer({ spawnId: SPAWN_ID, backend: claudeCodeBackend });
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
        createSpawnContainer({ spawnId: SPAWN_ID, backend: claudeCodeBackend });
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
        createSpawnContainer({ spawnId: SPAWN_ID, backend: claudeCodeBackend });
      } catch (e) {
        caught = e;
      }
      // Original launch error must still surface; the rm failure is best-effort.
      expect(caught).toBeInstanceOf(LaunchError);
      expect((caught as LaunchError).message).toContain("launch stderr");
    });

    it("uses the Codex backend entrypoint and read-only credential mount", () => {
      const previousCodexHome = process.env.CODEX_HOME;
      process.env.CODEX_HOME = CODEX_HOME;
      childProcessMock.execFileSync.mockReturnValueOnce(Buffer.from("id\n"));

      try {
        createSpawnContainer({ spawnId: SPAWN_ID, backend: codexBackend });
      } finally {
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousCodexHome;
      }

      const [, args] = childProcessMock.execFileSync.mock.calls[0];
      const argList = args as string[];
      expect(argList).toContain("-v");
      expect(argList).toContain(`${CODEX_HOME}:/march/codex-auth:ro`);
      expect(argList).toContain("CODEX_HOME=/march/codex-home");

      const imageIdx = argList.lastIndexOf(IMAGE_TAG);
      const entrypoint = argList.slice(imageIdx + 1);
      expect(entrypoint).toEqual(
        codexBackend.buildEntrypoint(CONTAINER_PROMPT_PATH),
      );
      expect(entrypoint[2]).toContain(
        `cp -R /march/codex-auth/. /march/codex-home/ && chmod -R u+rwX /march/codex-home && codex exec --json --ephemeral --ignore-rules --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --cd /march/workspace - < ${CONTAINER_PROMPT_PATH}`,
      );
    });

    it("keeps launchSpawnContainer as a compatibility alias for create", () => {
      childProcessMock.execFileSync.mockReturnValueOnce(Buffer.from("id\n"));
      expect(
        launchSpawnContainer({ spawnId: SPAWN_ID, backend: claudeCodeBackend }),
      ).toBe("id");
      const [, args] = childProcessMock.execFileSync.mock.calls[0];
      expect((args as string[])[0]).toBe("create");
    });
  });

  describe("prompt handoff and lifecycle helpers", () => {
    it("copies the prompt into the stopped container before start", () => {
      childProcessMock.execFileSync.mockReturnValueOnce(Buffer.from(""));

      copyPromptToContainer("container-id", "hello");

      expect(childProcessMock.execFileSync).toHaveBeenCalledTimes(1);
      const [bin, args] = childProcessMock.execFileSync.mock.calls[0];
      expect(bin).toBe("docker");
      expect((args as string[])[0]).toBe("cp");
      expect((args as string[])[2]).toBe(`container-id:${CONTAINER_PROMPT_PATH}`);
    });

    it("starts the created container", () => {
      childProcessMock.execFileSync.mockReturnValueOnce(Buffer.from(""));
      startSpawnContainer("container-id");
      expect(childProcessMock.execFileSync).toHaveBeenCalledWith(
        "docker",
        ["start", "container-id"],
        expect.objectContaining({ stdio: ["ignore", "ignore", "pipe"] }),
      );
    });

    it("waits for the container and parses the exit code", () => {
      childProcessMock.execFileSync.mockReturnValueOnce(Buffer.from("0\n"));
      expect(waitForSpawnContainer("container-id")).toEqual({ exitCode: 0 });
      expect(childProcessMock.execFileSync).toHaveBeenCalledWith(
        "docker",
        ["wait", "container-id"],
        expect.objectContaining({
          stdio: ["ignore", "pipe", "pipe"],
          timeout: SPAWN_CONFIG.timeoutSeconds * 1000,
        }),
      );
    });

    it("removes the container and throws if docker wait exceeds the configured timeout", () => {
      const timeoutErr = Object.assign(new Error("spawnSync docker ETIMEDOUT"), {
        code: "ETIMEDOUT",
        killed: true,
        signal: "SIGTERM",
      });
      childProcessMock.execFileSync
        .mockImplementationOnce(() => {
          throw timeoutErr;
        })
        .mockReturnValueOnce(Buffer.from(""));

      expect(() => waitForSpawnContainer("container-id")).toThrow(LaunchError);
      expect(childProcessMock.execFileSync).toHaveBeenNthCalledWith(
        2,
        "docker",
        ["rm", "-f", "container-id"],
        expect.objectContaining({ stdio: ["ignore", "ignore", "pipe"] }),
      );
    });

    it("rejects unparseable docker wait output", () => {
      childProcessMock.execFileSync.mockReturnValueOnce(Buffer.from("0\n1\n"));
      expect(() => waitForSpawnContainer("container-id")).toThrow(LaunchError);
    });

    it("reads docker logs as text", () => {
      childProcessMock.execFileSync.mockReturnValueOnce(Buffer.from("Olympia\n"));
      expect(readSpawnContainerLogs("container-id")).toBe("Olympia\n");
      expect(childProcessMock.execFileSync).toHaveBeenCalledWith(
        "docker",
        ["logs", "container-id"],
        expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
      );
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
