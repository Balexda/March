import path from "node:path";
import type { FastifyInstance } from "fastify";
import { isFinderAvailable, isOnPath } from "../../shared/deps.js";
import {
  outcomeFromStatus,
  recordBroodRequest,
} from "../../observability/brood-metrics.js";
import { startBroodSpan } from "../../observability/brood-trace.js";
import { createCastraClientFromEnv } from "../../castra/client.js";
import type { SessionRepository } from "./repository.js";
import {
  BroodConflictError,
  BroodNotFoundError,
  teardownSession,
} from "./teardown.js";
import type {
  ListSessionsFilter,
  RegisterSessionInput,
  SessionKind,
  SessionStatus,
  TeardownRequest,
  TeardownResult,
  UpdateSessionInput,
} from "./types.js";

export interface RoutesOptions {
  readonly store: SessionRepository;
  /** Override teardown (tests). Defaults to the real ordered teardown. */
  readonly teardown?: (
    id: string,
    request: TeardownRequest,
    traceparent?: string,
  ) => Promise<TeardownResult>;
}

const SESSION_KINDS: readonly SessionKind[] = ["spawn", "steward", "legate"];
const SESSION_STATUSES: readonly SessionStatus[] = [
  "created",
  "running",
  "stopped",
  "failed",
  "tearing-down",
  "torndown",
];

export type RegisterValidation =
  | { readonly ok: true; readonly input: RegisterSessionInput }
  | { readonly ok: false; readonly error: string };

/**
 * A git branch / refname brood will pass to `git branch -D` / `git worktree`.
 * Conservative: must start alphanumeric, allow `[A-Za-z0-9._/-]`, and reject
 * `..` (path traversal in refnames). Rejects whitespace, control chars, and a
 * leading `-` (which would be parsed as a git flag).
 */
function isSafeBranch(branch: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) && !branch.includes("..");
}

/**
 * Validate and normalize a POST /sessions body. Only known fields are kept
 * (unexpected keys are dropped so the API never echoes data the store silently
 * discards). Paths/branches are validated because teardown acts on them
 * (`git` + a `.git`-guarded `rmSync`).
 */
export function validateRegister(
  body: Partial<RegisterSessionInput>,
): RegisterValidation {
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return { ok: false, error: "id is required." };
  const kind = body.kind;
  if (!kind || !SESSION_KINDS.includes(kind)) {
    return {
      ok: false,
      error: `kind must be one of: ${SESSION_KINDS.join(", ")}.`,
    };
  }
  if (body.status && !SESSION_STATUSES.includes(body.status)) {
    return { ok: false, error: `invalid status "${body.status}".` };
  }
  for (const field of ["repoPath", "worktreePath"] as const) {
    const value = body[field];
    if (value !== undefined && (typeof value !== "string" || !path.isAbsolute(value))) {
      return { ok: false, error: `${field} must be an absolute path.` };
    }
  }
  if (
    body.branch !== undefined &&
    (typeof body.branch !== "string" || !isSafeBranch(body.branch))
  ) {
    return { ok: false, error: `invalid branch "${String(body.branch)}".` };
  }

  // Allow-list: copy only known RegisterSessionInput fields.
  const input: RegisterSessionInput = { id, kind };
  if (body.status) input.status = body.status;
  if (body.parentId !== undefined) input.parentId = body.parentId;
  if (body.repoPath !== undefined) input.repoPath = body.repoPath;
  if (body.branch !== undefined) input.branch = body.branch;
  if (body.worktreePath !== undefined) input.worktreePath = body.worktreePath;
  if (body.containerId !== undefined) input.containerId = body.containerId;
  if (body.agentDeckSessionId !== undefined) {
    input.agentDeckSessionId = body.agentDeckSessionId;
  }
  if (body.profile !== undefined) input.profile = body.profile;
  if (body.group !== undefined) input.group = body.group;
  if (body.backend !== undefined) input.backend = body.backend;
  if (body.imageId !== undefined) input.imageId = body.imageId;
  if (body.exitCode !== undefined) input.exitCode = body.exitCode;
  if (body.failureReason !== undefined) input.failureReason = body.failureReason;
  return { ok: true, input };
}

/** Allowed mutable fields on PATCH /sessions/:id. */
const UPDATE_FIELDS: readonly (keyof UpdateSessionInput)[] = [
  "status",
  "containerId",
  "imageId",
  "exitCode",
  "failureReason",
  "agentDeckSessionId",
  "worktreePath",
  "branch",
  "profile",
  "group",
  "startedAt",
  "stoppedAt",
  "torndownAt",
];

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** First inbound W3C `traceparent` header value, if any (dedup array form). */
function inboundTraceparent(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const tp = headers["traceparent"];
  return Array.isArray(tp) ? tp[0] : tp;
}

