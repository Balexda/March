/**
 * @l1 @deterministic @ci
 *
 * Runs the real git-scaffolded spawn entrypoint under `sh` with a fake agent on
 * PATH, to prove that Brood's graceful stop (`docker kill --signal SIGTERM` on
 * the container's main process, which is this `sh`) reaches the agent, both
 * bare and inside the telemetry wrapper.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { wrapEntrypointWithEmitter } from "../observability/in-spawn-emitter.js";
import { claudeCodeBackend, CONTAINER_WORKDIR, PATCH_SENTINEL } from "./backends.js";

const hasSetsid = spawnSync("sh", ["-c", "command -v setsid"]).status === 0;
interface Started {
  readonly root: string;
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}
const started: Started[] = [];

// A regression could leave the wrapper and the agent's separate process group
// running, so kill both and wait for the wrapper before removing the files.
afterEach(async () => {
  for (const { root, child, exited } of started.splice(0)) {
    for (const name of ["agent.pid", "grandchild.pid"]) {
      const pid = readPid(path.join(root, name));
      if (pid === undefined) continue;
      const pgid = Number(spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim());
      if (Number.isInteger(pgid) && pgid > 1 && pgid !== process.pid) signal(-pgid);
      signal(pid);
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function signal(target: number): void {
  try {
    process.kill(target, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function readPid(file: string): number | undefined {
  try {
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 1 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function setup(agentScript: string, options: { readonly telemetry?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "march-spawn-signal-"));
  const workspace = path.join(root, "workspace");
  const bin = path.join(root, "bin");
  fs.mkdirSync(workspace);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(workspace, "README.md"), "base\n");
  fs.writeFileSync(path.join(root, "prompt.txt"), "do the thing\n");
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\n${agentScript}\n`, { mode: 0o755 });
  const [, , script] = claudeCodeBackend.buildEntrypoint(path.join(root, "prompt.txt"));
  const scaffold = ["sh", "-c", script.replace(`cd ${CONTAINER_WORKDIR}`, `cd '${workspace}'`)];
  const [shell, flag, command] = options.telemetry ? wrapEntrypointWithEmitter(scaffold) : scaffold;
  const child = spawn(shell, [flag, command], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      MARCH_TEST_ROOT: root,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", () => {});
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  started.push({ root, child, exited });
  return { root, child, exited, stdout: () => stdout };
}

// Pid files are published by rename, so a present file holds a complete pid.
async function waitForPid(file: string, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const pid = Number(fs.readFileSync(file, "utf8").trim());
      if (Number.isInteger(pid) && pid > 1) return pid;
      throw new Error(`invalid pid in ${file}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${file}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// An exited agent orphaned by its wrapper stays visible as a zombie until init
// reaps it, so poll for disappearance instead of sampling once.
async function goneWithin(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

describe.skipIf(!hasSetsid).each([
  { label: "bare", telemetry: false },
  { label: "telemetry-wrapped", telemetry: true },
])("git-scaffolded spawn entrypoint signal handling ($label)", ({ telemetry }) => {
  it("forwards SIGTERM to the agent and exits without emitting a patch", async () => {
    const { root, child, exited, stdout } = setup([
      `trap 'echo agent-got-term; exit 0' TERM`,
      `echo $$ > "$MARCH_TEST_ROOT/agent.tmp" && mv "$MARCH_TEST_ROOT/agent.tmp" "$MARCH_TEST_ROOT/agent.pid"`,
      `while :; do sleep 0.05; done`,
    ].join("\n"), { telemetry });
    const agentPid = await waitForPid(path.join(root, "agent.pid"));

    child.kill("SIGTERM");
    const result = await exited;

    expect(result).toEqual({ code: 143, signal: null });
    expect(stdout()).toContain("agent-got-term");
    expect(stdout()).not.toContain(PATCH_SENTINEL);
    expect(await goneWithin(agentPid)).toBe(true);
  }, 20_000);

  it("stops an agent with default SIGTERM handling and its descendants", async () => {
    const { root, child, exited } = setup([
      `sleep 30 & echo $! > "$MARCH_TEST_ROOT/grandchild.tmp" && mv "$MARCH_TEST_ROOT/grandchild.tmp" "$MARCH_TEST_ROOT/grandchild.pid"`,
      `echo $$ > "$MARCH_TEST_ROOT/agent.tmp" && mv "$MARCH_TEST_ROOT/agent.tmp" "$MARCH_TEST_ROOT/agent.pid"`,
      `wait`,
    ].join("\n"), { telemetry });
    const agentPid = await waitForPid(path.join(root, "agent.pid"));
    const grandchildPid = await waitForPid(path.join(root, "grandchild.pid"));

    child.kill("SIGTERM");
    const result = await exited;

    expect(result.code).not.toBe(0);
    expect(await goneWithin(agentPid)).toBe(true);
    expect(await goneWithin(grandchildPid)).toBe(true);
  }, 20_000);

  it("still emits the patch when the agent finishes normally", async () => {
    const { exited, stdout } = setup([
      `echo change > change.txt`,
      `git add change.txt && git commit -q -m change`,
    ].join("\n"), { telemetry });

    expect(await exited).toEqual({ code: 0, signal: null });
    expect(stdout()).toContain(`${PATCH_SENTINEL}:`);
  }, 20_000);
});
