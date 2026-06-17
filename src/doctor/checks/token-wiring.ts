import { CASTRA_TOKEN_ENV } from "../../castra/config.js";
import { containerName } from "../../stack/services.js";
import type { DoctorContext } from "../context.js";
import type { CheckResult, Finding } from "../types.js";

/**
 * Token wiring — the five service containers must share one `CASTRA_API_TOKEN`,
 * and Castra must actually accept it.
 *
 * The classic silent incident: a stale/regenerated token leaves one container
 * disagreeing with the rest, so every cross-service call 401/403s while every
 * container stays green. We read the token from each container over the docker
 * socket, compare, and then confirm Castra authenticates the *container* token
 * (not the host's, which may be stale) via a status-aware probe of the
 * token-gated `/v1/*` surface.
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

  // Even a perfectly consistent token is worthless if Castra rejects it. Probe
  // the live auth surface with the CONTAINER token (the value Castra actually
  // runs with) rather than the host's, which may be stale — otherwise a healthy
  // stack would false-fail on the operator's local env. Only an explicit
  // 401/403 is a token fault; a 5xx / unreachable backend resolves to
  // "unverified" (Castra's own liveness problem, not a wiring fault).
  const containerToken = present.get("castra") ?? [...distinct][0];
  const auth = await ctx.castraAuthProbe(containerToken);
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

/** A short, non-secret fingerprint so drift is visible without leaking tokens. */
function fingerprint(token: string): string {
  let h = 0;
  for (let i = 0; i < token.length; i++) h = (h * 31 + token.charCodeAt(i)) | 0;
  return `#${(h >>> 0).toString(16).padStart(8, "0").slice(0, 6)}`;
}