export async function registerRoutes(
  app: FastifyInstance,
  opts: RoutesOptions,
): Promise<void> {
  const { store } = opts;
  const teardown =
    opts.teardown ??
    ((id, request, traceparent) =>
      teardownSession(store, id, request, { traceparent }));

  // Record every request keyed by route TEMPLATE (not the concrete path) to
  // keep metric cardinality bounded — the same rule spawn/hatchery metrics use.
  app.addHook("onResponse", async (request, reply) => {
    recordBroodRequest({
      route: request.routeOptions.url ?? "unknown",
      method: request.method,
      outcome: outcomeFromStatus(reply.statusCode),
      durationSeconds: reply.elapsedTime / 1000,
    });
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    const finder = isFinderAvailable();
    const docker = finder && isOnPath("docker");
    const git = finder && isOnPath("git");
    // Brood needs docker + git locally to reclaim artifacts; steward teardown is
    // delegated to Castra over HTTP (probed best-effort, not gating readiness).
    const castra = await createCastraClientFromEnv().reachable();
    const ready = docker && git;
    reply.code(ready ? 200 : 503);
    return { ready, docker, git, castra };
  });

  app.post("/sessions", async (request, reply) => {
    const validation = validateRegister(
      (request.body ?? {}) as Partial<RegisterSessionInput>,
    );
    if (!validation.ok) {
      reply.code(400);
      return { error: validation.error };
    }
    // Server-side register span — nests under the inbound traceparent the
    // BroodClient sends so the Hatchery's client-side `brood.register` and this
    // handler land in one trace (#233).
    const { input } = validation;
    const span = startBroodSpan({
      name: "brood.register",
      key: input.id,
      traceparent: inboundTraceparent(request.headers),
      attributes: {
        "march.session.id": input.id,
        "march.session.kind": input.kind,
        ...(input.kind === "spawn" ? { "march.spawn.id": input.id } : {}),
        ...(input.worktreePath
          ? { "march.worktree.path": input.worktreePath }
          : {}),
      },
    });
    try {
      const record = store.register(input);
      span.end();
      reply.code(201);
      return record;
    } catch (err) {
      span.end({ error: true });
      throw err;
    }
  });

  app.get("/sessions", async (request) => {
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const filter: ListSessionsFilter = {};
    const kind = asString(query.kind);
    if (kind && SESSION_KINDS.includes(kind as SessionKind)) {
      filter.kind = kind as SessionKind;
    }
    const status = asString(query.status);
    if (status && SESSION_STATUSES.includes(status as SessionStatus)) {
      filter.status = status as SessionStatus;
    }
    const parentId = asString(query.parentId);
    if (parentId) filter.parentId = parentId;
    return { sessions: store.list(filter) };
  });

  app.get("/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = store.get(id);
    if (!record) {
      reply.code(404);
      return { error: `No session with id "${id}".` };
    }
    return record;
  });

  app.patch("/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Partial<UpdateSessionInput>;
    if (body.status && !SESSION_STATUSES.includes(body.status)) {
      reply.code(400);
      return { error: `invalid status "${body.status}".` };
    }
    if (
      body.worktreePath !== undefined &&
      (typeof body.worktreePath !== "string" ||
        !path.isAbsolute(body.worktreePath))
    ) {
      reply.code(400);
      return { error: "worktreePath must be an absolute path." };
    }
    if (
      body.branch !== undefined &&
      (typeof body.branch !== "string" || !isSafeBranch(body.branch))
    ) {
      reply.code(400);
      return { error: `invalid branch "${String(body.branch)}".` };
    }
    // Whitelist: only known mutable fields reach the store.
    const changes: UpdateSessionInput = {};
    for (const field of UPDATE_FIELDS) {
      if (body[field] !== undefined) {
        (changes as Record<string, unknown>)[field] = body[field];
      }
    }
    const record = store.update(id, changes);
    if (!record) {
      reply.code(404);
      return { error: `No session with id "${id}".` };
    }
    return record;
  });

  app.post("/sessions/:id/teardown", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as TeardownRequest;
    const traceparent = inboundTraceparent(request.headers);
    try {
      return await teardown(
        id,
        {
          force: body.force === true,
          kill: body.kill === true,
          reason: asString(body.reason),
        },
        traceparent,
      );
    } catch (err) {
      if (err instanceof BroodNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      if (err instanceof BroodConflictError) {
        reply.code(409);
        return { error: err.message };
      }
      reply.code(500);
      return { error: (err as Error).message };
    }
  });
}
