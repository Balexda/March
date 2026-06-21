import { ERROR, SUCCESS, USAGE_ERROR } from "../shared/exit-codes.js";
import { defaultSessionClients, gatherSessions, type SessionClients } from "./gather.js";
import { joinSessions } from "./join.js";
import {
  filterSessions,
  formatJson,
  formatTable,
  SESSION_STATES,
  type SessionFilter,
} from "./format.js";
import type { SourceError } from "./types.js";

/** Options for one `march sessions` run (the parsed CLI flags). */
export interface RunSessionsOptions extends SessionFilter {
  readonly json?: boolean;
}

/** Result of a run: the text to print and the process exit code to set. */
export interface RunSessionsResult {
  readonly output: string;
  readonly exitCode: number;
}

/**
 * Gather → join → filter → render the unified session view. Pure orchestration
 * over the injectable {@link SessionClients} so it is fully testable without a
 * running stack; `program.ts` wires the env-configured HTTP clients and prints
 * the result.
 *
 * Exit code: `2` for a bad `--state`; `1` only when we are genuinely BLIND — every
 * service (Brood, Herald, Castra) failed to answer; otherwise `0`. A partial view
 * (one source down) is a success with the failures footnoted, and an idle-but-up
 * system (zero rows, no errors) is also `0` — the whole point is to surface
 * divergence even when a service is wedged, without crying failure on an empty
 * but healthy stack.
 */
export async function runSessions(
  options: RunSessionsOptions = {},
  clients: SessionClients = defaultSessionClients(),
  now: number = Date.now(),
): Promise<RunSessionsResult> {
  if (options.state && !SESSION_STATES.includes(options.state as never)) {
    return {
      output: `Invalid --state "${options.state}": expected one of ${SESSION_STATES.join(", ")}.`,
      exitCode: USAGE_ERROR,
    };
  }

  // Force the requested --profile into the Castra scan: a known live Castra
  // profile absent from the registry/fold/Brood would otherwise never be listed,
  // hiding the exact Castra-only leak the filter is asking about.
  const sources = await gatherSessions(
    clients,
    options.profile ? { extraProfiles: [options.profile] } : {},
  );
  const rows = filterSessions(joinSessions(sources, now), options);

  // Blind = none of the three services answered. Tied to per-source errors (NOT
  // "zero rows"), so a healthy idle stack still exits 0. Castra is "down" only
  // when it was scanned and every scan errored; an empty scan set means we never
  // had a profile to ask it about (Brood + Herald were the blind ones).
  const failed = (source: SourceError["source"]) =>
    sources.errors.some((e) => e.source === source);
  const broodBlind = failed("brood");
  const heraldBlind = failed("herald") || failed("profiles");
  const castraScans = sources.castraByProfile.size;
  const castraBlind = castraScans === 0 || sources.profiles.every((p) => !sources.castraByProfile.has(p));
  const blind = broodBlind && heraldBlind && castraBlind;

  const output = options.json
    ? formatJson({ sessions: rows, errors: sources.errors })
    : formatTable(rows, sources.errors);
  return { output, exitCode: blind ? ERROR : SUCCESS };
}
