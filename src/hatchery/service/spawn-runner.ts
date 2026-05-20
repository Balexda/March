import { Worker, parentPort } from "node:worker_threads";
import { getBackend } from "../../spawn/backends.js";
import { initOtel } from "../../observability/otel.js";
import { runHatcherySpawn, type HatcherySpawnResult } from "../spawn-handoff.js";
import type {
  SpawnRequest,
  SpawnWorkerData,
  SpawnWorkerMessage,
} from "./types.js";

/**
 * Resolve the path the worker should load: the CLI entry (`dist/cli.js`), which
 * branches on `isMainThread` and calls {@link runSpawnWorkerBody}. We target the
 * entry — not `import.meta.url` — because the build splits into chunks (dynamic
 * imports), so this module's own URL may be a chunk without the worker branch.
 * `process.argv[1]` on the main thread is the entry script. Overridable via
 * `MARCH_HATCHERY_WORKER_ENTRY` for non-standard launches.
 */
export function workerEntryPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MARCH_HATCHERY_WORKER_ENTRY?.trim();
  if (override) return override;
  const entry = process.argv[1];
  if (!entry) {
    throw new Error(
      "Cannot locate the CLI entry to launch a spawn worker (process.argv[1] is empty).",
    );
  }
  return entry;
}

/**
 * Run a spawn in a worker thread so the fully-synchronous `runHatcherySpawn`
 * (execFileSync for agent-deck/docker/git) never blocks the service event loop.
 * Used only in the built bundle; unit tests inject a fake executor and never
 * launch a real worker.
 */
export function runSpawnInWorker(
  request: SpawnRequest,
): Promise<HatcherySpawnResult> {
  return new Promise((resolve, reject) => {
    const workerData: SpawnWorkerData = { request };
    let worker: Worker;
    try {
      worker = new Worker(workerEntryPath(), { workerData });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    worker.once("message", (message: SpawnWorkerMessage) => {
      settle(() => {
        if (message.ok) resolve(message.result);
        else reject(new Error(message.error));
      });
    });
    worker.once("error", (err) => settle(() => reject(err)));
    worker.once("exit", (code) => {
      settle(() =>
        reject(
          new Error(
            `spawn worker exited with code ${code} before reporting a result`,
          ),
        ),
      );
    });
  });
}

/**
 * Worker-thread entry: execute one spawn and post the result/error back to the
 * service. Initializes its own OTel (providers don't cross thread boundaries)
 * and flushes before the worker exits so spans/metrics/logs are not dropped.
 */
export async function runSpawnWorkerBody(data: SpawnWorkerData): Promise<void> {
  const otel = initOtel();
  let message: SpawnWorkerMessage;
  try {
    const { request } = data;
    const backend = getBackend(request.backend);
    if (!backend) {
      throw new Error(`Unknown backend "${request.backend}".`);
    }
    const result = runHatcherySpawn({
      repoPath: request.repoPath,
      prompt: request.prompt,
      backend,
      agentDeckProfile: request.agentDeckProfile,
      profile: request.profile,
      managerGroup: request.managerGroup,
      title: request.title,
      branch: request.branch,
      taskType: request.taskType,
      taskName: request.taskName,
      sliceId: request.sliceId,
    });
    message = { ok: true, result };
  } catch (err) {
    message = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await otel.shutdown();
  }
  parentPort?.postMessage(message);
}
