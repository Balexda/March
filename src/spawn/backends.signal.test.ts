/**
 * @l1 @deterministic @ci
 *
 * Runs the real git-scaffolded spawn entrypoint under `sh` with a fake agent on
 * PATH, to prove that Brood's graceful stop (`docker kill --signal SIGTERM` on
 * the container's main process, which is this `sh`) reaches the agent.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeBackend, CONTAINER_WORKDIR, PATCH_SENTINEL } from "./backends.js";

const hasSetsid = spawnSync("sh", ["-c", "command -v setsid"]).status === 0;
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(agentScript: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "march-spawn-signal-"));
  tmpDirs.push(root);
  const workspace = path.join(root, "workspace");
  const bin = path.join(root, "bin");
  fs.mkdirSync(workspace);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(workspace, "README.md"), "base\n");
  fs.writeFileSync(path.join(root, "prompt.txt"), "do the thing\n");
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\n${agentScript}\n`, { mode: 0o755 });
  const [shell, flag, script] = claudeCodeBackend.buildEntrypoint(path.join(root, "prompt.txt"));
  const child = spawn(shell, [flag, script.replace(`cd ${CONTAINER_WORKDIR}`, `cd '${workspace}'`)], {
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
  return { root, child, exited, stdout: () => stdout };
}

async function waitForFile(file: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
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

describe.skipIf(!hasSetsid)("git-scaffolded spawn entrypoint signal handling", () => {
  it("forwards SIGTERM to the agent and exits without emitting a patch", async () => {
    const { root, child, exited, stdout } = setup([
      `trap 'echo agent-got-term; exit 0' TERM`,
      `echo $$ > "$MARCH_TEST_ROOT/agent.pid"`,
      `while :; do sleep 0.05; done`,
    ].join("\n"));
    const agentPid = Number(await waitForFile(path.join(root, "agent.pid")));

    child.kill("SIGTERM");
    const result = await exited;

    expect(result).toEqual({ code: 143, signal: null });
    expect(stdout()).toContain("agent-got-term");
    expect(stdout()).not.toContain(PATCH_SENTINEL);
    expect(alive(agentPid)).toBe(false);
  }, 20_000);

  it("stops an agent with default SIGTERM handling and its descendants", async () => {
    const { root, child, exited } = setup([
      `sleep 30 & echo $! > "$MARCH_TEST_ROOT/grandchild.pid"`,
      `echo $$ > "$MARCH_TEST_ROOT/agent.pid"`,
      `wait`,
    ].join("\n"));
    const agentPid = Number(await waitForFile(path.join(root, "agent.pid")));
    const grandchildPid = Number(await waitForFile(path.join(root, "grandchild.pid")));

    child.kill("SIGTERM");
    const result = await exited;

    expect(result.code).not.toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(agentPid)).toBe(false);
    expect(alive(grandchildPid)).toBe(false);
  }, 20_000);

  it("still emits the patch when the agent finishes normally", async () => {
    const { exited, stdout } = setup([
      `echo change > change.txt`,
      `git add change.txt && git commit -q -m change`,
    ].join("\n"));

    expect(await exited).toEqual({ code: 0, signal: null });
    expect(stdout()).toContain(`${PATCH_SENTINEL}:`);
  }, 20_000);
});
