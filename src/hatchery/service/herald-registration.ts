import { HeraldClient } from "../../herald/service/client.js";

/**
 * Publish the slice↔session↔spawn correlation to Herald at steward LAUNCH, the
 * push half of the durable stranded-steward fix (#213). Hatchery is the single
 * integration point that holds all three ids — it receives the `sliceId` in the
 * spawn request, creates the steward (`sessionId`), and owns the `spawnId` — so it
 * is the architecturally-correct owner of this correlation. It emits a
 * `slice.steward.attached` transition event so Herald's projection links the
 * slice to its session within a tick of launch, independent of the legate's
 * job-poll cadence; the gated PR-discovery (`senseObserved`) then runs and the
 * `[STRANDED-STEWARD-NUDGE]` loop no longer reproduces.
 *
 * Ownership rule: Hatchery owns the `sliceId↔sessionId↔spawnId` facts; the legate
 * owns slice lifecycle/stage. The Herald reducer merges `sessionId`/`spawnId`/
 * `branch`/`worktreePath` additively, so the two writers never fight.
 *
 * Mirrors {@link registerStewardLaunchWithBrood}'s posture exactly: best-effort
 * and gated on `MARCH_HERALD_URL` — when Herald is unconfigured or unreachable
 * this is a no-op (a warning, never a throw), because a missing observation
 * service must never fail a dispatch. It is also a no-op for ad-hoc spawns with
 * no `sliceId` (there is no slice to correlate, and Herald requires a non-empty
 * one).
 */
export interface StewardAttachedInput {
  /** Dispatch slice id (from the spawn request / `x-march-slice-id`). */
  readonly sliceId: string;
  readonly sessionId: string;
  readonly spawnId: string;
  readonly branch: string;
  readonly worktreePath: string;
}

export interface PublishStewardAttachedDeps {
  /** Override the client (tests). */
  readonly client?: HeraldClient;
  readonly env?: NodeJS.ProcessEnv;
  readonly warn?: (message: string) => void;
}

/** True when a Herald endpoint is configured (`MARCH_HERALD_URL`). */
function heraldConfigured(env: NodeJS.ProcessEnv): boolean {
  return (env.MARCH_HERALD_URL?.trim().length ?? 0) > 0;
}

export async function publishStewardAttachedToHerald(
  input: StewardAttachedInput,
  deps: PublishStewardAttachedDeps = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  // Nothing to correlate without a slice; Herald rejects an empty sliceId anyway.
  if (!input.sliceId) return;
  if (!deps.client && !heraldConfigured(env)) return;
  const client = deps.client ?? new HeraldClient({ env });
  const warn = deps.warn ?? ((message) => process.stderr.write(`${message}\n`));

  try {
    await client.append({
      type: "slice.steward.attached",
      sliceId: input.sliceId,
      sessionId: input.sessionId,
      spawnId: input.spawnId,
      branch: input.branch,
      worktreePath: input.worktreePath,
    });
  } catch (err) {
    warn(
      `herald steward-attached publish failed for spawn ${input.spawnId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
