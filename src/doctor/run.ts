import type { DoctorContext } from "./context.js";
import type { CheckId, CheckResult, DoctorReport, Finding, SeverityCounts } from "./types.js";
import { checkTokenWiring } from "./checks/token-wiring.js";
import { checkSessionConsistency } from "./checks/session-consistency.js";
import { checkDispatchHealth } from "./checks/dispatch-health.js";
import { checkWorktreeHygiene } from "./checks/worktree-hygiene.js";
import { checkSyncHealth } from "./checks/sync-health.js";
import { checkTmuxOwnership } from "./checks/tmux-ownership.js";

/**
 * The consistency battery, in report order. Each check is independent and
 * read-only; a check that cannot reach a service emits a warn/fail finding
 * rather than throwing, so one degraded service never aborts the whole run.
 */
const CHECKS: ReadonlyArray<{
  readonly id: CheckId;
  readonly run: (ctx: DoctorContext) => Promise<CheckResult>;
}> = [
  { id: "token-wiring", run: checkTokenWiring },
  { id: "session-consistency", run: checkSessionConsistency },
  { id: "dispatch-health", run: checkDispatchHealth },
  { id: "worktree-hygiene", run: checkWorktreeHygiene },
  { id: "sync-health", run: checkSyncHealth },
  { id: "tmux-ownership", run: checkTmuxOwnership },
];

export interface RunDoctorOptions {
  /** Profile the run was scoped to (for the report header). */
  readonly profile?: string;
  /** Findings produced during setup (e.g. profile resolution) to prepend. */
  readonly setupFindings?: readonly Finding[];
}

/** Run the full battery against a wired context and aggregate the report. */
export async function runDoctor(
  ctx: DoctorContext,
  options: RunDoctorOptions = {},
): Promise<DoctorReport> {
  const results = await Promise.all(CHECKS.map((check) => runOne(ctx, check.id, check.run)));

  const setup = options.setupFindings ?? [];
  const checks: CheckResult[] = [];
  if (setup.length > 0) checks.push({ check: setup[0].check, findings: setup });
  checks.push(...results);

  const findings = checks.flatMap((c) => c.findings);
  const counts = tally(findings);
  return {
    profile: options.profile,
    checks,
    findings,
    counts,
    ok: counts.fail === 0,
  };
}

/** Run one check, converting an unexpected throw into a fail finding. */
async function runOne(
  ctx: DoctorContext,
  id: CheckId,
  run: (ctx: DoctorContext) => Promise<CheckResult>,
): Promise<CheckResult> {
  try {
    return await run(ctx);
  } catch (err) {
    // A check should handle its own service errors; reaching here means a bug or
    // an unexpected failure. Surface it as a fail rather than crashing the run.
    return {
      check: id,
      findings: [
        {
          check: id,
          title: "internal",
          severity: "fail",
          detail: `check threw: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}

function tally(findings: readonly Finding[]): SeverityCounts {
  let pass = 0;
  let warn = 0;
  let fail = 0;
  for (const f of findings) {
    if (f.severity === "pass") pass++;
    else if (f.severity === "warn") warn++;
    else fail++;
  }
  return { pass, warn, fail };
}
