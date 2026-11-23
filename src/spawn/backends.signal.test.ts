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
import { IN_SPAWN_EMITTER_PATH, wrapEntrypointWithEmitter } from "../observability/in-spawn-emitter.js";
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
  for (const run of started.splice(0)) {
    await reap(run);
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

/**
 * Kill every process of one run, found by its unique `MARCH_TEST_ROOT` in
 * `/proc/<pid>/environ` (inherited across `setsid`), so cleanup does not
 * depend on the agent publishing its pid. Published pid files are a fallback
 * where `/proc` is unavailable.
 */
async function reap({ root, child, exited }: Started): Promise<void> {
  const pids = new Set(runPids(root));
  for (const name of ["agent.pid", "grandchild.pid"]) {
    const pid = readPid(path.join(root, name));
    if (pid !== undefined) pids.add(pid);
  }
  for (const pid of pids) {
    const pgid = Number(spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim());
    if (Number.isInteger(pgid) && pgid > 1 && pgid !== process.pid && pgid !== processGroup()) signal(-pgid);
    signal(pid);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exited;
}

function runPids(root: string): number[] {
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return [];
  }
  const marker = `\0MARCH_TEST_ROOT=${root}\0`;
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (`\0${fs.readFileSync(`/proc/${entry}/environ`, "latin1")}`.includes(marker)) pids.push(Number(entry));
    } catch {
      // Exited or not readable.
    }
  }
  return pids;
}

function processGroup(): number {
  return Number(spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).stdout.trim());
}

function signal(target: number): void {
  try {
    process.kill(target, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function emittedStatus(root: string): string | undefined {
  try {
    return fs.readFileSync(path.join(root, "emitted-rc"), "utf8");
  } catch {
    return undefined;
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
  const [shell, flag, wrapped] = options.telemetry ? wrapEntrypointWithEmitter(scaffold) : scaffold;
  // Record the status the wrapper hands to the span emitter instead of running it.
  const command = wrapped.replace(
    `node ${IN_SPAWN_EMITTER_PATH}`,
    `sh -c 'printf %s "$2" > "$MARCH_TEST_ROOT/emitted-rc"' emit`,
  );
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
  const run: Started = { root, child, exited };
  started.push(run);
  return { root, child, exited, run, stdout: () => stdout };
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

async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 20));
  }
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
    expect(emittedStatus(root)).toBe(telemetry ? "143" : undefined);
  }, 20_000);

  it("keeps the agent's own exit status after a stop", async () => {
    const { root, child, exited } = setup([
      `trap 'exit 42' TERM`,
      `echo $$ > "$MARCH_TEST_ROOT/agent.tmp" && mv "$MARCH_TEST_ROOT/agent.tmp" "$MARCH_TEST_ROOT/agent.pid"`,
      `while :; do sleep 0.05; done`,
    ].join("\n"), { telemetry });
    await waitForPid(path.join(root, "agent.pid"));

    child.kill("SIGTERM");

    expect(await exited).toEqual({ code: 42, signal: null });
    expect(emittedStatus(root)).toBe(telemetry ? "42" : undefined);
  }, 20_000);

  it("waits through a second stop while the agent finishes shutting down", async () => {
    const { root, child, exited } = setup([
      `trap 'stopping=1' TERM`,
      `echo $$ > "$MARCH_TEST_ROOT/agent.tmp" && mv "$MARCH_TEST_ROOT/agent.tmp" "$MARCH_TEST_ROOT/agent.pid"`,
      `while [ -z "$stopping" ]; do sleep 0.05; done`,
      `echo stopping > "$MARCH_TEST_ROOT/stopping.tmp" && mv "$MARCH_TEST_ROOT/stopping.tmp" "$MARCH_TEST_ROOT/agent.stopping"`,
      `i=0; while [ "$i" -lt 10 ]; do sleep 0.05; i=$((i + 1)); done`,
      `echo done > "$MARCH_TEST_ROOT/agent.done"`,
      `exit 42`,
    ].join("\n"), { telemetry });
    await waitForPid(path.join(root, "agent.pid"));

    child.kill("SIGTERM");
    await waitForFile(path.join(root, "agent.stopping"));
    child.kill("SIGTERM");

    expect(await exited).toEqual({ code: 42, signal: null });
    expect(fs.existsSync(path.join(root, "agent.done"))).toBe(true);
    expect(emittedStatus(root)).toBe(telemetry ? "42" : undefined);
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
    const { root, exited, stdout } = setup([
      `echo change > change.txt`,
      `git add change.txt && git commit -q -m change`,
    ].join("\n"), { telemetry });

    expect(await exited).toEqual({ code: 0, signal: null });
    expect(stdout()).toContain(`${PATCH_SENTINEL}:`);
    expect(emittedStatus(root)).toBe(telemetry ? "0" : undefined);
  }, 20_000);
});

describe.skipIf(!hasSetsid || !fs.existsSync("/proc/self/environ"))("signal test cleanup", () => {
  it("reaps an agent that never publishes its pid", async () => {
    const { root, run } = setup([
      `echo started > "$MARCH_TEST_ROOT/agent.started"`,
      `while :; do sleep 0.05; done`,
    ].join("\n"));
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(path.join(root, "agent.started"))) {
      if (Date.now() >= deadline) throw new Error("agent did not start");
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(readPid(path.join(root, "agent.pid"))).toBeUndefined();
    const before = runPids(root);
    expect(before.length).toBeGreaterThan(1);

    await reap(run);

    for (const pid of before) expect(await goneWithin(pid)).toBe(true);
    expect(runPids(root)).toEqual([]);
  }, 20_000);
});
