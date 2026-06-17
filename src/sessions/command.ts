import { defaultSessionClients, gatherSessions, type SessionClients } from "./gather.js";
import { joinSessions } from "./join.js";
import {
  filterSessions,
  formatJson,
  formatTable,
  SESSION_STATES,
  type SessionFilter,
} from "./format.js";

/** Options for one `march sessions` run (the parsed CLI flags). */
export interface RunSessionsOptions extends SessionFilter {
  readonly json?: boolean;
}

/** Result of a run: the text to print and the process exit code to set. */
export interface RunSessionsResult {
  readonly output: string;
  readonly exitCode: number;
}

/** Exit codes mirror the rest of the CLI (`src/shared/exit-codes.ts`). */
const SUCCESS = 0;
const ERROR = 1;
const USAGE_ERROR = 2;

/**
 * Gather → join → filter → render the unified session view. Pure orchestration
 * over the injectable {@link SessionClients} so it is fully testable without a
 * running stack; `program.ts` wires the env-configured HTTP clients and prints
 * the result.
 *
 * Exit code: `2` for a bad `--state`; `1` when EVERY source failed (nothing to
 * show); otherwise `0` — a partial view (one source down) is a success with the
 * failures footnoted, since the whole point is to surface divergence even when a
 * service is wedged.
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

  const sources = await gatherSessions(clients);
  const rows = filterSessions(joinSessions(sources, now), options);

  // Every source failing means we are blind, not "all clear" — exit non-zero.
  const allFailed =
    sources.errors.length > 0 &&
    sources.brood.length === 0 &&
    sources.castraByProfile.size === 0 &&
    Object.keys(sources.fold.byProfile).length === 0;

  if (options.json) {
    return {
      output: formatJson({ sessions: rows, errors: sources.errors }),
      exitCode: allFailed ? ERROR : SUCCESS,
    };
  }

  return {
    output: formatTable(rows, sources.errors),
    exitCode: allFailed ? ERROR : SUCCESS,
  };
}
