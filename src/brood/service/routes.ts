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
import { parseExtractionResult } from "./extraction.js";
import { extractionReadiness } from "./extraction-readiness.js";
import {
  defaultOrphanGate,
  defaultStewardGateway,
  sweepLeakedStewards,
  type CastraStewardGateway,
  type OrphanGate,
} from "./steward-removal.js";
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
  /** Override the Castra gateway the sweep uses (tests). Defaults to env client. */
  readonly stewardGateway?: CastraStewardGateway;
  /** Override the orphan gate the sweep uses (tests). Defaults to `gh` + `fs`. */
  readonly orphanGate?: OrphanGate;
  /** Environment the admin gate reads its bearer token from (defaults to process.env). */
  readonly env?: NodeJS.ProcessEnv;
}

/** Env var gating the break-glass `POST /admin/sweep` endpoint (#304). */
export const BROOD_ADMIN_TOKEN_ENV = "MARCH_BROOD_ADMIN_TOKEN";

/** An error-outcome request to log (so the `outcome=error` metric is drillable). */
export interface RequestErrorLog {
  readonly level: "warn" | "error";
  readonly fields: Record<string, unknown>;
  readonly msg: string;
}

/**
 * Decide how to log a completed request. Returns null for a 2xx/3xx (no log —
 * the request log was previously all 200/201, so the `outcome=error` counter had
 * nothing to drill into). A 5xx is a SERVER error → `error`; a 4xx is
 * client/expected (e.g. a not-found probe) → `warn`, so the two can be filtered
 * apart in Loki. Pure so it is unit-tested without standing up Fastify/pino.
 */
export function classifyRequestLog(
  statusCode: number,
  route: string,
  method: string,
  elapsedMs: number,
  detail?: string,
): RequestErrorLog | null {
  if (statusCode < 400) return null;
  const fields: Record<string, unknown> = {
    route,
    method,
    status_code: statusCode,
    duration_ms: Math.round(elapsedMs),
  };
  if (detail) fields.detail = detail.slice(0, 500);
  return {
    level: statusCode >= 500 ? "error" : "warn",
    fields,
    msg: `brood request ${statusCode} ${method} ${route}`,
  };
}

/** Extract a `Bearer <token>` value from an Authorization header, or null. */
function bearerToken(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1].trim() : null;
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
  if (body.extractionResult !== undefined) {
    const parsed = parseExtractionResult(body.extractionResult);
    if (!parsed) return { ok: false, error: "invalid extractionResult." };
    input.extractionResult = parsed;
  }
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
  "extractionResult",
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
  const env = opts.env ?? process.env;
  const teardown =
    opts.teardown ??
    ((id, request, traceparent) =>
      teardownSession(store, id, request, { traceparent }));

  // Capture an error response body (the handlers' `{ error }`) so the log below
  // can include WHY, not just the status. Bounded + best-effort.
  app.addHook("onSend", async (request, _reply, payload) => {
    if (_reply.statusCode >= 400 && typeof payload === "string") {
      (request as { _broodErrorDetail?: string })._broodErrorDetail = payload;
    }
    return payload;
  });

  // Record every request keyed by route TEMPLATE (not the concrete path) to
  // keep metric cardinality bounded — the same rule spawn/hatchery metrics use —
  // AND log error-outcome requests so the `march_brood_requests_total{outcome=
  // "error"}` counter is drillable (5xx→error, 4xx→warn) instead of opaque.
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url ?? "unknown";
    recordBroodRequest({
      route,
      method: request.method,
      outcome: outcomeFromStatus(reply.statusCode),
      durationSeconds: reply.elapsedTime / 1000,
    });
    const entry = classifyRequestLog(
      reply.statusCode,
      route,
      request.method,
      reply.elapsedTime,
      (request as { _broodErrorDetail?: string })._broodErrorDetail,
    );
    if (entry) request.log[entry.level](entry.fields, entry.msg);
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

  app.get("/sessions/:id/extraction-readiness", async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = store.get(id);
    if (!record) {
      reply.code(404);
      return { error: `No session with id "${id}".` };
    }
    return extractionReadiness(record);
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
    let parsedExtraction: UpdateSessionInput["extractionResult"];
    if (body.extractionResult !== undefined) {
      parsedExtraction = parseExtractionResult(body.extractionResult);
      if (!parsedExtraction) {
        reply.code(400);
        return { error: "invalid extractionResult." };
      }
    }
    // Whitelist: only known mutable fields reach the store.
    const changes: UpdateSessionInput = {};
    for (const field of UPDATE_FIELDS) {
      if (body[field] !== undefined) {
        (changes as Record<string, unknown>)[field] = body[field];
      }
    }
    // Persist the validated/normalized extraction, not the raw request shape.
    if (parsedExtraction) changes.extractionResult = parsedExtraction;
    const record = store.update(id, changes);
    if (!record) {
      reply.code(404);
      return { error: `No session with id "${id}".` };
    }
    return record;
  });

  // Break-glass remedial cleanup (#304): reap leaked Castra stewards — true
  // orphans (no active Brood record) whose work is genuinely done (PR
  // merged/closed or worktree gone). Gated like Herald's admin endpoint so an
  // unguarded "remove sessions" surface is never exposed by default.
  //
  // The token (MARCH_BROOD_ADMIN_TOKEN) is read PER REQUEST so the gate tracks
  // the live env: UNSET → 404 (invisible by default — prod leaves it unset);
  // SET but the Bearer is missing/wrong → 401. Read at request time so a single
  // long-lived server can be armed and disarmed without a restart.
  app.post("/admin/sweep", async (request, reply) => {
    const expected = env[BROOD_ADMIN_TOKEN_ENV]?.trim();
    if (!expected) {
      reply.code(404);
      return { error: "not found" };
    }
    if (bearerToken(request.headers["authorization"]) !== expected) {
      reply.code(401);
      return { error: "invalid or missing admin bearer token." };
    }
    const gateway = opts.stewardGateway ?? defaultStewardGateway();
    const gate = opts.orphanGate ?? defaultOrphanGate();
    return sweepLeakedStewards(store, gateway, gate);
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
