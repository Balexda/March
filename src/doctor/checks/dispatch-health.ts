import { containerName } from "../../stack/services.js";
import { resolveMaxConcurrentSpawns } from "../../legate/loop/meta.js";
import type { SliceState, SystemState } from "../../herald/events.js";
import type { DoctorContext } from "../context.js";
import type { CheckResult, Finding } from "../types.js";

/**
 * Dispatch health — is work actually flowing, or wedged behind a saturated cap?
 *
 * Three failure shapes the legate cannot self-announce:
 *  - **cap saturated + backlog**: live spawns have hit the global cap while
 *    dispatchable work waits — the classic ghost-stewards-pin-the-cap wedge.
 *  - **starved backlog**: dispatchable work exists but nothing is live — dispatch
 *    has stalled (e.g. a wedged fold).
 *  - **stranded stewards**: slices escalated / awaiting input, sitting idle.
 *
 * The cap is read from the legate container's `MARCH_MAX_CONCURRENT_SPAWNS`
 * (one global budget shared across profiles), falling back to the host env then
 * the built-in default — matching how the legate itself resolves it.
 */

/**
 * Live-spawn predicate, mirroring the legate's `liveSpawnCount`
 * (src/legate/loop/pure/slice.ts): a slice counts against the cap unless it is
 * terminal (merged/escalated, or PR merged/closed) or ready-to-merge.
 */
function isLiveSlice(slice: SliceState): boolean {
  const pr = slice.pr as
    | { state?: string; checks?: string; mergeable?: string; needs_response_count?: number }
    | undefined;
  // Terminal.
  if (slice.stage === "merged" || slice.stage === "escalated") return false;
  if (pr?.state === "MERGED" || pr?.state === "CLOSED") return false;
  // Ready-to-merge (an open PR that has passed AND owes no review response).
  // Mirror the canonical `isReadyToMerge` gate exactly: a steward that still
  // owes replies (or whose debt is unknown after a cold start) is NOT
  // ready-to-merge, so it stays counted as live — undercounting it here would
  // make a saturated cap read as healthy/under-capacity.
  const owed = (slice as { needs_response_count?: number }).needs_response_count ??
    pr?.needs_response_count;
  if (
    slice.stage === "pr-open" &&
    pr?.checks === "PASS" &&
    pr?.mergeable !== "CONFLICTING" &&
    owed === 0
  ) {
    return false;
  }
  return true;
}

function liveSlices(state: SystemState): number {
  return Object.values(state.slices).filter(isLiveSlice).length;
}

function resolveCap(ctx: DoctorContext): number {
  const fromContainer = ctx.containerEnv(containerName("legate"), "MARCH_MAX_CONCURRENT_SPAWNS");
  if (fromContainer) {
    return resolveMaxConcurrentSpawns({ MARCH_MAX_CONCURRENT_SPAWNS: fromContainer });
  }
  return resolveMaxConcurrentSpawns(ctx.env);
}

export async function checkDispatchHealth(ctx: DoctorContext): Promise<CheckResult> {
  const findings: Finding[] = [];
  const cap = resolveCap(ctx);

  let live = 0;
  let dispatchable = 0;
  const stranded: string[] = [];
  let probed = 0;

  for (const profile of ctx.profiles) {
    let state: SystemState;
    try {
      state = await ctx.herald.state(undefined, profile.profile);
    } catch (err) {
      findings.push({
        check: "dispatch-health",
        title: profile.profile,
        severity: "warn",
        detail: `could not read Herald fold: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    probed++;
    live += liveSlices(state);
    dispatchable += state.smithy.dispatchable;
    for (const slice of Object.values(state.slices)) {
      if (slice.archived || slice.recovered) continue;
      if (slice.escalatedReason) {
        stranded.push(`${profile.profile}/${slice.sliceId} (${slice.escalatedReason})`);
      } else if (slice.stewardReport?.status === "awaiting_input") {
        stranded.push(`${profile.profile}/${slice.sliceId} (awaiting input)`);
      }
    }
  }

  if (probed === 0) {
    findings.push({
      check: "dispatch-health",
      title: "dispatch",
      severity: findings.length > 0 ? "warn" : "pass",
      detail: "no profile folds available to assess dispatch",
    });
    return { check: "dispatch-health", findings };
  }

  // Cap vs backlog — the two wedge shapes.
  if (live >= cap && dispatchable > 0) {
    findings.push({
      check: "dispatch-health",
      title: "spawn cap",
      severity: "fail",
      detail: `cap saturated (${live}/${cap} live) while ${dispatchable} slice(s) are dispatchable`,
      remedy: "march brood sweep (reap ghost stewards pinning the cap), then march legate recover <sliceId> if still stuck",
    });
  } else if (live === 0 && dispatchable > 0) {
    findings.push({
      check: "dispatch-health",
      title: "dispatch",
      severity: "fail",
      detail: `${dispatchable} slice(s) dispatchable but nothing is live — dispatch appears stalled`,
      remedy: "march legate recover <sliceId>",
    });
  } else if (live >= cap) {
    findings.push({
      check: "dispatch-health",
      title: "spawn cap",
      severity: "warn",
      detail: `at capacity (${live}/${cap} live) with no dispatchable backlog — legitimately busy`,
    });
  } else {
    findings.push({
      check: "dispatch-health",
      title: "dispatch",
      severity: "pass",
      detail: `${live}/${cap} spawn(s) live, ${dispatchable} dispatchable`,
    });
  }

  if (stranded.length > 0) {
    findings.push({
      check: "dispatch-health",
      title: "stranded stewards",
      severity: "warn",
      detail: `${stranded.length} slice(s) escalated / awaiting input: ${stranded.slice(0, 5).join(", ")}${stranded.length > 5 ? ", …" : ""}`,
      remedy: "march legate recover <sliceId>",
    });
  }

  return { check: "dispatch-health", findings };
}
