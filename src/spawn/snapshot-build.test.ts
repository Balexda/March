import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Tests for the snapshot-build module.
 *
 * The unit test surface exercises the Dockerfile generator with pure text
 * assertions and uses `vi.mock` to stub `node:child_process` at the
 * `execFileSync` boundary so the docker build / docker image rm helpers
 * can be asserted without requiring a running Docker daemon.
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
  BuildError,
  buildSpawnImage,
  removeSpawnImage,
  writeSpawnDockerfile,
  SPAWN_DOCKERFILE_NAME,
} from "./snapshot-build.js";
import { claudeCodeBackend, codexBackend } from "./backends.js";

describe("snapshot-build", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(prefix = "march-snapshot-build-"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    childProcessMock.execFileSync.mockReset();
  });

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpDirs.length = 0;
  });

  describe("writeSpawnDockerfile", () => {
    it("writes a Dockerfile whose contents exactly match the contracts' template", () => {
      const ctx = makeTmpDir();
      const dockerfilePath = writeSpawnDockerfile(
        ctx,
        claudeCodeBackend.baseImage,
      );
      const got = fs.readFileSync(dockerfilePath, "utf-8");
      // Verbatim from the contracts' Image Build template — base image,
      // COPY --chown=march:march . /march/workspace, WORKDIR /march/workspace.
      expect(got).toBe(
        `FROM ${claudeCodeBackend.baseImage}\n` +
          `COPY --chown=march:march . /march/workspace\n` +
          `WORKDIR /march/workspace\n`,
      );
    });

    it("writes the Dockerfile inside the build context directory", () => {
      const ctx = makeTmpDir();
      const dockerfilePath = writeSpawnDockerfile(
        ctx,
        claudeCodeBackend.baseImage,
      );
      expect(path.dirname(dockerfilePath)).toBe(ctx);
      expect(path.basename(dockerfilePath)).toBe(SPAWN_DOCKERFILE_NAME);
      expect(fs.existsSync(dockerfilePath)).toBe(true);
    });

    it("writes the selected backend image into the FROM line", () => {
      const ctx = makeTmpDir();
      const claudeDockerfile = writeSpawnDockerfile(
        ctx,
        claudeCodeBackend.baseImage,
      );
      expect(fs.readFileSync(claudeDockerfile, "utf-8")).toContain(
        `FROM ${claudeCodeBackend.baseImage}\n`,
      );

      const codexCtx = makeTmpDir();
      const codexDockerfile = writeSpawnDockerfile(
        codexCtx,
        codexBackend.baseImage,
      );
      expect(fs.readFileSync(codexDockerfile, "utf-8")).toContain(
        `FROM ${codexBackend.baseImage}\n`,
      );
    });
  });

  describe("buildSpawnImage", () => {
    it("invokes `docker build` with the contract's argument shape and returns the tag", () => {
      childProcessMock.execFileSync.mockReturnValueOnce(Buffer.from(""));
      const ctx = makeTmpDir();
      const dockerfile = writeSpawnDockerfile(ctx, claudeCodeBackend.baseImage);

      const tag = buildSpawnImage({
        spawnId: "20260504-abc123",
        contextPath: ctx,
        dockerfilePath: dockerfile,
      });

      expect(tag).toBe("march-spawn-20260504-abc123");
      expect(childProcessMock.execFileSync).toHaveBeenCalledTimes(1);
      const [bin, args] = childProcessMock.execFileSync.mock.calls[0];
      expect(bin).toBe("docker");
      // Matches: `docker build -t march-spawn-<id> -f <dockerfile> <context>`.
      expect(args).toEqual([
        "build",
        "-t",
        "march-spawn-20260504-abc123",
        "-f",
        dockerfile,
        ctx,
      ]);
    });

    it("does not pass any bind-mount / volume flags (COPY-only context)", () => {
      childProcessMock.execFileSync.mockReturnValueOnce(Buffer.from(""));
      const ctx = makeTmpDir();
      const dockerfile = writeSpawnDockerfile(ctx, claudeCodeBackend.baseImage);

      buildSpawnImage({
        spawnId: "20260504-abc123",
        contextPath: ctx,
        dockerfilePath: dockerfile,
      });

      const [, args] = childProcessMock.execFileSync.mock.calls[0];
      // No bind mount of host paths — satisfies FR-010 / AS 4.3.
      for (const arg of args as string[]) {
        expect(arg).not.toMatch(/^-v(=|$)/);
        expect(arg).not.toBe("--mount");
        expect(arg).not.toBe("--volume");
      }
    });

    it("throws BuildError surfacing the docker stderr tail on build failure", () => {
      const stderrText =
        "Step 1/3 : FROM march-spawn-claude:latest\n" +
        "ERROR: failed to solve: pull access denied for march-spawn-claude, repository does not exist\n";
      const err = Object.assign(new Error("Command failed"), {
        stderr: Buffer.from(stderrText),
        status: 1,
      });
      // First call: docker build fails. Second call: cleanup `docker image rm`
      // succeeds (no-op).
      childProcessMock.execFileSync
        .mockImplementationOnce(() => {
          throw err;
        })
        .mockReturnValueOnce(Buffer.from(""));

      const ctx = makeTmpDir();
      const dockerfile = writeSpawnDockerfile(ctx, claudeCodeBackend.baseImage);

      let caught: unknown;
      try {
        buildSpawnImage({
          spawnId: "20260504-abc123",
          contextPath: ctx,
          dockerfilePath: dockerfile,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(BuildError);
      const message = (caught as BuildError).message;
      // Surfaces the relevant docker stderr tail so operators can diagnose.
      expect(message).toContain("pull access denied");
    });

    it("removes the partially tagged image after a build failure", () => {
      const err = Object.assign(new Error("boom"), {
        stderr: Buffer.from("ERROR: explosion\n"),
        status: 1,
      });
      childProcessMock.execFileSync
        .mockImplementationOnce(() => {
          throw err;
        })
        // Second call: cleanup `docker image rm` succeeds.
        .mockReturnValueOnce(Buffer.from(""));

      const ctx = makeTmpDir();
      const dockerfile = writeSpawnDockerfile(ctx, claudeCodeBackend.baseImage);

      try {
        buildSpawnImage({
          spawnId: "20260504-abc123",
          contextPath: ctx,
          dockerfilePath: dockerfile,
        });
      } catch {
        // expected
      }

      // First call was the failed build; second call must be the cleanup
      // `docker image rm` for the spawn tag.
      expect(childProcessMock.execFileSync).toHaveBeenCalledTimes(2);
      const [bin2, args2] = childProcessMock.execFileSync.mock.calls[1];
      expect(bin2).toBe("docker");
      expect(args2 as string[]).toContain("image");
      expect(args2 as string[]).toContain("rm");
      expect(args2 as string[]).toContain("march-spawn-20260504-abc123");
    });

    it("does not swallow the original error if the cleanup `docker image rm` also fails", () => {
      const buildErr = Object.assign(new Error("build failed"), {
        stderr: Buffer.from("build stderr\n"),
        status: 1,
      });
      const rmErr = Object.assign(new Error("rm failed"), {
        stderr: Buffer.from("No such image\n"),
        status: 1,
      });
      childProcessMock.execFileSync
        .mockImplementationOnce(() => {
          throw buildErr;
        })
        .mockImplementationOnce(() => {
          throw rmErr;
        });

      const ctx = makeTmpDir();
      const dockerfile = writeSpawnDockerfile(ctx, claudeCodeBackend.baseImage);

      let caught: unknown;
      try {
        buildSpawnImage({
          spawnId: "20260504-abc123",
          contextPath: ctx,
          dockerfilePath: dockerfile,
        });
      } catch (e) {
        caught = e;
      }
      // Original build error must still surface; the rm failure is best-effort.
      expect(caught).toBeInstanceOf(BuildError);
      expect((caught as BuildError).message).toContain("build stderr");
    });
  });

  describe("removeSpawnImage", () => {
    it("invokes `docker image rm <tag>` for the spawn ID", () => {
      childProcessMock.execFileSync.mockReturnValueOnce(Buffer.from(""));
      removeSpawnImage("20260504-abc123");

      expect(childProcessMock.execFileSync).toHaveBeenCalledTimes(1);
      const [bin, args] = childProcessMock.execFileSync.mock.calls[0];
      expect(bin).toBe("docker");
      expect(args).toEqual([
        "image",
        "rm",
        "march-spawn-20260504-abc123",
      ]);
    });

    it("does not throw if the image is absent", () => {
      const err = Object.assign(new Error("no such image"), {
        stderr: Buffer.from(
          "Error response from daemon: No such image: march-spawn-20260504-abc123\n",
        ),
        status: 1,
      });
      childProcessMock.execFileSync.mockImplementationOnce(() => {
        throw err;
      });
      expect(() => removeSpawnImage("20260504-abc123")).not.toThrow();
    });

    it("is idempotent under repeated invocation", () => {
      childProcessMock.execFileSync
        .mockReturnValueOnce(Buffer.from(""))
        .mockImplementationOnce(() => {
          // Second call: image already gone — must not throw.
          throw Object.assign(new Error("no such image"), {
            stderr: Buffer.from("No such image\n"),
            status: 1,
          });
        });
      expect(() => removeSpawnImage("20260504-abc123")).not.toThrow();
      expect(() => removeSpawnImage("20260504-abc123")).not.toThrow();
    });
  });
});
