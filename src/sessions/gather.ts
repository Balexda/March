import { BroodClient } from "../brood/service/client.js";
import { CastraClient, createCastraClientFromEnv } from "../castra/client.js";
import { HeraldClient } from "../herald/service/client.js";
import { ProfileClient } from "../herald/profiles/client.js";
import { emptyMultiProfileState, type MultiProfileState } from "../herald/events.js";
import type { CastraSession } from "../castra/types.js";
import type { SessionRecord } from "../brood/service/types.js";
import type { SourceError } from "./types.js";

/**
 * The raw cross-service snapshot {@link gatherSessions} collects. Every source is
 * best-effort: a source that fails contributes an empty slice and an entry in
 * {@link errors} rather than aborting the whole view, so an operator still sees
 * the sources that ARE up (the common case is exactly that one service is down).
 */
export interface SessionSources {
  /** ALL Brood records, every kind and status as returned by `GET /sessions`.
   *  The join layer is what filters to active spawn/steward records — keeping the
   *  raw list here lets a future consumer (e.g. `march doctor`) classify torndown
   *  and legate records differently without a second fetch. */
  readonly brood: readonly SessionRecord[];
  /** Live Castra sessions, keyed by the profile they were listed for. */
  readonly castraByProfile: ReadonlyMap<string, readonly CastraSession[]>;
  /** The full multi-profile Herald fold. */
  readonly fold: MultiProfileState;
  /** Every profile any source mentions (the union scanned for Castra sessions). */
  readonly profiles: readonly string[];
  readonly errors: readonly SourceError[];
}

/**
 * The minimal service surface {@link gatherSessions} depends on. Named so tests
 * inject fakes and so the gather layer is independent of the concrete HTTP
 * clients — the seam #398 (`march doctor`) reuses to share this divergence data.
 */
export interface SessionClients {
  readonly brood: Pick<BroodClient, "list">;
  readonly castra: Pick<CastraClient, "listSessions">;
  readonly herald: Pick<HeraldClient, "stateAll">;
  readonly profiles: Pick<ProfileClient, "list">;
}

/** Construct the default env-configured HTTP clients (Brood/Castra/Herald). */
export function defaultSessionClients(
  env: NodeJS.ProcessEnv = process.env,
): SessionClients {
  return {
    brood: new BroodClient({ env }),
    castra: createCastraClientFromEnv(env),
    herald: new HeraldClient({ env }),
    profiles: new ProfileClient({ env }),
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Collect the cross-service snapshot the unified view joins. Each source is
 * queried independently and its failure recorded — never thrown — so a partial
 * view degrades gracefully. The profile set scanned for Castra sessions is the
 * UNION of Herald's profile registry, every profile in the fold, and every
 * profile on a Brood record, so a session whose profile is missing from the
 * registry (the leak that strands work) is still listed.
 */
export async function gatherSessions(
  clients: SessionClients = defaultSessionClients(),
  options: { readonly extraProfiles?: readonly string[] } = {},
): Promise<SessionSources> {
  const errors: SourceError[] = [];

  // Brood: all kinds/statuses; the join filters to active spawn/steward records.
  let brood: SessionRecord[] = [];
  try {
    brood = await clients.brood.list();
  } catch (err) {
    errors.push({ source: "brood", message: message(err) });
  }

  // Herald fold (multi-profile) — the slice→state projection.
  let fold: MultiProfileState = emptyMultiProfileState();
  try {
    fold = await clients.herald.stateAll();
  } catch (err) {
    errors.push({ source: "herald", message: message(err) });
  }

  // Profile registry — the primary Castra-scan set.
  let registered: string[] = [];
  try {
    registered = (await clients.profiles.list()).map((p) => p.profile);
  } catch (err) {
    errors.push({ source: "profiles", message: message(err) });
  }

  // Union every profile any source mentions so an unregistered-but-live profile
  // (the divergence we are hunting) is still scanned. `extraProfiles` lets the
  // caller force a profile in — e.g. `--profile <p>` for a known Castra profile
  // absent from the registry and with no Brood/fold rows yet, which is exactly
  // the Castra-only leak the command exists to expose.
  const profileSet = new Set<string>(registered);
  for (const key of Object.keys(fold.byProfile)) profileSet.add(key);
  for (const rec of brood) if (rec.profile) profileSet.add(rec.profile);
  for (const p of options.extraProfiles ?? []) if (p) profileSet.add(p);
  const profiles = [...profileSet].filter((p) => p.length > 0).sort();

  // Castra: list per profile (the API requires one). A per-profile failure is
  // scoped so one unreachable profile cannot blank the others.
  const castraByProfile = new Map<string, readonly CastraSession[]>();
  for (const profile of profiles) {
    try {
      castraByProfile.set(profile, await clients.castra.listSessions(profile));
    } catch (err) {
      errors.push({ source: "castra", profile, message: message(err) });
    }
  }

  return { brood, castraByProfile, fold, profiles, errors };
}
