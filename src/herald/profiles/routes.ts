import type { FastifyInstance } from "fastify";
import { validateMergePolicy } from "./merge-policy.js";
import type { ProfileStore } from "./store.js";
import type { RegisterProfileInput } from "./types.js";

export interface ProfileRoutesOptions {
  readonly store: ProfileStore;
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

  // Register/upsert a profile (the `march legate init` write path).
  app.post("/profiles", async (request, reply) => {
    const validation = validateRegisterProfile(
      (request.body ?? {}) as Record<string, unknown>,
    );
    if (!validation.ok) {
      reply.code(400);
      return { error: validation.error };
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
