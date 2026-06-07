import type { FastifyInstance } from "fastify";
import { getBackend, listBackends } from "../../spawn/backends.js";
import { isToolchainSelection, TOOLCHAIN_SELECTIONS } from "../../spawn/toolchain.js";
import { isFinderAvailable, isOnPath } from "../../shared/deps.js";
import { createCastraClientFromEnv } from "../../castra/client.js";
import {
  outcomeFromStatus,
  recordHatcheryRequest,
} from "../../observability/hatchery-metrics.js";
import type { JobStore } from "./jobs.js";
import type { SpawnRequest } from "./types.js";

export interface RoutesOptions {
  readonly store: JobStore;
}

export type SpawnRequestValidation =
  | { readonly ok: true; readonly request: SpawnRequest }
  | { readonly ok: false; readonly error: string };

/** Validate and normalize a POST /spawns body. Mirrors the old CLI prechecks. */
export function validateSpawnRequest(
  body: Partial<SpawnRequest>,
): SpawnRequestValidation {
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt.trim()) return { ok: false, error: "prompt is required." };

  const backend = typeof body.backend === "string" ? body.backend.trim() : "";
  if (!backend) return { ok: false, error: "backend is required." };
  if (!getBackend(backend)) {
    return {
      ok: false,
      error: `Unknown backend "${backend}". Supported backends: ${listBackends().join(", ")}`,
    };
  }

  const repoPath = typeof body.repoPath === "string" ? body.repoPath.trim() : "";
  if (!repoPath) return { ok: false, error: "repoPath is required." };

  // Validate the toolchain at the HTTP boundary against the same allow-list the
  // CLI/profile route use. Untrusted input reaches resolveToolchain() server-
  // side, where a non-string would throw on `override?.trim()`; a typo string
  // would silently run the wrong (auto-detected) image. Reject both up front.
  let toolchain: string | undefined;
  if (body.toolchain !== undefined && body.toolchain !== null) {
    if (typeof body.toolchain !== "string" || !isToolchainSelection(body.toolchain)) {
      return {
        ok: false,
        error: `invalid toolchain "${String(body.toolchain)}": expected one of ${TOOLCHAIN_SELECTIONS.join(", ")}.`,
      };
    }
    toolchain = body.toolchain;
  }

  return {
    ok: true,
    request: {
      prompt,
      backend,
      repoPath,
      agentDeckProfile: body.agentDeckProfile,
      managerGroup: body.managerGroup,
      title: body.title,
      branch: body.branch,
      profile: body.profile,
      taskType: body.taskType,
      taskName: body.taskName,
      sliceId: body.sliceId,
      toolchain,
    },
  };
}

export async function registerRoutes(
  app: FastifyInstance,
  opts: RoutesOptions,
): Promise<void> {
  const { store } = opts;

  // Record every request keyed by route TEMPLATE (not the concrete path) to
  // keep metric cardinality bounded — the same rule spawn-metrics applies to
  // spawn ids.
  app.addHook("onResponse", async (request, reply) => {
    recordHatcheryRequest({
      route: request.routeOptions.url ?? "unknown",
      method: request.method,
      outcome: outcomeFromStatus(reply.statusCode),
      durationSeconds: reply.elapsedTime / 1000,
    });
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    // docker is still driven locally (sibling spawn containers on the host
    // socket); interactive sessions now go through Castra over HTTP, so its
    // reachability — not a local agent-deck binary — gates readiness.
    const docker = isFinderAvailable() && isOnPath("docker");
    const castra = await createCastraClientFromEnv().reachable();
    const ready = docker && castra;
    reply.code(ready ? 200 : 503);
    return { ready, docker, castra };
  });

  app.post("/spawns", async (request, reply) => {
    const validation = validateSpawnRequest(
      (request.body ?? {}) as Partial<SpawnRequest>,
    );
    if (!validation.ok) {
      reply.code(400);
      return { error: validation.error };
    }
    const record = store.create(validation.request);
    reply.code(202);
    return { id: record.id, status: record.status };
  });

  app.get("/spawns/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = store.get(id);
    if (!record) {
      reply.code(404);
      return { error: `No spawn job with id "${id}".` };
    }
    return record;
  });
}
