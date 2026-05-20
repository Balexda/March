#!/usr/bin/env node
import { isMainThread, workerData } from "node:worker_threads";

if (isMainThread) {
  const { runCli } = await import("./cli/program.js");
  await runCli();
} else {
  // Launched as a hatchery spawn worker (see src/hatchery/service/spawn-runner.ts).
  // The worker re-loads this same bundle; branch here so it performs the spawn
  // work instead of re-running the CLI.
  const { runSpawnWorkerBody } = await import(
    "./hatchery/service/spawn-runner.js"
  );
  await runSpawnWorkerBody(workerData);
}
