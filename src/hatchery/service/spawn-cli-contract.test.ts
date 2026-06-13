/**
 * @l1 @deterministic @ci
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildServer } from "./server.js";
import { JobStore } from "./jobs.js";
import type { FastifyInstance } from "fastify";
import type { HatcherySpawnResult } from "../spawn-handoff.js";

const CLI_PATH = resolve(import.meta.dirname, "../../../dist/cli.js");

function runCliAsync(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("node", args, {
      cwd: options.cwd,
      env: options.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error(`CLI timed out. stderr: ${stderr}`));
    }, 20000);
    child.on("error", rejectRun);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });
}

const silentLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  silent: () => {},
  level: "silent",
  child() {
    return this;
  },
} as never;

function fakeResult(): HatcherySpawnResult {
  return {
    spawnId: "spawn-contract",
    backend: "codex",
    branch: "march/spawn/spawn-contract",
    managerSession: {
      sessionId: "sess",
      title: "t",
      group: "g",
      branch: "march/spawn/spawn-contract",
      worktreePath: "/repo/wt",
    },
    artifacts: {
      dir: "/l",
      spawnOutputPath: "/l/o",
      patchPath: "/l/p",
      managerPromptPath: "/l/m",
      metadataPath: "/l/j",
    },
    exitCode: 0,
    summary: "handed off",
  };
}

describe("march hatchery spawn stdout contract", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let repoDir: string;

  beforeEach(async () => {
    const store = new JobStore({ executor: async () => fakeResult() });
    const built = await buildServer({ store, logger: silentLogger });
    app = built.app;
    baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });

    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "march-spawn-contract-"));
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
  });

  afterEach(async () => {
    await app?.close();
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("prints ONLY the result JSON to stdout (legate JSON.parses it)", async () => {
    // Must use async spawn (not spawnSync): the test server runs in THIS event
    // loop, so blocking it would deadlock the subprocess's HTTP polling.
    const res = await runCliAsync(
      [CLI_PATH, "hatchery", "spawn", "--prompt", "do it", "--backend", "codex", "--json"],
      { cwd: repoDir, env: { ...process.env, MARCH_HATCHERY_URL: baseUrl, MARCH_OTEL: "0" } },
    );

    expect(res.code).toBe(0);
    // stdout must be exactly one JSON document equal to the spawn result.
    const parsed = JSON.parse(res.stdout) as HatcherySpawnResult;
    expect(parsed).toEqual(fakeResult());
  });
});
