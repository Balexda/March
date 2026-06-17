import { CASTRA_TOKEN_ENV } from "../../castra/config.js";
import { containerName } from "../../stack/services.js";
import type { DoctorContext } from "../context.js";
import type { CheckResult, Finding } from "../types.js";

/**
 * Token wiring — the five service containers must share one `CASTRA_API_TOKEN`,
 * and Castra must actually accept it.
 *
 * The classic silent incident: a stale/regenerated token leaves one container
 * disagreeing with the rest, so every cross-service call 401/404s while every
 * container stays green. We read the token from each container over the docker
 * socket, compare, and then confirm Castra authenticates the shared value
 * (`CastraView.reachable()` lists through the token-gated `/v1/*` surface).
 */

/** The token-bearing services (otel-lgtm does not use the shared token). */
const TOKEN_SERVICES = ["castra", "hatchery", "brood", "herald", "legate"] as const;

const RE_WIRE_REMEDY =
  "re-run `march up` to re-propagate the shared token (or align " +
  `${CASTRA_TOKEN_ENV} across the service containers)`;

export async function checkTokenWiring(ctx: DoctorContext): Promise<CheckResult> {
  const findings: Finding[] = [];

  // Read the token from each container. null = container absent / docker
  // unavailable / var unset — we separate "stack not running" from real drift.
  const present = new Map<string, string>();
  const missing: string[] = [];
  for (const svc of TOKEN_SERVICES) {
    const value = ctx.containerEnv(containerName(svc), CASTRA_TOKEN_ENV);
    if (value && value.length > 0) present.set(svc, value);
    else missing.push(svc);
  }

  if (present.size === 0) {
    // No container exposed the token: either the stack is down or docker is
    // unavailable. Not a drift failure — surface it as a warn so a doctor run
    // against a stopped stack doesn't read as a hard token fault.
    findings.push({
      check: "token-wiring",
      title: CASTRA_TOKEN_ENV,
      severity: "warn",
      detail:
        `could not read ${CASTRA_TOKEN_ENV} from any service container ` +
        "(stack not running or docker unavailable) — token wiring unverified",
      remedy: "start the stack with `march up`, then re-run `march doctor`",
    });
    return { check: "token-wiring", findings };
  }

  const distinct = new Set(present.values());
  const drifted = distinct.size > 1;
  if (drifted) {
    // Drift: at least two containers hold different tokens. Name the partition.
    const groups = new Map<string, string[]>();
    for (const [svc, token] of present) {
      const key = fingerprint(token);
      groups.set(key, [...(groups.get(key) ?? []), svc]);
    }
    const partition = [...groups.entries()]
      .map(([fp, svcs]) => `${svcs.join("+")}=${fp}`)
      .join(", ");
    findings.push({
      check: "token-wiring",
      title: CASTRA_TOKEN_ENV,
      severity: "fail",
      detail: `${CASTRA_TOKEN_ENV} drift across containers: ${partition}`,
      remedy: RE_WIRE_REMEDY,
    });
  } else if (missing.length > 0) {
    // Consistent where present, but some containers lack it entirely. Those
    // calls into Castra will 401 — a real fault, but distinct from drift.
    findings.push({
      check: "token-wiring",
      title: CASTRA_TOKEN_ENV,
      severity: "fail",
      detail: `${CASTRA_TOKEN_ENV} is unset on: ${missing.join(", ")}`,
      remedy: RE_WIRE_REMEDY,
    });
  }

  // Even a perfectly consistent token is worthless if Castra rejects it. Verify
  // the live auth surface — but only an explicit 401/403 is a token fault. A
  // 5xx / unreachable backend is Castra's problem (its own status check), and
  // reaching it tokenless would false-fail, so those resolve to "unverified".
  const auth = await probeCastraAuth(ctx);
  if (auth === "rejected") {
    findings.push({
      check: "token-wiring",
      title: "castra auth",
      severity: drifted || missing.length > 0 ? "warn" : "fail",
      detail: "Castra rejected the shared token (401/403) — auth wiring is broken",
      remedy: RE_WIRE_REMEDY,
    });
  }

  if (findings.length === 0) {
    findings.push({
      check: "token-wiring",
      title: CASTRA_TOKEN_ENV,
      severity: "pass",
      detail:
        auth === "accepted"
          ? `consistent across ${present.size} container(s) and accepted by Castra`
          : `consistent across ${present.size} container(s) (Castra auth not verifiable right now)`,
    });
  }

  return { check: "token-wiring", findings };
}

type AuthVerdict = "accepted" | "rejected" | "unverified";

/**
 * Confirm Castra authenticates the shared token by making a real authenticated
 * call. Prefer an in-scope profile (which exists, so a non-error means the
 * bearer was accepted); fall back to the readiness probe when no profile is in
 * scope. Only an explicit 401/403 is "rejected" — everything else is
 * "unverified" so a down/erroring backend never reads as a token fault.
 */
async function probeCastraAuth(ctx: DoctorContext): Promise<AuthVerdict> {
  const probeProfile = ctx.profiles[0]?.profile;
  if (probeProfile) {
    try {
      await ctx.castra.listSessions(probeProfile);
      return "accepted";
    } catch (err) {
      const status = (err as { status?: number }).status;
      return status === 401 || status === 403 ? "rejected" : "unverified";
    }
  }
  try {
    return (await ctx.castra.reachable()) ? "accepted" : "unverified";
  } catch {
    return "unverified";
  }
}

/** A short, non-secret fingerprint so drift is visible without leaking tokens. */
function fingerprint(token: string): string {
  let h = 0;
  for (let i = 0; i < token.length; i++) h = (h * 31 + token.charCodeAt(i)) | 0;
  return `#${(h >>> 0).toString(16).padStart(8, "0").slice(0, 6)}`;
}
