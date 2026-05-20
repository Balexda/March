import type { FastifyInstance } from "fastify";
import { isFinderAvailable, isOnPath } from "../../shared/deps.js";
import {
  outcomeFromStatus,
  recordBroodRequest,
} from "../../observability/brood-metrics.js";
import { createCastraClientFromEnv } from "../../castra/client.js";
import type { SessionStore } from "./store.js";
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
  readonly store: SessionStore;
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

/** Validate and normalize a POST /sessions body. */
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
  return { ok: true, input: { ...body, id, kind } };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
    // Brood needs docker + git locally to reclaim artifacts; steward teardown is
    // delegated to Castra over HTTP (probed best-effort, not gating readiness).
    const castra = await createCastraClientFromEnv().reachable();
    const ready = docker;
    reply.code(ready ? 200 : 503);
    return { ready, docker, castra };
  });

  app.post("/sessions", async (request, reply) => {
    const validation = validateRegister(
      (request.body ?? {}) as Partial<RegisterSessionInput>,
    );
    if (!validation.ok) {
      reply.code(400);
      return { error: validation.error };
    }
    const record = store.register(validation.input);
    reply.code(201);
    return record;
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
    const changes = (request.body ?? {}) as UpdateSessionInput;
    if (changes.status && !SESSION_STATUSES.includes(changes.status)) {
      reply.code(400);
      return { error: `invalid status "${changes.status}".` };
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
    const tp = request.headers["traceparent"];
    const traceparent = Array.isArray(tp) ? tp[0] : tp;
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
