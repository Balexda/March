import type { FastifyInstance } from "fastify";
import { getBackend, listBackends } from "../../spawn/backends.js";
import { isToolchainSelection, TOOLCHAIN_SELECTIONS } from "../../spawn/toolchain.js";
import { isFinderAvailable, isOnPath } from "../../shared/deps.js";
import { createCastraClientFromEnv } from "../../castra/client.js";
import {
  outcomeFromStatus,
  recordHatcheryRequest,
  registerHatcheryReadinessSource,
} from "../../observability/hatchery-metrics.js";
import { deriveReadiness, GitHubCredentialChecker, type GitHubCredentialCheck } from "./readiness.js";
import type { JobStore } from "./jobs.js";
import type { SpawnRequest } from "./types.js";

/** Injectable readiness probes (tests); defaults are the real local checks. */
export interface ReadinessProbes {
  readonly docker?: () => boolean;
  readonly castra?: () => Promise<boolean>;
  /** GitHub-credential check (defaults to a {@link GitHubCredentialChecker} over process.env). */
  readonly github?: () => Promise<GitHubCredentialCheck>;
  /** Env + fetch the default checker uses (tests). */
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
}

export interface RoutesOptions {
  readonly store: JobStore;
  readonly readiness?: ReadinessProbes;
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
  if (body.baseBranch !== undefined && (typeof body.baseBranch !== "string" || !body.baseBranch.trim())) {
    return { ok: false, error: "baseBranch must be a non-empty branch name." };
  }

  if (body.attemptId !== undefined || body.stewardDeadline !== undefined) {
    if (typeof body.attemptId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.attemptId) ||
        typeof body.stewardDeadline !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(body.stewardDeadline) ||
        !Number.isFinite(Date.parse(body.stewardDeadline))) {
      return { ok: false, error: "attemptId and an ISO UTC stewardDeadline are required together." };
    }
  }

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
      baseBranch: body.baseBranch,
      profile: body.profile,
      taskType: body.taskType,
      taskName: body.taskName,
      sliceId: body.sliceId,
      ...(body.attemptId && { attemptId: body.attemptId, stewardDeadline: body.stewardDeadline }),
      toolchain,
    },
  };
}

export async function registerRoutes(
  app: FastifyInstance,
  opts: RoutesOptions,
): Promise<void> {
  const { store } = opts;
  // docker is still driven locally (sibling spawn containers on the host
  // socket); interactive sessions now go through Castra over HTTP, so its
  // reachability — not a local agent-deck binary — gates readiness.
  const probeDocker = opts.readiness?.docker ?? (() => isFinderAvailable() && isOnPath("docker"));
  const probeCastra = opts.readiness?.castra ?? (() => createCastraClientFromEnv().reachable());
  const checker = new GitHubCredentialChecker({ env: opts.readiness?.env, fetchImpl: opts.readiness?.fetchImpl });
  const probeGithub = opts.readiness?.github ?? (() => checker.check());
  // Last observed check results, for the readiness gauges (the legate polls
  // /readyz every tick, so these stay fresh). The spawn window is read live.
  let lastDocker: boolean | undefined;
  let lastCastra: boolean | undefined;
  let lastGithub: boolean | undefined;
  registerHatcheryReadinessSource(() => ({
    checks: { docker: lastDocker, castra: lastCastra, github: lastGithub },
    consecutiveFailures: store.spawnWindow.consecutiveFailures,
  }));

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

  // Pure liveness: the docker healthcheck uses it, so it must never depend on a
  // downstream (a credential outage must not restart-loop the container).
  app.get("/healthz", async () => ({ status: "ok" }));

  // Readiness: can Hatchery actually spawn? 200 unless `state` is "down".
  app.get("/readyz", async (_request, reply) => {
    const docker = probeDocker();
    // Castra and Tessera are independent network probes — run them together.
    const [castra, github] = await Promise.all([
      probeCastra().catch(() => false),
      probeGithub().catch((): GitHubCredentialCheck => ({ ok: false, source: "tessera", reason: "tessera:unreachable" })),
    ]);
    lastDocker = docker;
    lastCastra = castra;
    lastGithub = github.ok;
    const body = deriveReadiness({
      docker,
      castra,
      github,
      spawns: store.spawnWindow.snapshot(),
    });
    reply.code(body.state === "down" ? 503 : 200);
    return body;
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
