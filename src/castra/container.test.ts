import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  buildCastraContainerRunArgs,
  castraContainerMounts,
  CastraContainerError,
  ensureCastraContainer,
  ensureMarchNetwork,
  renderCastraDockerfile,
} from "./container.js";
import { CASTRA_CONTAINER_HOME, CASTRA_IMAGE_TAG } from "./config.js";
import { BASE_IMAGE } from "../hatchery/spawn-config.js";

describe("castra container", () => {
  const tmpDirs: string[] = [];
  function makeTmpDir(prefix = "march-castra-container-test-"): string {
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

  it("renders a toolbox Dockerfile on top of the March base image", () => {
    const body = renderCastraDockerfile();
    expect(body).toContain(`FROM ${BASE_IMAGE}`);
    for (const pkg of ["bash", "git", "jq", "tmux", "python3"]) {
      expect(body).toContain(pkg);
    }
    expect(body).toContain(`mkdir -p ${CASTRA_CONTAINER_HOME}`);
  });

  it("mounts the install dir, agent-deck state, docker socket, and repos at identical paths", () => {
    const home = makeTmpDir();
    const install = path.join(home, "march-install");
    const repo = path.join(home, "repo");
    const socket = path.join(home, "docker.sock");
    fs.mkdirSync(install, { recursive: true });
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(path.join(home, ".agent-deck"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(socket, "");

    const mounts = castraContainerMounts({
      marchInstallDir: install,
      homeDir: home,
      repoPaths: [repo],
      dockerSocketPath: socket,
    });

    expect(mounts).toEqual(
      expect.arrayContaining([
        { source: install, target: install, required: true },
        {
          source: path.join(home, ".agent-deck"),
          target: path.join(CASTRA_CONTAINER_HOME, ".agent-deck"),
          required: false,
        },
        { source: socket, target: "/var/run/docker.sock", required: false },
        { source: repo, target: repo, required: false },
      ]),
    );
  });

  it("builds docker run args with the march network, published loopback port, and passthrough env", () => {
    const home = makeTmpDir();
    const install = path.join(home, "march-install");
    fs.mkdirSync(install, { recursive: true });

    const args = buildCastraContainerRunArgs({
      marchInstallDir: install,
      homeDir: home,
      port: 8888,
      imageTag: "march-castra:test",
      dockerSocketPath: path.join(home, "missing.sock"),
    });

    expect(args.slice(0, 6)).toEqual([
      "run",
      "-d",
      "--name",
      "march-castra",
      "--restart",
      "unless-stopped",
    ]);
    expect(args).toContain("--network");
    expect(args).toContain("march");
    expect(args).toContain("--publish");
    expect(args).toContain("127.0.0.1:8888:8888");
    expect(args).toContain(`HOME=${CASTRA_CONTAINER_HOME}`);
    expect(args).toContain("MARCH_CASTRA_CONTAINER=1");
    expect(args).toContain("CASTRA_PORT=8888");
    expect(args).toContain("MARCH_OTEL_SERVICE_NAME=march-castra");
    expect(args).toContain("CASTRA_API_TOKEN");
    expect(args).toContain("ANTHROPIC_API_KEY");
    expect(args).toContain("march-castra:test");
    expect(args.at(-1)).toContain("castra serve --port 8888 --host 0.0.0.0");
    expect(args.at(-1)).toContain(path.join(install, "dist", "cli.js"));
  });

  it("ensures the march network, builds, replaces, and returns the launched id + port", () => {
    childProcessMock.execFileSync
      .mockReturnValueOnce(Buffer.from("")) // network inspect → exists
      .mockReturnValueOnce(Buffer.from("")) // build
      .mockReturnValueOnce(Buffer.from("removed\n")) // rm -f
      .mockReturnValueOnce(Buffer.from("castra-id-1\n")); // run
    const home = makeTmpDir();
    const install = path.join(home, "march-install");
    fs.mkdirSync(install, { recursive: true });

    const result = ensureCastraContainer({
      marchInstallDir: install,
      homeDir: home,
      port: 8888,
      imageTag: "march-castra:test",
      dockerSocketPath: path.join(home, "missing.sock"),
    });

    expect(result).toMatchObject({
      imageTag: "march-castra:test",
      containerName: "march-castra",
      containerId: "castra-id-1",
      port: 8888,
      replaced: true,
    });
    expect(childProcessMock.execFileSync).toHaveBeenCalledTimes(4);
    expect(childProcessMock.execFileSync.mock.calls[0][1]).toEqual([
      "network",
      "inspect",
      "march",
    ]);
  });

  it("creates the march network when it is missing", () => {
    childProcessMock.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "network" && args[1] === "inspect") {
        throw new Error("no such network");
      }
      return Buffer.from("");
    });

    ensureMarchNetwork();

    expect(childProcessMock.execFileSync).toHaveBeenCalledWith(
      "docker",
      ["network", "inspect", "march"],
      expect.any(Object),
    );
    expect(childProcessMock.execFileSync).toHaveBeenCalledWith(
      "docker",
      ["network", "create", "march"],
      expect.any(Object),
    );
  });

  it("throws CastraContainerError with docker stderr on build failure", () => {
    childProcessMock.execFileSync
      .mockReturnValueOnce(Buffer.from("")) // network inspect → exists
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("build failed"), {
          stderr: Buffer.from("simulated build failure\n"),
        });
      });
    const home = makeTmpDir();
    const install = path.join(home, "march-install");
    fs.mkdirSync(install, { recursive: true });

    expect(() =>
      ensureCastraContainer({ marchInstallDir: install, homeDir: home }),
    ).toThrow(CastraContainerError);
  });

  it("exports a versioned default image tag", () => {
    expect(CASTRA_IMAGE_TAG).toMatch(/^march-castra:\d+\.\d+\.\d+$/);
  });
});
