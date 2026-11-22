import type { FastifyInstance } from "fastify";
import { isToolchainSelection, TOOLCHAIN_SELECTIONS } from "../../spawn/toolchain.js";
import { validateMergePolicy } from "./merge-policy.js";
import type { EventStore } from "../service/store.js";
import type { ProfileStore } from "./store.js";
import type { RegisterProfileInput } from "./types.js";

export interface ProfileRoutesOptions {
  readonly store: ProfileStore;
  /**
   * The event log (#593). When given, a `POST /profiles` that changes the merge
   * policy appends `profile.merge_policy.changed` so policy edits have history.
   */
  readonly events?: EventStore;
}

/** Order-independent serialization, so a key reorder is not a policy change. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** A policy as the event payload carries it: the object, or null when unset/empty. */
function policyPayload(policy: unknown): Record<string, unknown> | null {
  return policy && typeof policy === "object" && Object.keys(policy).length > 0
    ? (policy as Record<string, unknown>)
    : null;
}

/** The optional `attribution: {operator?, note?}` on a registration (#593). */
function readAttribution(raw: unknown): { operator?: string; note?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const { operator, note } = raw as Record<string, unknown>;
  const op = typeof operator === "string" ? operator.trim().slice(0, 128) : "";
  const nt = typeof note === "string" ? note.trim().slice(0, 1000) : "";
  return { ...(op ? { operator: op } : {}), ...(nt ? { note: nt } : {}) };
}

/** Profile name rule, matching `march legate init` (deriveDefaults/validateProfile). */
const PROFILE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const PROFILE_MAX_LEN = 64;

export type RegisterValidation =
  | { readonly ok: true; readonly input: RegisterProfileInput }
  | { readonly ok: false; readonly error: string };

function requireString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Validate a `POST /profiles` body. Required: profile, repoName/repoPath, workerGroup. */
export function validateRegisterProfile(
  body: Record<string, unknown>,
): RegisterValidation {
  const profile = requireString(body, "profile");
  if (!profile) return { ok: false, error: "profile is required." };
  if (profile.length > PROFILE_MAX_LEN || !PROFILE_PATTERN.test(profile)) {
    return {
      ok: false,
      error: `invalid profile "${profile}": expected ${PROFILE_PATTERN} (<=${PROFILE_MAX_LEN} chars).`,
    };
  }
  const repoName = requireString(body, "repoName");
  if (!repoName) return { ok: false, error: "repoName is required." };
  const repoPath = requireString(body, "repoPath");
  if (!repoPath) return { ok: false, error: "repoPath is required." };
  const workerGroup = requireString(body, "workerGroup");
  if (!workerGroup) return { ok: false, error: "workerGroup is required." };

  let mergePolicy: RegisterProfileInput["mergePolicy"];
  if (body.mergePolicy !== undefined && body.mergePolicy !== null) {
    const result = validateMergePolicy(body.mergePolicy);
    if (!result.ok) return { ok: false, error: result.error };
    mergePolicy = result.policy;
  }

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

  let priority: number | undefined;
  if (body.priority !== undefined && body.priority !== null) {
    if (typeof body.priority !== "number" || !Number.isInteger(body.priority) || body.priority < 0) {
      return {
        ok: false,
        error: `invalid priority "${String(body.priority)}": expected a non-negative integer (lower = higher priority).`,
      };
    }
    priority = body.priority;
  }

  const input: RegisterProfileInput = {
    profile,
    repoName,
    repoPath,
    workerGroup,
    conductorName: requireString(body, "conductorName") ?? undefined,
    broodEndpoint:
      typeof body.broodEndpoint === "string" ? body.broodEndpoint : undefined,
    marchCliPath:
      typeof body.marchCliPath === "string" ? body.marchCliPath : undefined,
    mode: requireString(body, "mode") ?? undefined,
    mergePolicy,
    toolchain,
    priority,
  };
  return { ok: true, input };
}

/**
 * Register the profile-registry routes. Herald is the source of truth for which
 * profiles exist; `march legate init` upserts here, and both Herald's observer
 * and the legate read it each tick. Kept as its own plugin so the future profile
 * service is a lift-and-shift.
 */
export async function registerProfileRoutes(
  app: FastifyInstance,
  opts: ProfileRoutesOptions,
): Promise<void> {
  const { store } = opts;

  // List profiles (active only by default; ?all=1 includes soft-removed).
  app.get("/profiles", async (request) => {
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const includeRemoved = query.all === "1" || query.all === "true";
    return { profiles: store.list({ includeRemoved }) };
  });

  app.get("/profiles/:profile", async (request, reply) => {
    const { profile } = request.params as { profile: string };
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const includeRemoved = query.all === "1" || query.all === "true";
    const record = store.get(profile, { includeRemoved });
    if (!record) {
      reply.code(404);
      return { error: `unknown profile "${profile}".` };
    }
    return record;
  });

  // Register/upsert a profile (the `march legate init` write path). A change to
  // the merge policy is recorded in the event log with who made it (#593).
  app.post("/profiles", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const validation = validateRegisterProfile(body);
    if (!validation.ok) {
      reply.code(400);
      return { error: validation.error };
    }
    const before = store.get(validation.input.profile, { includeRemoved: true })?.mergePolicy;
    // The policy register will store (mirrors `store.register`). History goes in
    // FIRST: the event log and the registry are separate databases, so this order
    // means a rejected append leaves the policy unchanged (a retry still sees the
    // difference and records it) instead of a silent change with no history.
    const after = validation.input.mergePolicy ?? before;
    if (opts.events && canonical(policyPayload(before)) !== canonical(policyPayload(after))) {
      opts.events.append(
        {
          type: "profile.merge_policy.changed",
          mergePolicy: policyPayload(after),
          previous: policyPayload(before),
          source: "herald",
          profile: validation.input.profile,
        },
        undefined,
        readAttribution(body.attribution),
      );
    }
    const record = store.register(validation.input);
    reply.code(201);
    return record;
  });

  // Soft-remove a profile (observer + legate stop iterating it next tick).
  app.delete("/profiles/:profile", async (request, reply) => {
    const { profile } = request.params as { profile: string };
    const record = store.remove(profile);
    if (!record) {
      reply.code(404);
      return { error: `unknown profile "${profile}".` };
    }
    return record;
  });
}
