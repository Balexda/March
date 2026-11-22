/**
 * @l2 @deterministic @ci
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { listSpawnRecords, loadSpawnRecord } from "../brood/spawn-index.js";
import { spawnOutputPath, spawnRecordDir, spawnRecordPath } from "../brood/spawn-record.js";

const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const dockerAvailable = (() => {
  try {
    execFileSync("docker", ["info", "--format", "{{.OSType}}"], {
      timeout: 5_000,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
})();

it.skipIf(!process.env.CI && !dockerAvailable)(
  "keeps two overlapping CLI dispatches independently attributable",
  async () => {
    expect(dockerAvailable, "The concurrent dispatch fixture requires a running Docker daemon").toBe(true);
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "march-concurrent-")));
    const daemon = path.basename(root).toLowerCase();
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    const tmp = path.join(root, "tmp");
    const base = path.join(root, "base");
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: tmp,
      DOCKER_HOST: `unix://${root}/docker.sock`,
      ANTHROPIC_API_KEY: "cassette-unused",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const run = (command: string, args: string[], options: { env: NodeJS.ProcessEnv } = { env }, timeout = 10_000) =>
      execFileSync(command, args, { ...options, timeout, killSignal: "SIGKILL", encoding: "utf8", stdio: "pipe" }).trim();
    const docker = (...args: string[]) => run("docker", args);
    const git = (...args: string[]) => run("git", ["-C", repo, ...args]);
    const outer = (args: string[], timeout?: number) => run("docker", args, { env: process.env }, timeout);
    const workers: ReturnType<typeof execFile>[] = [];
    const results: Promise<{ error: Error | null; stdout: string; stderr: string }>[] = [];
    let startingDaemon = false;

    try {
      for (const dir of [repo, home, tmp, base]) fs.mkdirSync(dir);
      git("init", "-q");
      fs.writeFileSync(path.join(repo, "seed.txt"), "shared snapshot\n");
      git("add", "seed.txt");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@march.local", "commit", "-qm", "seed");
      const head = git("rev-parse", "HEAD");

      // Both dispatches use one real daemon. Its disposable namespace also
      // isolates the production CLI's name-based rollback from host artifacts.
      startingDaemon = true;
      outer([
        "run", "--detach", "--rm", "--privileged", "--name", daemon,
        "--label", `march.concurrent-fixture=${daemon}`, "--userns=host",
        "--mount", `type=bind,src=${root},dst=/fixture`,
        // Keep the image's entrypoint: it nests cgroup v2 controllers, without
        // which runc cannot start containers on cgroup v2 hosts.
        "--env", "DOCKER_TLS_CERTDIR=", "docker:28-dind",
        "dockerd", "--host=unix:///fixture/docker.sock", "--storage-driver=vfs",
      ], 90_000);
      await expect.poll(() => {
        try {
          outer(["exec", daemon, "chmod", "666", "/fixture/docker.sock"]);
          return docker("info", "--format", "{{.OSType}}");
        } catch {
          return "";
        }
      }, { timeout: 30_000, interval: 200 }).toBe("linux");

      fs.writeFileSync(path.join(base, "Dockerfile"), [
        "FROM alpine:3.22",
        "RUN apk add --no-cache git && addgroup march && adduser -D -G march march && mkdir -p /march/workspace && chown -R march:march /march",
        "COPY claude /usr/local/bin/claude",
      ].join("\n") + "\n");
      fs.writeFileSync(path.join(base, "claude"), `#!/bin/sh
set -eu
case "$2" in
  dispatch-alpha) response=recorded-alpha ;;
  dispatch-beta) response=recorded-beta ;;
  *) exit 41 ;;
esac
test "$(cat seed.txt)" = "shared snapshot"
for attempt in $(seq 1 300); do
  if [ -f /tmp/release ]; then
    printf '%s\\n' "$response" > response.txt
    printf '{"result":"%s"}\\n' "$response"
    exit 0
  fi
  sleep 0.2
done
exit 42
`, { mode: 0o755 });
      run("docker", ["build", "-t", "march-spawn-claude:latest", base], { env }, 120_000);

      const cases = [
        { prompt: "dispatch-alpha", response: "recorded-alpha" },
        { prompt: "dispatch-beta", response: "recorded-beta" },
      ];
      for (const { prompt } of cases) {
        results.push(new Promise((resolve) => {
          workers.push(execFile(process.execPath, [
            cli, "spawn", "dispatch", "--backend", "claude-code", "--prompt", prompt,
          ], { cwd: repo, env, timeout: 75_000, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
            resolve({ error, stdout, stderr });
          }));
        }));
      }

      await expect.poll(() => listSpawnRecords({ homeDir: home, warn: () => {} })
        .filter(({ status }) => status === "running").length,
      { timeout: 45_000, interval: 150 }).toBe(2);

      const running = listSpawnRecords(home);
      expect(running).toHaveLength(2);
      const containerIds = running.map(({ containerId }) => containerId!);
      const containers = JSON.parse(docker("inspect", ...containerIds)) as {
        Id: string;
        Name: string;
        State: { Running: boolean };
        Config: { Image: string };
        Image: string;
      }[];
      expect(containers.map(({ State }) => State.Running)).toEqual([true, true]);
      expect(workers.every(({ exitCode, signalCode }) => exitCode === null && signalCode === null)).toBe(true);
      for (const id of containerIds) docker("exec", id, "touch", "/tmp/release");

      const exits = await Promise.all(results);
      const records = listSpawnRecords(home);
      expect(records).toHaveLength(2);
      for (const field of ["id", "branch", "worktreePath", "imageId", "containerId"] as const) {
        expect(new Set(records.map((record) => record[field])).size, field).toBe(2);
      }
      expect(new Set(containers.map(({ Name }) => Name)).size).toBe(2);
      expect(fs.readdirSync(spawnRecordDir(home)).filter((entry) => entry.endsWith(".json")).sort())
        .toEqual(records.map(({ id }) => path.basename(spawnRecordPath(id, home))).sort());

      for (const [index, { prompt, response }] of cases.entries()) {
        const { error, stdout, stderr } = exits[index]!;
        expect(error, stderr).toBeNull();
        const record = records.find((entry) => entry.prompt === prompt)!;
        expect(record).toBeDefined();
        expect(loadSpawnRecord(record.id, home)).toEqual(record);
        const beforeRelease = running.find(({ id }) => id === record.id)!;
        expect(record).toMatchObject({
          ...beforeRelease, repoPath: repo, backend: "claude-code", status: "stopped", exitCode: 0,
        });
        expect(git("rev-parse", record.branch)).toBe(head);
        expect(git("-C", record.worktreePath, "branch", "--show-current")).toBe(record.branch);
        expect(record.imageId).toBe(`march-spawn-${record.id}`);
        const container = containers.find(({ Id }) => Id === record.containerId)!;
        expect(container).toMatchObject({
          Name: `/${record.imageId}`, Config: { Image: record.imageId },
          Image: docker("image", "inspect", "--format", "{{.Id}}", record.imageId!),
        });

        const output = fs.readFileSync(spawnOutputPath(record.id, home), "utf8");
        expect(output).toContain(`{"result":"${response}"}\n`);
        expect(output).not.toContain(cases[1 - index]!.response);
        expect(stdout.trimEnd()).toBe(output.trimEnd());
      }
      expect(fs.readdirSync(tmp)).toEqual([]);
    } finally {
      for (const worker of workers) worker.kill("SIGKILL");
      await Promise.all(results);
      try {
        if (startingDaemon) {
          const owned = outer(["ps", "-aq", "--filter", `label=march.concurrent-fixture=${daemon}`]);
          if (owned) outer(["rm", "-f", "-v", ...owned.split("\n")], 30_000);
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  },
  360_000,
);
