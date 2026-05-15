import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const childProcessMock = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: childProcessMock.execFileSync,
}));

import {
  buildLegateContainerRunArgs,
  ensureLegateContainer,
  HatcheryError,
  LEGATE_CONTAINER_HOME,
  LEGATE_IMAGE_TAG,
  legateContainerMounts,
  legateContainerName,
  renderLegateDockerfile,
  writeLegateDockerfile,
} from "./legate-container.js";
import { BASE_IMAGE } from "./spawn-config.js";

describe("legate-container", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(prefix = "march-legate-container-test-"): string {
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
        // best-effort
      }
    }
    tmpDirs.length = 0;
  });

  it("derives the deterministic container name from the conductor name", () => {
    expect(legateContainerName("legate-march")).toBe("march-legate-legate-march");
  });

  it("renders a toolbox Dockerfile on top of the current March base image", () => {
    const body = renderLegateDockerfile();
    expect(body).toContain(`FROM ${BASE_IMAGE}`);
    for (const pkg of [
      "bash",
      "ca-certificates",
      "git",
      "jq",
      "openssh-client",
      "python3",
      "tmux",
    ]) {
      expect(body).toContain(pkg);
    }
    expect(body).not.toContain("/home/jmbattista");
    expect(body).toContain(`mkdir -p ${LEGATE_CONTAINER_HOME}`);
    expect(body).toContain(`chmod 0777 ${LEGATE_CONTAINER_HOME}`);
    expect(body).not.toContain("legate-march");
  });

  it("writes the generated Dockerfile into the supplied build context", () => {
    const ctx = makeTmpDir();
    const dockerfile = writeLegateDockerfile(ctx, "custom-base:dev");
    expect(path.dirname(dockerfile)).toBe(ctx);
    expect(path.basename(dockerfile)).toBe("Dockerfile");
    expect(fs.readFileSync(dockerfile, "utf-8")).toContain(
      "FROM custom-base:dev",
    );
  });

  it("mounts repo and conductor state as required plus existing home state", () => {
    const home = makeTmpDir();
    const repo = path.join(home, "repo");
    const conductor = path.join(home, ".agent-deck", "conductor", "legate-march");
    const loop = path.join(home, ".agent-deck", "conductor", "march-legate-loop");
    const ghConfig = path.join(home, ".config", "gh");
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(conductor, { recursive: true });
    fs.mkdirSync(loop, { recursive: true });
    fs.mkdirSync(path.join(home, ".march"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(ghConfig, { recursive: true });
    fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n");

    const mounts = legateContainerMounts({
      repoPath: repo,
      conductorDir: conductor,
      loopConductorDir: loop,
      homeDir: home,
      dockerSocketPath: path.join(home, "missing.sock"),
    });

    expect(mounts).toEqual(
      expect.arrayContaining([
        { source: repo, target: repo, required: true },
        { source: conductor, target: conductor, required: true },
        { source: loop, target: loop, required: true },
        { source: path.join(home, ".march"), target: path.join(LEGATE_CONTAINER_HOME, ".march"), required: false },
        { source: path.join(home, ".claude"), target: path.join(LEGATE_CONTAINER_HOME, ".claude"), required: false },
        { source: ghConfig, target: path.join(LEGATE_CONTAINER_HOME, ".config", "gh"), required: false },
        { source: path.join(home, ".gitconfig"), target: path.join(LEGATE_CONTAINER_HOME, ".gitconfig"), required: false },
      ]),
    );
    expect(mounts.some((m) => m.target === "/var/run/docker.sock")).toBe(false);
  });

  it("includes the Docker socket mount when the socket path exists", () => {
    const home = makeTmpDir();
    const repo = path.join(home, "repo");
    const conductor = path.join(home, "conductor");
    const socket = path.join(home, "docker.sock");
    fs.mkdirSync(repo);
    fs.mkdirSync(conductor);
    fs.writeFileSync(socket, "");

    const mounts = legateContainerMounts({
      repoPath: repo,
      conductorDir: conductor,
      homeDir: home,
      dockerSocketPath: socket,
    });

    expect(mounts).toContainEqual({
      source: socket,
      target: "/var/run/docker.sock",
      required: false,
    });
  });

  it("mounts the default tmux socket directory even when TMUX is unset", () => {
    if (typeof process.getuid !== "function") return;
    const home = makeTmpDir();
    const repo = path.join(home, "repo");
    const conductor = path.join(home, "conductor");
    const defaultTmuxDir = path.join(os.tmpdir(), `tmux-${process.getuid()}`);
    const existed = fs.existsSync(defaultTmuxDir);
    fs.mkdirSync(repo);
    fs.mkdirSync(conductor);
    fs.mkdirSync(defaultTmuxDir, { recursive: true });
    const oldTmux = process.env.TMUX;
    delete process.env.TMUX;

    try {
      const mounts = legateContainerMounts({
        repoPath: repo,
        conductorDir: conductor,
        homeDir: home,
        dockerSocketPath: path.join(home, "missing.sock"),
      });

      expect(mounts).toContainEqual({
        source: defaultTmuxDir,
        target: defaultTmuxDir,
        required: false,
      });
    } finally {
      process.env.TMUX = oldTmux;
      if (!existed) fs.rmSync(defaultTmuxDir, { recursive: true, force: true });
    }
  });

  it("builds docker run args with mounted state and passthrough secrets", () => {
    const home = makeTmpDir();
    const repo = path.join(home, "repo");
    const conductor = path.join(home, ".agent-deck", "conductor", "legate-march");
    const loop = path.join(home, ".agent-deck", "conductor", "march-legate-loop");
    const loopScript = path.join(loop, "legate-loop.mjs");
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(conductor, { recursive: true });
    fs.mkdirSync(loop, { recursive: true });

    const args = buildLegateContainerRunArgs({
      conductorName: "legate-march",
      profile: "march",
      repoPath: repo,
      conductorDir: conductor,
      loopConductorDir: loop,
      loopScriptPath: loopScript,
      homeDir: home,
      imageTag: "march-legate:test",
      dockerSocketPath: path.join(home, "missing.sock"),
    });

    expect(args.slice(0, 6)).toEqual([
      "run",
      "-d",
      "--name",
      "march-legate-legate-march",
      "--restart",
      "unless-stopped",
    ]);
    expect(args).toContain("--workdir");
    expect(args).toContain(loop);
    expect(args).toContain(`HOME=${LEGATE_CONTAINER_HOME}`);
    expect(args).toContain("MARCH_LEGATE_CONTAINER=1");
    expect(args).toContain("ANTHROPIC_API_KEY");
    expect(args).toContain("GH_TOKEN");
    expect(args).toContain("GITHUB_TOKEN");
    expect(args.join("\n")).not.toContain("secret-value");
    expect(args).toContain("march-legate:test");
    expect(args).toContain("sh");
    expect(args).toContain("-lc");
    expect(args.at(-1)).toContain("March Legate loop starting");
    expect(args.at(-1)).toContain(`exec node "${loopScript}"`);
  });

  it("builds the image, replaces any existing container, and returns the launched id", () => {
    childProcessMock.execFileSync
      .mockReturnValueOnce(Buffer.from(""))
      .mockReturnValueOnce(Buffer.from("removed\n"))
      .mockReturnValueOnce(Buffer.from("container-id-123\n"));
    const home = makeTmpDir();
    const repo = path.join(home, "repo");
    const conductor = path.join(home, "conductor");
    fs.mkdirSync(repo);
    fs.mkdirSync(conductor);

    const result = ensureLegateContainer({
      conductorName: "legate-march",
      profile: "march",
      repoPath: repo,
      conductorDir: conductor,
      homeDir: home,
      imageTag: "march-legate:test",
      dockerSocketPath: path.join(home, "missing.sock"),
    });

    expect(result).toMatchObject({
      imageTag: "march-legate:test",
      containerName: "march-legate-legate-march",
      containerId: "container-id-123",
      replaced: true,
    });
    expect(childProcessMock.execFileSync).toHaveBeenCalledTimes(3);
    expect(childProcessMock.execFileSync.mock.calls[0][1]).toEqual(
      expect.arrayContaining(["build", "-t", "march-legate:test"]),
    );
    expect(childProcessMock.execFileSync.mock.calls[1]).toEqual([
      "docker",
      ["rm", "-f", "march-legate-legate-march"],
      expect.any(Object),
    ]);
    expect(childProcessMock.execFileSync.mock.calls[2][1]).toContain(
      "march-legate:test",
    );
  });

  it("throws HatcheryError with docker stderr on build failure", () => {
    childProcessMock.execFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("build failed"), {
        stderr: Buffer.from("simulated build failure\n"),
      });
    });
    const home = makeTmpDir();
    const repo = path.join(home, "repo");
    const conductor = path.join(home, "conductor");
    fs.mkdirSync(repo);
    fs.mkdirSync(conductor);

    let thrown: unknown;
    try {
      ensureLegateContainer({
        conductorName: "legate-march",
        profile: "march",
        repoPath: repo,
        conductorDir: conductor,
        homeDir: home,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(HatcheryError);
    expect((thrown as Error).message).toMatch(
      /simulated build failure|docker build failed/,
    );
  });

  it("exports a versioned default local image tag", () => {
    expect(LEGATE_IMAGE_TAG).toMatch(/^march-legate:\d+\.\d+\.\d+$/);
  });
});
