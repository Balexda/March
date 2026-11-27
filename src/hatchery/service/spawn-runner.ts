import { IntegrationOutcomeError, workerIntegrationError } from "../integration-outcome.js";
import { IntegrationPublicationError } from "../integration-publisher.js";
import { Worker, parentPort } from "node:worker_threads";
import { getBackend } from "../../spawn/backends.js";
import { initOtel } from "../../observability/otel.js";
import { startDispatchSpan } from "../../observability/spawn-trace.js";
import { runHatcherySpawn, StewardApplyError, type HatcherySpawnResult } from "../spawn-handoff.js";
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
 * Run a spawn in a worker thread so `runHatcherySpawn` never blocks the service
 * event loop. It drives interactive sessions through Castra over HTTP, but still
 * shells out to docker and git via blocking `execFileSync` — the worker isolates
 * those long synchronous calls from the Fastify reactor. Used only in the built
 * bundle; unit tests inject a fake executor and never launch a real worker.
 */
export function runSpawnInWorker(
  request: SpawnRequest,
): Promise<HatcherySpawnResult> {
  return new Promise((resolve, reject) => {
    const workerData: SpawnWorkerData = { request };
    const fail = (error: unknown) => {
      if (!request.attemptId || !request.stewardDeadline) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const failure = workerIntegrationError(request.stewardDeadline);
      const dispatch = startDispatchSpan({
        traceKey: request.sliceId?.trim() || request.attemptId,
        rootName: "hatchery.spawn.worker_failure",
        attributes: { "march.failure_reason": failure.outcome.failureReason },
      });
      dispatch.recordException(failure);
      dispatch.end({ error: true });
      reject(failure);
    };
    let worker: Worker;
    try {
      worker = new Worker(workerEntryPath(), { workerData });
    } catch (err) {
      fail(err);
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
        else if (message.integrationOutcome) reject(new IntegrationOutcomeError(message.integrationOutcome, message.agentFailureReason));
        else if (request.stewardDeadline) fail(new Error(message.error));
        else if (message.application) reject(new StewardApplyError(message.application, false));
        else if (message.publication) reject(new IntegrationPublicationError(message.publication));
        else reject(new Error(message.error));
      });
    });
    worker.once("error", (err) => settle(() => fail(err)));
    worker.once("exit", (code) => {
      settle(() =>
        fail(
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
    const result = await runHatcherySpawn({
      repoPath: request.repoPath,
      prompt: request.prompt,
      backend,
      agentDeckProfile: request.agentDeckProfile,
      profile: request.profile,
      managerGroup: request.managerGroup,
      title: request.title,
      branch: request.branch,
      baseBranch: request.baseBranch,
      taskType: request.taskType,
      taskName: request.taskName,
      sliceId: request.sliceId,
      attemptId: request.attemptId,
      stewardDeadline: request.stewardDeadline,
      toolchain: request.toolchain,
    });
    message = { ok: true, result };
  } catch (err) {
    message = {
      ok: false,
      ...(err instanceof IntegrationOutcomeError ? { integrationOutcome: err.outcome, agentFailureReason: err.agentFailureReason } : {}),
      error: err instanceof Error ? err.message : String(err),
      ...(err instanceof IntegrationPublicationError ? { publication: err.publication } : {}),
      ...(err instanceof StewardApplyError ? { application: err.application } : {}),
    };
  } finally {
    await otel.shutdown();
  }
  parentPort?.postMessage(message);
}
